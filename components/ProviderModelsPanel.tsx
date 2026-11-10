"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Check, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ProviderConfig } from "@/lib/providerConfig";
import { newProviderModel, validateProviderModels, type DiscoveredModel, type OnlineModel, type OnlineModelCatalog, type ProviderModel, type ProviderModelConnection, type ProviderModelKind } from "@/lib/providerModelConfig";
import { hasModelParameters, MODEL_PROTOCOL_LABELS, providerModelProtocol } from "@/lib/providerConnection";
import ModelConnectionEditor from "@/components/ModelConnectionEditor";
import { MODEL_PARAMETER_FIELDS, MODEL_PARAMETER_PRESETS, modelParameterPreset, resolveModelParameters } from "@/lib/modelParameterPresets";

const KIND_LABELS = { image: "图片", text: "对话", video: "视频" };
const HANDLE_LABELS = [{ id: "startFrame", label: "首帧图片" }, { id: "endFrame", label: "尾帧图片" }, { id: "videoRef", label: "视频延续" }, { id: "referenceVideo", label: "参考视频" }, { id: "audioRef", label: "参考音频" }] as const;
const split = (value: string) => value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);

function CapabilityToggle({ label, checked, onChange, children }: { label: string; checked: boolean; onChange: (checked: boolean) => void; children?: React.ReactNode }) {
  const id = useId();
  return <FieldGroup className="gap-2"><Field orientation="horizontal"><FieldLabel id={`${id}-label`} htmlFor={id}>{label}</FieldLabel><Switch id={id} aria-labelledby={`${id}-label`} checked={checked} onCheckedChange={onChange} /></Field>{checked && children}</FieldGroup>;
}

export function ModelEditor({ initial, config, onApply, onCancel, onDirtyChange }: { initial: ProviderModel; config: ProviderConfig; onApply: (model: ProviderModel) => Promise<void>; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const id = useId();
  const [startingModel] = useState(() => resolveModelParameters(initial, providerModelProtocol(config, initial)));
  const [model, setModel] = useState(startingModel);
  const [ratios, setRatios] = useState(startingModel.ratios.some((ratio) => ratio !== "auto") ? startingModel.ratios.join(", ") : "");
  const [sizes, setSizes] = useState(Object.entries(startingModel.sizeMap).map(([ratio, size]) => `${ratio}=${size}`).join(", "));
  const [qualities, setQualities] = useState(startingModel.qualityOptions.join(", "));
  const [durations, setDurations] = useState(startingModel.durations.join(", "));
  const [resolutions, setResolutions] = useState(startingModel.resolutions.join(", "));
  const [ratioEnabled, setRatioEnabled] = useState(startingModel.ratios.some((ratio) => ratio !== "auto"));
  const [qualityEnabled, setQualityEnabled] = useState(startingModel.qualityOptions.length > 0);
  const [durationEnabled, setDurationEnabled] = useState(startingModel.durations.length > 0);
  const [resolutionEnabled, setResolutionEnabled] = useState(startingModel.resolutions.length > 0);
  const [custom, setCustom] = useState(JSON.stringify({ parameterKeys: startingModel.parameterKeys, extraBody: startingModel.extraBody }, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [original] = useState({ model: JSON.stringify(startingModel), ratios, sizes, qualities, durations, resolutions, ratioEnabled, qualityEnabled, durationEnabled, resolutionEnabled, custom });
  const dirty = !!connectionError || (!config.models.some((entry) => entry.id === initial.id) && !!initial.apiId) || JSON.stringify(model) !== original.model || ratios !== original.ratios || sizes !== original.sizes || qualities !== original.qualities || durations !== original.durations || resolutions !== original.resolutions || ratioEnabled !== original.ratioEnabled || qualityEnabled !== original.qualityEnabled || durationEnabled !== original.durationEnabled || resolutionEnabled !== original.resolutionEnabled || custom !== original.custom;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const protocol = providerModelProtocol(config, model);
  const preset = modelParameterPreset(model, protocol);
  const sizeAlternative = MODEL_PARAMETER_PRESETS.find((entry) => entry.id === preset?.sizeAlternative);
  const staleParameters = !!model.parameterProtocol && model.parameterProtocol !== protocol && hasModelParameters(model);
  const usesSizes = model.kind === "image" && protocol === "openai" && (!model.parameterKeys.aspectRatio || model.parameterKeys.aspectRatio === "size");
  function replaceParameters(next: ProviderModel) {
    setModel(next);
    setRatios(next.ratios.some((ratio) => ratio !== "auto") ? next.ratios.join(", ") : "");
    setSizes(Object.entries(next.sizeMap).map(([ratio, size]) => `${ratio}=${size}`).join(", "));
    setQualities(next.qualityOptions.join(", ")); setDurations(next.durations.join(", ")); setResolutions(next.resolutions.join(", "));
    setRatioEnabled(next.ratios.some((ratio) => ratio !== "auto")); setQualityEnabled(next.qualityOptions.length > 0); setDurationEnabled(next.durations.length > 0); setResolutionEnabled(next.resolutions.length > 0);
    setCustom(JSON.stringify({ parameterKeys: next.parameterKeys, extraBody: next.extraBody }, null, 2)); setError(null);
  }
  function resetParameters(connection: ProviderModelConnection | undefined) {
    const next = { ...newProviderModel(model.kind, model.apiId, model.name), id: model.id, enabled: model.enabled, connection, parameterPreset: "auto" };
    replaceParameters(resolveModelParameters(next, providerModelProtocol(config, next)));
    setConnectionError("");
  }
  function changeApiId(apiId: string) {
    const next = { ...model, apiId, name: model.name === model.apiId ? apiId : model.name };
    if (model.parameterPreset === "auto") replaceParameters(resolveModelParameters(next, protocol));
    else setModel(next);
  }
  function changeProtocol(selected: ProviderModelConnection["protocol"]) {
    const nextConnection = { ...model.connection, protocol: selected };
    const nextProtocol = providerModelProtocol(config, { ...model, connection: nextConnection });
    if (nextProtocol !== protocol) {
      if ((hasModelParameters(model) || Object.keys(model.connection ?? {}).length > 1 || connectionError || ratioEnabled || qualityEnabled || durationEnabled || resolutionEnabled || custom !== original.custom) && !window.confirm("更换接口将重置此模型的独立路径和可选参数，避免把旧接口参数发给新接口。供应商连接和其他模型不受影响，确定继续吗？")) return;
      resetParameters(selected ? { protocol: selected } : undefined);
    } else setModel({ ...model, connection: nextConnection });
  }
  async function apply() {
    setSubmitting(true); setError(null);
    try {
      if (connectionError) throw new Error(connectionError);
      if (staleParameters) throw new Error("供应商默认接口已变化，请先重置此模型的旧参数，再按当前接口文档重新启用。");
      const extra = JSON.parse(custom);
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("自定义参数需要是 JSON 对象。");
      const sizeEntries = ratioEnabled && usesSizes ? split(sizes).map((entry) => {
        const parts = entry.split("=");
        if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) throw new Error("尺寸格式应为：1:1=1024x1024，多个尺寸用逗号分隔。");
        return parts.map((value) => value.trim());
      }) : [];
      if (ratioEnabled && !(usesSizes ? sizeEntries.length : split(ratios).length)) throw new Error("启用比例后，请填写模型实际支持的比例或尺寸。");
      if (qualityEnabled && !split(qualities).length) throw new Error("请填写模型支持的画质或尺寸选项，或关闭该参数。");
      if (durationEnabled && !split(durations).length) throw new Error("请填写模型支持的时长，或关闭该参数。");
      if (resolutionEnabled && !split(resolutions).length) throw new Error("请填写模型支持的分辨率，或关闭该参数。");
      const [validated] = validateProviderModels([{ ...model, name: model.name.trim() || model.apiId.trim(),
        ratios: ratioEnabled ? usesSizes ? sizeEntries.map(([ratio]) => ratio) : split(ratios) : ["auto"],
        sizeMap: Object.fromEntries(sizeEntries), qualityOptions: qualityEnabled ? split(qualities) : [],
        durations: durationEnabled ? split(durations).map(Number) : [], resolutions: resolutionEnabled ? split(resolutions) : [],
        parameterKeys: extra.parameterKeys ?? {}, extraBody: extra.extraBody ?? {}, parameterProtocol: protocol }]);
      if (validated.parameterPreset !== "custom") {
        const defaults = resolveModelParameters(model, protocol);
        if (MODEL_PARAMETER_FIELDS.some((key) => JSON.stringify(validated[key]) !== JSON.stringify(defaults[key]))) validated.parameterPreset = "custom";
      }
      await onApply(validated);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存模型。"); }
    finally { setSubmitting(false); }
  }
  function cancel() {
    if (submitting || (dirty && !window.confirm("当前模型参数尚未保存，确定放弃更改吗？"))) return false;
    onCancel();
    return true;
  }
  return (
    <Dialog open onOpenChange={(open, details) => { if (!open && !cancel()) details.cancel(); }}>
      <DialogContent closeButtonLabel="关闭模型编辑" showCloseButton={!submitting} className="provider-settings flex max-h-[calc(100%_-_2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border p-4 pr-12">
          <DialogTitle>{config.models.some((entry) => entry.id === initial.id) ? "编辑" : "添加"}{KIND_LABELS[model.kind]}模型</DialogTitle>
          <DialogDescription>供应商：{config.name}。保存后生效，取消不会更改已有配置。</DialogDescription>
        </DialogHeader>
        <FieldSet disabled={submitting} className="contents" onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); if (!submitting && model.apiId.trim()) void apply(); } }}>
      <FieldGroup className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <Field><FieldLabel htmlFor={`${id}-api-id`}>模型 ID（必填）</FieldLabel><Input id={`${id}-api-id`} value={model.apiId} onChange={(event) => changeApiId(event.target.value)} placeholder="服务商提供的完整模型 ID" /><FieldDescription>已知模型按 ID 和接口自动配置参数；自定义别名可选择原模型预设，不需要重写实际请求的模型名。</FieldDescription></Field>
        <ModelConnectionEditor key={protocol} config={config} model={model} onChange={(connection) => setModel({ ...model, connection })} onProtocolChange={changeProtocol} onValidationChange={setConnectionError} />
        {staleParameters && <Field><FieldDescription>供应商默认接口已改变，此模型的旧参数不能直接复用。重置后，按 {MODEL_PROTOCOL_LABELS[protocol]} 文档重新启用需要的参数。</FieldDescription><Button type="button" variant="outline" size="sm" onClick={() => resetParameters(model.connection)}>重置旧接口参数</Button></Field>}
        <Field>
          <FieldLabel htmlFor={`${id}-preset`}>模型参数来源</FieldLabel>
          <NativeSelect id={`${id}-preset`} value={model.parameterPreset ?? "auto"} onChange={(event) => {
            const next = { ...model, parameterPreset: event.target.value };
            replaceParameters(event.target.value === "custom" ? next : resolveModelParameters(next, protocol));
          }}>
            <NativeSelectOption value="auto">按模型 ID 自动识别</NativeSelectOption>
            <NativeSelectOption value="custom">自定义参数（保留当前配置）</NativeSelectOption>
            {MODEL_PARAMETER_PRESETS.filter((entry) => entry.kind === model.kind && entry.protocol === protocol).map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.name}</NativeSelectOption>)}
          </NativeSelect>
          <FieldDescription>{preset ? `已载入 ${preset.name}：${model.ratios.join("、")}；${model.qualityOptions.length ? `画质 ${model.qualityOptions.join(" / ")}` : "使用默认画质"}；最多 ${model.maxImages} 张参考图。可直接保存使用；手动调整后会保留为自定义配置。` : model.parameterPreset === "custom" ? "保留手动配置，不会被自动预设覆盖。可以选择预设恢复默认参数。" : "未识别到当前接口下的已知模型。若这是映射后的别名，请选择实际原模型预设；否则只按上游文档配置，不猜测支持能力。"}</FieldDescription>
          {preset?.description && <FieldDescription>{preset.description}</FieldDescription>}
          {sizeAlternative && <div><Button type="button" variant="outline" size="sm" onClick={() => replaceParameters(resolveModelParameters({ ...model, parameterPreset: sizeAlternative.id }, protocol))}>{sizeAlternative.parameters.ratios?.includes("16:9") ? "启用扩展比例" : "使用标准尺寸"}</Button></div>}
          {preset && usesSizes && <details><summary className="cursor-pointer text-sm">查看预设的实际图片尺寸</summary><dl className="mt-3 grid grid-cols-2 gap-2 text-xs">{Object.entries(model.sizeMap).map(([ratio, size]) => <div key={ratio} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"><dt>{ratio === "auto" ? "自动" : ratio}</dt><dd className="text-muted-foreground">{size === "auto" ? "模型决定" : size}</dd></div>)}</dl></details>}
        </Field>
        <details><summary className="cursor-pointer text-sm">显示名称与可用状态（可选）</summary><FieldGroup className="mt-4">
          <Field><FieldLabel htmlFor={`${id}-name`}>显示名称</FieldLabel><Input id={`${id}-name`} value={model.name} onChange={(event) => setModel({ ...model, name: event.target.value })} placeholder="留空使用模型 ID" /></Field>
          <CapabilityToggle label="启用此模型" checked={model.enabled} onChange={(enabled) => setModel({ ...model, enabled })} />
        </FieldGroup></details>
        <details><summary className="cursor-pointer text-sm">支持的参数{preset ? "（已自动配置，可调整）" : "（按模型文档配置）"}</summary><FieldGroup className="mt-4">
          <FieldDescription>已知模型无需逐项启用。服务商能力不同时可调整；关闭后生成界面会隐藏对应选项，请求也不会携带该参数。</FieldDescription>
          {model.kind !== "text" && <>
            <CapabilityToggle label={usesSizes ? "图片尺寸" : "画面比例"} checked={ratioEnabled} onChange={setRatioEnabled}>
              <Field><FieldLabel htmlFor={`${id}-ratios`}>{usesSizes ? "比例与实际像素尺寸" : "支持的比例"}</FieldLabel><Input id={`${id}-ratios`} value={usesSizes ? sizes : ratios} onChange={(event) => usesSizes ? setSizes(event.target.value) : setRatios(event.target.value)} placeholder={usesSizes ? "1:1=1024x1024, 3:2=1536x1024" : "1:1, 16:9, 9:16"} /><FieldDescription>{usesSizes ? "必须填写上游支持的实际 size，不会把 16:9 擅自换算成其他比例。" : "逗号分隔，第一项为默认值。"}</FieldDescription></Field>
            </CapabilityToggle>
            <CapabilityToggle label="参考图片" checked={model.maxImages > 0} onChange={(enabled) => setModel({ ...model, maxImages: enabled ? 1 : 0, handles: model.kind === "video" ? enabled ? [...new Set([...model.handles, "resource" as const])] : model.handles.filter((handle) => handle !== "resource") : model.handles })}>
              <Field><FieldLabel htmlFor={`${id}-refs`}>最多参考图片数</FieldLabel><Input id={`${id}-refs`} type="number" min={1} max={50} value={model.maxImages} onChange={(event) => setModel({ ...model, maxImages: Number(event.target.value) })} /></Field>
            </CapabilityToggle>
          </>}
          {model.kind === "image" && <CapabilityToggle label={protocol === "gemini" ? "输出尺寸等级" : "画质"} checked={qualityEnabled} onChange={setQualityEnabled}>
            <Field><FieldLabel htmlFor={`${id}-quality`}>支持的选项</FieldLabel><Input id={`${id}-quality`} value={qualities} onChange={(event) => setQualities(event.target.value)} placeholder={protocol === "gemini" ? "1k, 2k, 4k" : "low, medium, high"} /><FieldDescription>填写文档中的原始值，第一项为默认值；不要混用不同接口的参数。</FieldDescription></Field>
          </CapabilityToggle>}
          {model.kind === "video" && <>
            <CapabilityToggle label="视频时长" checked={durationEnabled} onChange={setDurationEnabled}><Field><FieldLabel htmlFor={`${id}-durations`}>支持的时长（秒）</FieldLabel><Input id={`${id}-durations`} value={durations} onChange={(event) => setDurations(event.target.value)} placeholder="5, 10" /><FieldDescription>仅允许列表中的时长，不会将 5、10 当成任意 5–10 秒都可用。</FieldDescription></Field></CapabilityToggle>
            <CapabilityToggle label="分辨率" checked={resolutionEnabled} onChange={setResolutionEnabled}><Field><FieldLabel htmlFor={`${id}-resolutions`}>支持的分辨率</FieldLabel><Input id={`${id}-resolutions`} value={resolutions} onChange={(event) => setResolutions(event.target.value)} placeholder="720p, 1080p" /><FieldDescription>填写上游的原始值，第一项为默认值。</FieldDescription></Field></CapabilityToggle>
            <CapabilityToggle label="生成声音" checked={model.sound} onChange={(sound) => setModel({ ...model, sound })} />
            {HANDLE_LABELS.map((handle) => {
              const countKey = handle.id === "referenceVideo" ? "maxReferenceVideos" : handle.id === "audioRef" ? "maxReferenceAudios" : null;
              return <CapabilityToggle key={handle.id} label={handle.label} checked={model.handles.includes(handle.id)} onChange={(enabled) => setModel({ ...model, handles: enabled ? [...model.handles, handle.id] : model.handles.filter((entry) => entry !== handle.id), ...(countKey ? { [countKey]: enabled ? model[countKey] || 1 : 0 } : {}) })}>
                {countKey && <Field><FieldLabel htmlFor={`${id}-${countKey}`}>最多{handle.label}数</FieldLabel><Input id={`${id}-${countKey}`} type="number" min={1} max={50} value={model[countKey]} onChange={(event) => setModel({ ...model, [countKey]: Number(event.target.value) })} /></Field>}
              </CapabilityToggle>;
            })}
          </>}
          {model.kind === "text" && <CapabilityToggle label="限制回复长度" checked={model.maxOutputTokens !== null} onChange={(enabled) => setModel({ ...model, maxOutputTokens: enabled ? 1024 : null })}><Field><FieldLabel htmlFor={`${id}-tokens`}>最多输出 Token 数</FieldLabel><Input id={`${id}-tokens`} type="number" min={1} max={1000000} value={model.maxOutputTokens ?? 1024} onChange={(event) => setModel({ ...model, maxOutputTokens: Number(event.target.value) })} /></Field></CapabilityToggle>}
          {model.kind === "text" && protocol === "anthropic" && <FieldDescription>Anthropic 接口要求 max_tokens；未指定时仅使用 1024，可以按模型限制调整。</FieldDescription>}
          <Field><FieldLabel htmlFor={`${id}-prompt`}>提示词长度上限（字符）</FieldLabel><Input id={`${id}-prompt`} type="number" min={1} max={1000000} value={model.promptMaxLength} onChange={(event) => setModel({ ...model, promptMaxLength: Number(event.target.value) })} /><FieldDescription>本地保护限制，不会作为参数发给上游。</FieldDescription></Field>
        </FieldGroup></details>
        <details><summary className="cursor-pointer text-sm">自定义参数名与固定参数（高级，可选）</summary><Field className="mt-4"><FieldLabel htmlFor={`${id}-custom`}>请求参数 JSON</FieldLabel><Textarea id={`${id}-custom`} value={custom} onChange={(event) => {
          setCustom(event.target.value);
          try { const parsed = JSON.parse(event.target.value); if (parsed?.parameterKeys && typeof parsed.parameterKeys === "object") setModel({ ...model, parameterKeys: parsed.parameterKeys }); } catch {}
        }} rows={7} /><FieldDescription>parameterKeys 可映射 aspectRatio、quality、duration、resolution、sound、maxOutputTokens；extraBody 添加服务商要求的固定参数。留空对象即可，详见 README。</FieldDescription></Field></details>
      </FieldGroup>
          {error && <Field data-invalid className="shrink-0 px-4 pb-3"><FieldError role="alert">{error}</FieldError></Field>}
          <DialogFooter className="mx-0 mb-0 shrink-0">
            <Button type="button" variant="outline" size="sm" onClick={cancel}>取消</Button>
            <Button type="button" size="sm" onClick={apply} disabled={submitting || !model.apiId.trim()}>{submitting ? "保存中…" : "保存模型"}</Button>
          </DialogFooter>
        </FieldSet>
      </DialogContent>
    </Dialog>
  );
}

export default function ProviderModelsPanel({ config, kind, onSave, onDirtyChange }: { config: ProviderConfig; kind: ProviderModelKind; onSave: (models: ProviderModel[], defaultModel?: ProviderModel) => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const id = useId();
  const [editing, setEditing] = useState<ProviderModel | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState(false);
  const [addingModels, setAddingModels] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<OnlineModelCatalog | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogFetching, setCatalogFetching] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const controller = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const catalogController = useRef<AbortController | null>(null);
  const autoPull = useRef(config.models.length === 0);
  const models = config.models.filter((model) => model.kind === kind);
  const defaultId = config[kind === "text" ? "chatModel" : kind === "image" ? "imageModel" : "videoModel"];
  const reportDirty = useCallback((dirty: boolean) => { dirtyRef.current = dirty; onDirtyChange?.(dirty); }, [onDirtyChange]);
  function edit(model: ProviderModel | null) {
    if (dirtyRef.current && !window.confirm("当前模型参数尚未保存，确定放弃更改吗？")) return;
    setEditing(model);
  }
  const pull = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setFetching(true); setError(null);
    try {
      const response = await fetch(`/api/settings/provider/models?id=${encodeURIComponent(config.id)}`, { signal: request.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法拉取模型。");
      setDiscovered(data.models ?? []); setNotice(data.truncated ? "模型数量较多，当前展示前 1000 个。" : data.notice ?? ""); setFetched(true);
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "无法拉取模型，请尝试手动添加。"); }
    finally { if (!request.signal.aborted) setFetching(false); }
  }, [config.id]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled && autoPull.current) void pull(); });
    return () => { cancelled = true; controller.current?.abort(); catalogController.current?.abort(); };
  }, [pull]);
  async function loadCatalog(force = false) {
    catalogController.current?.abort();
    const request = new AbortController(); catalogController.current = request;
    setCatalogFetching(true); setCatalogError(null);
    try {
      const response = await fetch(`/api/settings/provider/model-catalog${force ? "?refresh=1" : ""}`, { signal: request.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法加载在线目录。");
      setCatalog(data);
    } catch (failure) { if (!request.signal.aborted) setCatalogError(failure instanceof Error ? failure.message : "无法加载在线目录。"); }
    finally { if (!request.signal.aborted) setCatalogFetching(false); }
  }
  function importCatalogModel(model: OnlineModel) {
    const host = new URL(config.baseUrl).hostname;
    const usesNamespacedIds = host === "ai-gateway.vercel.sh" || host === "openrouter.ai";
    edit(newProviderModel(kind, usesNamespacedIds ? model.id : model.apiId, model.name));
  }
  async function apply(model: ProviderModel) {
    if (config.models.some((entry) => entry.id !== model.id && entry.kind === model.kind && entry.apiId === model.apiId)) throw new Error("该模型已经添加，请直接编辑已添加的模型。");
    const previous = config.models.find((entry) => entry.id === model.id);
    await onSave(previous ? config.models.map((entry) => entry.id === model.id ? model : entry) : [...config.models, model], previous?.apiId === defaultId && model.enabled ? model : undefined);
    setEditing(null);
  }
  async function action(run: () => Promise<void>) {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm("当前模型参数尚未保存，继续操作会放弃更改，确定继续吗？")) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存模型。"); }
    finally { savingRef.current = false; setSaving(false); }
  }
  const filtered = discovered.filter((model) => (!model.suggestedKind || model.suggestedKind === kind) && `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
  const catalogModels = (catalog?.models ?? []).filter((model) => model.kind === kind && `${model.id} ${model.name}`.toLowerCase().includes(catalogQuery.toLowerCase()));
  return (
    <FieldSet>
      <FieldLegend>{KIND_LABELS[kind]}模型</FieldLegend>
      <FieldDescription>已启用的模型可直接用于生成，无需切换供应商。默认模型只在当前供应商内生效。</FieldDescription>
      <FieldGroup>
        <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={fetching} onClick={pull}><RefreshCw data-icon="inline-start" />{fetching ? "拉取中…" : "拉取模型"}</Button><Button type="button" variant="outline" size="sm" onClick={() => edit(newProviderModel(kind))}><Plus data-icon="inline-start" />手动添加</Button></div>
        <FieldDescription>{config.models.length ? "已有模型配置，不会自动请求服务商的模型列表。需要发现更多模型时可手动拉取；未开放列表接口的服务商可直接手动添加。" : "模型列表仅用于发现模型 ID，不提供完整参数能力。接口不可用时可手动添加，已知模型会按内置预设配置参数。"}</FieldDescription>
        {fetched && <details open={addingModels} onToggle={(event) => setAddingModels(event.currentTarget.open)}><summary className="cursor-pointer text-sm">从服务商列表添加模型（{discovered.length}）</summary><FieldGroup className="mt-3">
          <Field><FieldLabel htmlFor={`${id}-search`}>服务商{KIND_LABELS[kind]}模型（{filtered.length}）</FieldLabel><Input id={`${id}-search`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或模型 ID" /><FieldDescription>已知模型添加后自动配置参数；自定义别名可在编辑中选择原模型预设。未知能力不会猜测。{notice}</FieldDescription></Field>
          <div className="flex flex-col gap-2" aria-label="服务商模型列表">
            {filtered.map((model) => {
              const configured = models.find((entry) => entry.apiId === model.id);
              const label = configured ? `已添加${KIND_LABELS[kind]}模型 ${model.name}，点击移除` : `添加${KIND_LABELS[kind]}模型 ${model.name}`;
              return <div key={model.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2">
                <div className="min-w-0"><p className="truncate text-sm">{model.name}</p><p className="truncate text-xs text-muted-foreground">{model.id}{model.suggestedKind ? ` · 推测为${KIND_LABELS[model.suggestedKind]}模型` : ""}</p></div>
                <Button type="button" variant={configured ? "secondary" : "outline"} size="icon-sm" aria-label={label} title={label} aria-pressed={!!configured} disabled={saving} onClick={() => action(async () => {
                  if (configured) {
                    await onSave(config.models.filter((entry) => entry.id !== configured.id));
                    if (editing?.id === configured.id) setEditing(null);
                  } else {
                    await apply(newProviderModel(kind, model.id, model.name));
                  }
                })}>{configured ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}</Button>
              </div>;
            })}
            {!filtered.length && <FieldDescription>没有匹配的模型，仍可手动添加。</FieldDescription>}
          </div>
        </FieldGroup></details>}
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto" aria-label={`已配置的${KIND_LABELS[kind]}模型`}>
          {models.map((model) => {
            const protocol = providerModelProtocol(config, model);
            const stale = model.parameterProtocol && model.parameterProtocol !== protocol && hasModelParameters(model);
            return <div key={model.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
              <div className="min-w-0"><p className="truncate text-sm">{model.name}{model.enabled && model.apiId === defaultId ? " · 供应商内默认" : ""}</p><p className="truncate text-xs text-muted-foreground">{model.apiId}{!model.enabled ? " · 已停用" : ""}</p><p className="text-xs text-muted-foreground">{MODEL_PROTOCOL_LABELS[protocol]} · {Object.keys(model.connection ?? {}).length ? "模型独立配置" : "跟随供应商"}{stale ? " · 参数待重新确认" : ""}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                {model.enabled && model.apiId !== defaultId && <Button type="button" variant="outline" size="sm" onClick={() => action(() => onSave(config.models, model))}>设为供应商内默认</Button>}
                <div className="flex items-center gap-2">
                  <Switch aria-label={`启用模型 ${model.name}`} title={model.enabled ? "点击停用模型" : "点击启用模型"} checked={model.enabled} onCheckedChange={(enabled) => action(() => onSave(config.models.map((entry) => entry.id === model.id ? { ...entry, enabled } : entry)))} />
                  <span className="text-xs text-foreground" aria-hidden="true">{model.enabled ? "已启用" : "已停用"}</span>
                </div>
                <Button type="button" variant="outline" size="icon-sm" aria-label={`编辑模型 ${model.name}`} title="编辑模型" onClick={() => edit(model)}><Pencil data-icon="inline-start" /></Button>
                <Button type="button" variant="destructive" size="icon-sm" aria-label={`移除模型 ${model.name}`} title="移除模型" onClick={() => action(async () => { if (!window.confirm(`确定移除模型「${model.name}」吗？`)) return; if (dirtyRef.current && !window.confirm("当前模型参数尚未保存，移除会放弃更改，确定继续吗？")) return; await onSave(config.models.filter((entry) => entry.id !== model.id)); if (editing?.id === model.id) setEditing(null); })}><Trash2 data-icon="inline-start" /></Button>
              </div>
            </div>;
          })}
          {!models.length && !editing && <FieldDescription>还没有{KIND_LABELS[kind]}模型。添加一个需要的模型就够了，其他类型可以不配置。</FieldDescription>}
        </div>
        {editing && <ModelEditor key={editing.id} initial={editing} config={config} onApply={apply} onCancel={() => setEditing(null)} onDirtyChange={reportDirty} />}
        {error && <Field data-invalid><FieldError role="alert">{error}</FieldError></Field>}
        <details open={catalogOpen} onToggle={(event) => {
          const open = event.currentTarget.open;
          setCatalogOpen(open);
          if (open && !catalogFetching && (!catalog || Date.now() - Date.parse(catalog.updatedAt) >= 6 * 60 * 60 * 1000)) void loadCatalog();
        }} className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm">在线参考目录 · 找不到模型时使用</summary>
          <FieldGroup className="mt-4">
            <FieldDescription>从 Vercel AI Gateway 和 models.dev 自动更新，不需要 Key，也不会改变生成请求的服务商。目录中有模型不代表当前服务商支持；导入后请确认模型 ID，再保存。</FieldDescription>
            <Field><FieldLabel htmlFor={`${id}-catalog-search`}>搜索在线{KIND_LABELS[kind]}模型</FieldLabel><Input id={`${id}-catalog-search`} value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder={kind === "image" ? "例如 gpt-image-2.6、Gemini、Flux" : "搜索模型名称或厂商"} /></Field>
            <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={catalogFetching} onClick={() => loadCatalog(true)}><RefreshCw data-icon="inline-start" />{catalogFetching ? "同步中…" : "更新在线目录"}</Button>{catalog && <FieldDescription>{catalog.sources.join(" + ")} · {new Date(catalog.updatedAt).toLocaleString()} · {catalog.stale ? "含离线缓存" : "每 6 小时更新"}</FieldDescription>}</div>
            {catalog?.notice && <FieldDescription>{catalog.notice}</FieldDescription>}
            {catalogError && <Field data-invalid><FieldError role="alert">{catalogError}</FieldError></Field>}
            <div className="flex max-h-60 flex-col gap-2 overflow-y-auto" aria-label={`在线${KIND_LABELS[kind]}模型目录`}>
              {catalogModels.slice(0, 100).map((model) => <div key={model.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-2"><div className="min-w-0"><p className="truncate text-sm">{model.name}</p><p className="truncate text-xs text-muted-foreground">{model.id} · 未验证当前服务商</p></div><Button type="button" variant="outline" size="sm" onClick={() => importCatalogModel(model)}>导入并确认</Button></div>)}
              {catalogModels.length > 100 && <FieldDescription>匹配 {catalogModels.length} 个模型，显示前 100 个；输入名称可缩小范围。</FieldDescription>}
              {catalog && !catalogModels.length && <FieldDescription>没有匹配的模型，仍可手动填写服务商提供的模型 ID。</FieldDescription>}
            </div>
          </FieldGroup>
        </details>
      </FieldGroup>
    </FieldSet>
  );
}
