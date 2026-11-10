"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, Download, ImagePlus, Inbox, LoaderCircle, MoreHorizontal, RectangleHorizontal, RectangleVertical, RotateCcw, Settings2, ShieldCheck, Square, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Separator } from "@/components/ui/separator";
import ExternalTaskModelSettings from "@/components/ExternalTaskModelSettings";
import ExternalTaskInbox from "@/components/ExternalTaskInbox";
import ExternalTaskSource from "@/components/ExternalTaskSource";
import { externalTaskSource } from "@/lib/externalTaskSource";
import { EXTERNAL_TASK_STATUS, externalTaskCounts, isProcessedTask, taskDraft, useExternalTaskStore } from "@/lib/externalTaskStore";
import { selectedTaskParameter, taskParameterChoices, taskValidation } from "@/lib/externalTaskOptions";
import { dismissExternalTasks, reviewExternalTask } from "@/lib/externalTaskActions";
import { importTaskReference, type ExternalJob, type IntegrationOverview } from "@/lib/integrations";
import { cn } from "@/lib/utils";

function openConnectionSettings() {
  window.dispatchEvent(new Event("helios-open-integration-settings"));
}

function RatioIcon({ ratio }: { ratio: string }) {
  const [width, height] = ratio.split(":").map(Number);
  const Icon = width > height ? RectangleHorizontal : height > width ? RectangleVertical : Square;
  return <Icon aria-hidden="true" data-icon="inline-start" />;
}

function TaskParameter({ kind, allowed, current, disabled, onChange }: { kind: "ratio" | "quality"; allowed: string[]; current: string; disabled: boolean; onChange: (value: string) => void }) {
  const choices = taskParameterChoices(allowed, current, kind);
  const selected = selectedTaskParameter(allowed, current);
  const labelId = `external-task-${kind}-label`;
  const invalid = !!current && !allowed.includes(current);
  return <Field data-disabled={disabled} data-invalid={invalid}>
    <FieldLabel id={labelId}>{kind === "ratio" ? "图片比例" : "图片质量"}</FieldLabel>
    {choices.length < 2 ? <div className="flex min-h-8 items-center gap-2 rounded-lg border border-border px-3 text-sm text-muted-foreground" aria-labelledby={labelId}>
      {kind === "ratio" && <RatioIcon ratio={selected} />}{choices[0]?.label ?? "模型默认"}<span className="ml-auto text-xs">{choices.length ? "模型默认" : "未配置选项"}</span>
    </div> : choices.length <= 7 ? <ToggleGroup value={[selected]} onValueChange={(values) => { if (values.length) onChange(values[0]); }} variant="choice" disabled={disabled} className="w-full flex-wrap justify-start" aria-labelledby={labelId} aria-invalid={invalid}>
      {choices.map((choice) => <ToggleGroupItem key={choice.value} value={choice.value} disabled={choice.disabled} className="flex-1" aria-label={`${kind === "ratio" ? "比例" : "质量"} ${choice.label}`}>
        {kind === "ratio" && <RatioIcon ratio={choice.value} />}{choice.label}<Check aria-hidden="true" data-icon="inline-end" className={cn("size-3.5", selected !== choice.value && "invisible")} />
      </ToggleGroupItem>)}
    </ToggleGroup> : <Select items={choices} value={selected} onValueChange={(value) => { if (value !== null) onChange(value); }} disabled={disabled}>
      <SelectTrigger aria-labelledby={labelId} aria-invalid={invalid} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start"><SelectGroup>{choices.map((choice) => <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>}
  </Field>;
}

function ExternalTaskEditor({ job, overview }: { job: ExternalJob; overview: IntegrationOverview }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const savedDraft = useExternalTaskStore((state) => state.drafts[job.jobId]);
  const busyJobId = useExternalTaskStore((state) => state.busyJobId);
  const error = useExternalTaskStore((state) => state.errors[job.jobId]);
  const editable = job.status === "awaiting_approval";
  const draft = editable ? savedDraft ?? taskDraft(job) : taskDraft(job);
  const model = overview.models.find((entry) => entry.id === draft.modelId);
  const busy = busyJobId !== null || editingModel !== null;
  const maximumReferences = Math.min(14, model?.maxImages ?? 0);
  const invalidPrompt = editable && (!draft.prompt.trim() || draft.prompt.length > (model?.promptMaxLength ?? 32000));
  const invalidModel = editable && !model;
  const validation = taskValidation(draft, model);
  const closeModelSettings = useCallback(() => setEditingModel(null), []);
  const modelSettingsError = useCallback((message: string) => useExternalTaskStore.getState().setError(job.jobId, message), [job.jobId]);
  const unconfigured = model && (!model.ratios.some((ratio) => ratio !== "auto") || !model.qualityOptions.length || maximumReferences === 0);

  function update(fields: Partial<typeof draft>) {
    useExternalTaskStore.getState().setDraft(job.jobId, { ...draft, ...fields });
  }

  async function review(action: "approve" | "reject") {
    if (!editingModel) await reviewExternalTask(job, action, draft);
  }

  async function addReferences(files: FileList | null) {
    if (!files?.length || busy || !editable) return;
    const store = useExternalTaskStore.getState();
    if (draft.referenceIds.length + files.length > maximumReferences) {
      store.setError(job.jobId, `此模型最多支持 ${maximumReferences} 张参考图`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    store.setBusyJob(job.jobId);
    store.setError(job.jobId, "");
    let next = draft;
    try {
      for (const file of Array.from(files)) {
        const asset = await importTaskReference(job.jobId, file);
        next = { ...next, referenceIds: [...next.referenceIds, asset.assetId], referenceUrls: [...next.referenceUrls, asset.url] };
        store.setDraft(job.jobId, next);
      }
    } catch (failure) { store.setError(job.jobId, failure instanceof Error ? failure.message : "导入参考图失败"); }
    finally { store.setBusyJob(null); if (fileInput.current) fileInput.current.value = ""; }
  }

  const modelChoices = overview.models.map((entry) => ({ value: entry.id, label: `${entry.providerName} · ${entry.name}` }));
  if (!model && draft.modelId) modelChoices.push({ value: draft.modelId, label: "当前模型已不可用" });
  return <section className="flex min-h-0 flex-1 flex-col" aria-label="外部任务配置">
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 [scrollbar-gutter:stable]" data-task-scroll>
      <FieldGroup className="gap-5">
        <Field data-invalid={invalidPrompt}>
          <FieldLabel htmlFor="external-task-prompt">提示词</FieldLabel>
          <Textarea id="external-task-prompt" value={draft.prompt} aria-invalid={invalidPrompt} readOnly={!editable} disabled={busy} maxLength={model?.promptMaxLength ?? 32000} onChange={(event) => update({ prompt: event.target.value })} className="min-h-28 resize-none" />
        </Field>
        <FieldSet className="gap-4">
          <div className="flex items-center justify-between gap-2">
            <FieldLegend variant="label" className="mb-0">生成配置</FieldLegend>
            {editable && <Button variant="ghost" size="sm" disabled={busy || !model} onClick={() => setEditingModel(draft.modelId)}><Settings2 data-icon="inline-start" />模型参数</Button>}
          </div>
          <Field data-disabled={!editable || busy} data-invalid={invalidModel}>
            <FieldLabel htmlFor="external-task-model">图片模型</FieldLabel>
            <Select items={modelChoices} value={draft.modelId || null} onValueChange={(value) => {
              const next = overview.models.find((entry) => entry.id === value);
              if (next) update({ modelId: next.id, aspectRatio: next.ratios.includes(draft.aspectRatio) ? draft.aspectRatio : "", quality: next.qualityOptions.includes(draft.quality) ? draft.quality : "" });
            }} disabled={!editable || busy}>
              <SelectTrigger id="external-task-model" aria-invalid={invalidModel} className="w-full"><SelectValue placeholder="选择图片模型" /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false} align="start"><SelectGroup>{modelChoices.map((choice) => <SelectItem key={choice.value} value={choice.value} disabled={!overview.models.some((entry) => entry.id === choice.value)}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <TaskParameter kind="ratio" allowed={model?.ratios ?? []} current={draft.aspectRatio} disabled={!editable || busy} onChange={(value) => update({ aspectRatio: value })} />
          <TaskParameter kind="quality" allowed={model?.qualityOptions ?? []} current={draft.quality} disabled={!editable || busy} onChange={(value) => update({ quality: value })} />
          {editable && unconfigured && <FieldDescription>选项不足？在“模型参数”中配置服务商实际支持的比例、质量和参考图。</FieldDescription>}
        </FieldSet>
        <Separator />
        <Field>
          <div className="flex items-center justify-between gap-2"><FieldLabel>参考图</FieldLabel><span className="text-xs text-muted-foreground">{maximumReferences ? `${draft.referenceIds.length} / ${maximumReferences}` : "未启用"}</span></div>
          {!!draft.referenceIds.length && <div className="flex flex-wrap gap-2">{draft.referenceIds.map((assetId, index) => <div key={`${assetId}-${index}`} className="relative flex size-20 items-center justify-center rounded-lg border border-border bg-muted/30">
            {draft.referenceUrls[index]?.startsWith("/generated/") && <Image src={draft.referenceUrls[index]} alt={`参考图 ${index + 1}`} width={80} height={80} unoptimized className="size-full rounded-lg object-contain" />}
            {editable && <Button variant="secondary" size="icon-xs" disabled={busy} className="absolute right-1 top-1" aria-label={`移除参考图 ${index + 1}`} onClick={() => update({ referenceIds: draft.referenceIds.filter((_, entryIndex) => entryIndex !== index), referenceUrls: draft.referenceUrls.filter((_, entryIndex) => entryIndex !== index) })}><X /></Button>}
          </div>)}</div>}
          {editable && maximumReferences > 0 && <>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple className="hidden" aria-label="选择外部任务参考图" onChange={(event) => void addReferences(event.target.files)} />
            <Button variant="outline" disabled={busy || draft.referenceIds.length >= maximumReferences || !overview.enabled} className="w-full border-dashed" onClick={() => fileInput.current?.click()}><ImagePlus data-icon="inline-start" />添加参考图</Button>
          </>}
          <FieldDescription>{maximumReferences ? "PNG、JPEG、GIF、WebP · 单张不超过 50 MiB" : "此模型未配置参考图能力，可在模型参数中启用。"}</FieldDescription>
        </Field>
        {!!job.outputs?.length && <FieldSet className="gap-3"><FieldLegend variant="label">生成结果</FieldLegend>{job.outputs.filter((entry) => entry.url.startsWith("/generated/")).map((entry) => <div key={entry.assetId} className="flex flex-col gap-2"><Image src={entry.url} alt={job.prompt} width={768} height={768} unoptimized className="max-h-64 w-full rounded-lg border border-border object-contain" /><Button variant="outline" render={<a href={entry.url} download />}><Download data-icon="inline-start" />下载原图 {entry.index + 1}</Button></div>)}<Button variant="ghost" onClick={() => router.push("/gallery?tab=images")}>在图库查看</Button></FieldSet>}
        <details className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-xs text-muted-foreground"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />任务来源与原始请求{job.configurationEdited && <Badge variant="outline" className="ml-auto">已调整</Badge>}</summary>
          <div className="flex flex-col gap-3 border-t border-border p-3 text-xs text-muted-foreground">
            <p>{new Date(job.createdAt).toLocaleString()}</p>
            <p>{externalTaskSource(job, overview.clients).description}授权与自动批准策略以连接凭据为准。</p>
            {job.source.rexSessionId && <p className="break-all">Rex 会话：{job.source.rexSessionId}{job.source.rexBlockId ? ` · 区块：${job.source.rexBlockId}` : ""}</p>}
            {job.originalRequest && <><p className="whitespace-pre-wrap break-words text-foreground">{job.originalRequest.prompt}</p><p className="break-all">模型：{overview.models.find((entry) => entry.id === job.originalRequest?.modelId)?.name ?? job.originalRequest.modelId ?? "默认"} · 比例：{job.originalRequest.aspectRatio || "默认"} · 质量：{job.originalRequest.quality || "默认"} · 参考图：{job.originalRequest.referenceIds?.length ?? 0}</p></>}
          </div>
        </details>
        {editable && validation && <Field data-invalid><FieldError>{validation}</FieldError></Field>}
        {(error || job.error) && <Field data-invalid><FieldError role="alert">{error || job.error}</FieldError></Field>}
      </FieldGroup>
    </div>
    <Separator />
    <footer className="flex shrink-0 flex-col gap-2 bg-background p-3" data-task-footer>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" />{editable ? "确认后才调用服务商，可能产生费用" : "参数已锁定，收起面板不会取消任务"}</p>
      {editable && <div className="flex items-center gap-1.5">
        <Button size="lg" disabled={busy || !overview.enabled || !!validation} className="min-w-0 flex-1" onClick={() => void review("approve")}>
          {busyJobId === job.jobId ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{busyJobId === job.jobId ? "处理中…" : "确认生成"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => useExternalTaskStore.getState().returnToInbox()}>返回列表</Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多任务操作" />}><MoreHorizontal /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top"><DropdownMenuGroup>
            <DropdownMenuItem disabled={busy || !savedDraft} onClick={() => useExternalTaskStore.getState().clearDraft(job.jobId)}><RotateCcw />撤销修改</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" disabled={busy} onClick={() => void review("reject")}><X />拒绝任务</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      </div>}
      {!editable && isProcessedTask(job) && <Button variant="outline" disabled={busy || job.inboxDismissed} onClick={() => void dismissExternalTasks(job)}><Trash2 data-icon="inline-start" />{job.inboxDismissed ? "消息已移除" : "移除这条消息"}</Button>}
    </footer>
    {editingModel && <ExternalTaskModelSettings modelId={editingModel} onClose={closeModelSettings} onError={modelSettingsError} />}
  </section>;
}

export default function ExternalTaskDock() {
  const overview = useExternalTaskStore((state) => state.overview);
  const open = useExternalTaskStore((state) => state.open);
  const view = useExternalTaskStore((state) => state.view);
  const tab = useExternalTaskStore((state) => state.inboxTab);
  const inspectedJob = useExternalTaskStore((state) => state.inspectedJob);
  const busyJobId = useExternalTaskStore((state) => state.busyJobId);
  const selectedJobId = useExternalTaskStore((state) => state.selectedJobId);
  const connectionError = useExternalTaskStore((state) => state.connectionError);
  const jobs = overview?.jobs ?? [];
  const { pending, processed, active } = externalTaskCounts(jobs);
  const selected = jobs.find((job) => job.jobId === selectedJobId) ?? inspectedJob;
  return <aside className={cn("mt-2 flex min-h-0 shrink-0 flex-col border-l border-border bg-background text-foreground", !open && "bg-sidebar")} style={{ width: "var(--helios-task-dock-width)" }} aria-label="外部任务面板" data-external-task-dock data-open={open}>
    <span className="sr-only" role="status">{pending ? `${pending} 项外部图片任务等待确认` : "暂无待确认的外部图片任务"}</span>
    {open ? <>
      <header className="flex shrink-0 flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          {view === "detail" ? <Button variant="ghost" size="icon-sm" aria-label="返回消息列表" onClick={() => useExternalTaskStore.getState().returnToInbox()}><ArrowLeft /></Button> : <Inbox className="size-4 text-muted-foreground" />}<h2 className="text-sm font-semibold">{view === "detail" ? "任务详情" : "消息中心"}</h2>{pending > 0 && <Badge variant="secondary">{pending}</Badge>}
          <div className="ml-auto flex gap-1"><Button variant="ghost" size="icon-sm" aria-label="外部连接设置" onClick={openConnectionSettings}><Settings2 /></Button><Button variant="ghost" size="icon-sm" aria-label="收起外部任务面板" onClick={() => useExternalTaskStore.getState().closePanel()}><ChevronRight /></Button></div>
        </div>
        {view === "inbox" && <ToggleGroup variant="choice" value={[tab]} className="w-full" onValueChange={(values) => { if (values[0] === "active" || values[0] === "processed") useExternalTaskStore.getState().setInboxTab(values[0]); }} aria-label="消息分类"><ToggleGroupItem value="active" className="flex-1">待处理 {active}</ToggleGroupItem><ToggleGroupItem value="processed" className="flex-1">已处理 {processed}</ToggleGroupItem></ToggleGroup>}
        {view === "detail" && selected && <div className="flex items-start gap-2 text-xs text-muted-foreground"><ExternalTaskSource job={selected} clients={overview?.clients ?? []} /><Badge variant="outline">{["launching", "pending", "approved"].includes(selected.status) && <LoaderCircle className="animate-spin" />}{EXTERNAL_TASK_STATUS[selected.status]}</Badge></div>}
        {connectionError && <Field data-invalid><FieldError role="alert">{connectionError}</FieldError></Field>}
      </header>
      <Separator />
      {view === "detail" && selected && overview ? <ExternalTaskEditor key={selected.jobId} job={selected} overview={overview} /> : overview?.enabled || jobs.length ? <>
        {overview && <ExternalTaskInbox overview={overview} />}
        <Separator />
        <footer className="flex shrink-0 flex-col gap-2 p-3" data-task-footer><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" />{tab === "active" ? "列表允许会使用当前参数，可能产生费用" : "移除消息不会删除任务记录和生成图片"}</p><Button variant="ghost" size="sm" disabled={busyJobId !== null || !processed} onClick={() => void dismissExternalTasks()}><Trash2 data-icon="inline-start" />清理已处理消息{processed ? ` (${processed})` : ""}</Button></footer>
      </> : <Empty className="border-0"><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>等待外部任务</EmptyTitle><EmptyDescription>开启本机连接后，Agent 就能提交图片任务。</EmptyDescription></EmptyHeader><EmptyContent><Button variant="outline" onClick={openConnectionSettings}>配置外部连接</Button></EmptyContent></Empty>}
    </> : <div className="flex flex-col items-center gap-2 px-1 py-3"><Button variant={pending ? "secondary" : "ghost"} size="icon" aria-label={`打开外部任务面板${pending ? `，${pending} 项等待确认` : ""}`} title="外部任务" onClick={() => useExternalTaskStore.getState().openPanel()}><Inbox /></Button>{pending > 0 && <Badge variant="secondary">{pending}</Badge>}</div>}
  </aside>;
}
