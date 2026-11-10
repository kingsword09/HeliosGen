"use client";

import { Ban, Check, CheckCircle2, ChevronRight, Inbox, LoaderCircle, MessageSquare, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldError } from "@/components/ui/field";
import { EXTERNAL_TASK_STATUS, isProcessedTask, taskDraft, useExternalTaskStore } from "@/lib/externalTaskStore";
import { dismissExternalTasks, reviewExternalTask } from "@/lib/externalTaskActions";
import { taskValidation } from "@/lib/externalTaskOptions";
import ExternalTaskSource from "@/components/ExternalTaskSource";
import { externalTaskSource } from "@/lib/externalTaskSource";
import type { ExternalJob, IntegrationOverview } from "@/lib/integrations";

function TaskMessage({ job, overview }: { job: ExternalJob; overview: IntegrationOverview }) {
  const busyJobId = useExternalTaskStore((state) => state.busyJobId);
  const draft = useExternalTaskStore((state) => state.drafts[job.jobId]);
  const error = useExternalTaskStore((state) => state.errors[job.jobId]);
  const parameters = draft ?? taskDraft(job);
  const model = overview.models.find((entry) => entry.id === parameters.modelId);
  const waiting = job.status === "awaiting_approval";
  const processed = isProcessedTask(job);
  const { connectionName, sourceName } = externalTaskSource(job, overview.clients);
  const Icon = job.status === "done" ? CheckCircle2 : job.status === "rejected" ? Ban : job.status === "error" ? TriangleAlert : waiting ? MessageSquare : LoaderCircle;
  const date = new Date(job.createdAt);
  const busy = busyJobId !== null;
  return <li className="border-b border-border last:border-b-0" data-task-message={job.jobId}>
    <article className="grid grid-cols-[1.75rem_minmax(0,1fr)_1.75rem] gap-2 p-3" aria-label={`连接：${connectionName} · 来源：${sourceName} · ${EXTERNAL_TASK_STATUS[job.status]}`}>
      <div className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className={processed || waiting ? "size-4" : "size-4 animate-spin"} aria-hidden="true" /></div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-start justify-between gap-2"><ExternalTaskSource job={job} clients={overview.clients} /><time className="shrink-0 text-[0.65rem] text-muted-foreground" dateTime={job.createdAt} title={date.toLocaleString()}>{date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time></div>
        <button className="min-w-0 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`查看详情：${job.prompt}`} onClick={() => useExternalTaskStore.getState().selectJob(job.jobId)}><p className="line-clamp-2 break-words text-sm leading-relaxed">{parameters.prompt}</p></button>
        <p className="truncate text-xs text-muted-foreground">{model?.name ?? "模型不可用"}{parameters.aspectRatio ? ` · ${parameters.aspectRatio}` : ""}{parameters.quality ? ` · ${parameters.quality}` : ""}{parameters.referenceIds.length ? ` · ${parameters.referenceIds.length} 张参考图` : ""}</p>
        <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline">{EXTERNAL_TASK_STATUS[job.status]}</Badge>{draft && <Badge variant="secondary">有草稿</Badge>}</div>
        {(error || job.status === "error" && job.error) && <Field data-invalid><FieldError>{error || job.error}</FieldError></Field>}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <Button variant="ghost" size="icon-sm" aria-label={`查看任务详情 ${job.requestId}`} title="查看详情与参数" onClick={() => useExternalTaskStore.getState().selectJob(job.jobId)}><ChevronRight /></Button>
        {waiting && <>
          <Button size="icon-sm" disabled={busy || !overview.enabled || !!taskValidation(parameters, model)} aria-label={`允许生成 ${job.requestId}`} title={taskValidation(parameters, model) || (draft ? "使用已编辑的草稿确认生成，可能产生费用" : "确认生成，可能产生费用")} onClick={() => void reviewExternalTask(job, "approve")}>
            {busyJobId === job.jobId ? <LoaderCircle className="animate-spin" /> : <Check />}
          </Button>
          <Button variant="destructive" size="icon-sm" disabled={busy} aria-label={`拒绝任务 ${job.requestId}`} title="拒绝任务" onClick={() => void reviewExternalTask(job, "reject")}><X /></Button>
        </>}
        {processed && <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`移除消息 ${job.requestId}`} title="从消息列表移除，不删除任务或图片" onClick={() => void dismissExternalTasks(job)}><X /></Button>}
      </div>
    </article>
  </li>;
}

export default function ExternalTaskInbox({ overview }: { overview: IntegrationOverview }) {
  const tab = useExternalTaskStore((state) => state.inboxTab);
  const jobs = overview.jobs.filter((job) => isProcessedTask(job) === (tab === "processed"));
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" data-task-scroll>
    {jobs.length ? <ul aria-label={tab === "active" ? "待处理与生成中的消息" : "已处理消息"} className="flex flex-col">{jobs.map((job) => <TaskMessage key={job.jobId} job={job} overview={overview} />)}</ul> : <Empty className="min-h-56 border-0"><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{tab === "active" ? "暂无待处理消息" : "没有已处理消息"}</EmptyTitle><EmptyDescription>{tab === "active" ? "新的生成请求会显示在这里。已完成、失败和拒绝的任务可在“已处理”中查看。" : "处理结果会显示在这里，可逐条移除或统一清理。任务记录和图片不会删除。"}</EmptyDescription></EmptyHeader></Empty>}
  </div>;
}
