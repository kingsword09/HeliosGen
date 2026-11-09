"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Box, CircleCheck, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Separator } from "@/components/ui/separator";
import { DEFAULT_PROVIDER_CONFIG, validateProviderConfig, withProviderModels, type ProviderConfig, type PublicProvider, type PublicProviderSettings } from "@/lib/providerConfig";
import type { ProviderModel, ProviderModelKind } from "@/lib/providerModelConfig";
import ProviderModelsPanel from "@/components/ProviderModelsPanel";
import { setModelCatalog } from "@/lib/useModelCatalog";
import { useWorkflowStore } from "@/lib/store";

const BASIC_FIELDS = ["id", "name", "baseUrl", "imageModel", "chatModel", "videoModel", "models"];
const CONNECTIONS = [{ id: "openai", name: "OpenAI 兼容" }, { id: "gemini", name: "Gemini 原生" }, { id: "anthropic", name: "Anthropic 原生" }, { id: "custom", name: "异步任务" }] as const;
const KIND_LABELS = { image: "图片", video: "视频", text: "对话" };
type Connection = (typeof CONNECTIONS)[number]["id"];

function advancedSettings(config: ProviderConfig): string {
  return JSON.stringify(Object.fromEntries(Object.entries(config).filter(([key]) => !BASIC_FIELDS.includes(key))), null, 2);
}

function connectionType(config: ProviderConfig, kind?: ProviderModelKind): Connection {
  if (kind === "image") return config.imageProtocol === "task" ? "custom" : config.imageProtocol;
  if (kind === "text") return config.chatProtocol;
  if (kind === "video") return "custom";
  if (config.imageProtocol === "task") return "custom";
  if (config.imageProtocol === "gemini" && config.chatProtocol === "gemini") return "gemini";
  if (config.chatProtocol === "anthropic") return "anthropic";
  return config.imageProtocol === "openai" && config.chatProtocol === "openai" ? "openai" : "custom";
}

export default function CustomProviderPanel({ onReadyChange, modelKind, onOpenModels, providerId, onProviderSelect, onDirtyChange }: {
  onReadyChange?: (ready: boolean) => void;
  modelKind?: ProviderModelKind;
  onOpenModels?: (kind: ProviderModelKind) => void;
  providerId?: string | null;
  onProviderSelect?: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const updateReady = useWorkflowStore((state) => state.setProviderReady);
  const handleReady = onReadyChange ?? updateReady;
  const [config, setConfig] = useState<ProviderConfig>(DEFAULT_PROVIDER_CONFIG);
  const [advanced, setAdvanced] = useState(advancedSettings(DEFAULT_PROVIDER_CONFIG));
  const [connection, setConnection] = useState<Connection>("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [defaults, setDefaults] = useState<PublicProviderSettings["defaultProviderIds"]>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [draft, setDraft] = useState(false);
  const [editingConnection, setEditingConnection] = useState(!modelKind);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const loadedProviderId = useRef<string | null>(null);
  const isSaved = providers.some((provider) => provider.config.id === config.id);
  const categoryModels = config.models.filter((model) => model.kind === modelKind && model.enabled);
  const isDefault = !!modelKind && defaults[modelKind] === config.id;

  useEffect(() => { onDirtyChange?.(dirty || modelDirty); }, [dirty, modelDirty, onDirtyChange]);

  function updateSettings(data: PublicProviderSettings) {
    setProviders(data.providers); setDefaults(data.defaultProviderIds);
    setModelCatalog(data); handleReady(data.ready);
  }

  function loadProvider(provider: PublicProvider, isDraft = false) {
    const next = validateProviderConfig(provider.config);
    setConfig(next); setAdvanced(advancedSettings(next)); setConnection(connectionType(next, modelKind));
    setHasKey(provider.hasKey); setApiKey(""); setClearKey(false); setDirty(false); setModelDirty(false);
    setDraft(isDraft); setEditingConnection(isDraft || !modelKind); setError(null); setNotice("");
    loadedProviderId.current = next.id;
    onProviderSelect?.(next.id);
  }

  useEffect(() => {
    if (providerId && providerId === loadedProviderId.current) return;
    const controller = new AbortController();
    fetch("/api/settings/provider", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("无法加载供应商配置。");
      return response.json() as Promise<PublicProviderSettings>;
    }).then((data) => {
      if (controller.signal.aborted) return;
      setProviders(data.providers); setDefaults(data.defaultProviderIds);
      setModelCatalog(data); handleReady(data.ready);
      const preferredId = providerId ?? (modelKind ? data.defaultProviderIds[modelKind] : data.activeId);
      const selected = data.providers.find((provider) => provider.config.id === preferredId) ?? data.providers[0];
      if (selected) {
        setConfig(selected.config); setAdvanced(advancedSettings(selected.config)); setConnection(connectionType(selected.config, modelKind));
        setHasKey(selected.hasKey); loadedProviderId.current = selected.config.id; setLoading(false); onProviderSelect?.(selected.config.id);
      }
    }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载配置。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [handleReady, providerId, modelKind, onProviderSelect]);

  function discardChanges(): boolean {
    return !(dirty || modelDirty || (draft && (config.name || config.baseUrl || apiKey))) || window.confirm("当前配置尚未保存，确定放弃更改吗？");
  }

  function changed() { setDirty(true); setNotice(""); }

  function changeConnection(value: Connection) {
    if (modelKind) {
      const next = { ...config };
      if (modelKind === "image") next.imageProtocol = value === "custom" ? "task" : value as ProviderConfig["imageProtocol"];
      if (modelKind === "text") next.chatProtocol = value as ProviderConfig["chatProtocol"];
      if (value !== connection && next.authPrefix === "" && ((connection === "gemini" && next.authHeader === "x-goog-api-key") || (connection === "anthropic" && next.authHeader === "x-api-key"))) { next.authHeader = "Authorization"; next.authPrefix = "Bearer "; }
      const changedModels = config.models.filter((model) => !model.connection?.protocol && model.kind === modelKind);
      if (changedModels.length && value !== connection && !window.confirm(`更改默认接口会影响 ${changedModels.length} 个跟随供应商的${KIND_LABELS[modelKind]}模型；独立接口的模型不受影响。已有参数需在模型编辑页重新确认，确定继续吗？`)) return;
      setConnection(value); setConfig(next); setAdvanced(advancedSettings(next)); changed(); return;
    }
    setConnection(value);
    if (value === "custom") {
      const next = { ...config, imageProtocol: "task" as const };
      setConfig(next); setAdvanced(advancedSettings(next)); changed(); return;
    }
    const next: ProviderConfig = { ...config, imageProtocol: value === "gemini" ? "gemini" : "openai", chatProtocol: value,
      authHeader: value === "gemini" ? "x-goog-api-key" : value === "anthropic" ? "x-api-key" : "Authorization", authPrefix: value === "openai" ? "Bearer " : "",
      modelsProtocol: value, modelsPath: "models", modelsResultPath: "", imagesPath: "images/generations", editsPath: "images/edits", chatPath: value === "anthropic" ? "messages" : "chat/completions" };
    setConfig(next); setAdvanced(advancedSettings(next)); changed();
  }

  function currentConfig(next = config): ProviderConfig {
    const extra = JSON.parse(advanced);
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("高级配置需要是 JSON 对象。");
    const basic = Object.fromEntries(BASIC_FIELDS.map((key) => [key, next[key as keyof ProviderConfig]]));
    basic.name = next.name.trim() || new URL(next.baseUrl).host;
    return validateProviderConfig({ ...extra, ...basic });
  }

  async function persist(next = config) {
    setSaving(true); setError(null); setNotice("");
    try {
      const response = await fetch("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: currentConfig(next), ...(clearKey ? { apiKey: "" } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法保存配置。");
      const stored = data.providers.find((provider: PublicProvider) => provider.config.id === next.id);
      if (!stored) throw new Error("保存的供应商未返回，请重新加载设置。");
      updateSettings(data); loadProvider(stored); setNotice("已保存，所有已启用的模型均可直接选择。");
      setEditingConnection(!modelKind);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存配置。"); throw failure; }
    finally { setSaving(false); }
  }

  async function saveModels(models: ProviderModel[], defaultModel?: ProviderModel) {
    if (dirty) throw new Error("请先保存或取消连接信息的更改，再保存模型。");
    const next = withProviderModels(config, models);
    if (defaultModel) next[defaultModel.kind === "text" ? "chatModel" : defaultModel.kind === "image" ? "imageModel" : "videoModel"] = defaultModel.apiId;
    await persist(next);
  }

  async function setDefault() {
    if (!modelKind) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/settings/provider", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ activeId: config.id, kind: modelKind }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法设置默认供应商。");
      updateSettings(data); setNotice(`已设为${KIND_LABELS[modelKind]}默认供应商，不影响其他类型。`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法设置默认供应商。"); }
    finally { setSaving(false); }
  }

  async function refresh() {
    if (!discardChanges()) return;
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/settings/provider", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法刷新供应商。");
      updateSettings(data);
      const selected = data.providers.find((provider: PublicProvider) => provider.config.id === config.id) ?? data.providers[0];
      if (selected) loadProvider(selected);
      else { setDraft(false); setDirty(false); setModelDirty(false); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法刷新供应商。"); }
    finally { setLoading(false); }
  }

  async function remove() {
    if (!discardChanges() || !window.confirm(`确定删除「${config.name}」吗？它的所有类型模型和 API Key 都会移除，其他供应商不受影响。`)) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/settings/provider?id=${encodeURIComponent(config.id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "无法删除供应商。");
      updateSettings(data);
      if (data.providers[0]) loadProvider(data.providers[0]);
      else { setDraft(false); setDirty(false); setModelDirty(false); setConfig(DEFAULT_PROVIDER_CONFIG); loadedProviderId.current = null; }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法删除供应商。"); }
    finally { setSaving(false); }
  }

  return (
    <section className="provider-settings flex min-w-0 flex-col gap-3 text-card-foreground" aria-label={modelKind ? `${KIND_LABELS[modelKind]}供应商管理` : "供应商管理"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldDescription>{modelKind ? `可添加多个${KIND_LABELS[modelKind]}供应商，使用时直接选择各自的模型。` : "连接信息集中管理；同一供应商可配置图片、视频和对话模型。"}</FieldDescription>
        <div className="flex gap-2"><Button type="button" variant="outline" size="icon-sm" aria-label="刷新供应商列表" disabled={loading || saving} onClick={refresh}><RefreshCw /></Button><Button type="button" size="sm" disabled={loading || saving} onClick={() => {
          if (discardChanges()) loadProvider({ config: { ...DEFAULT_PROVIDER_CONFIG, id: `provider-${crypto.randomUUID()}`, name: "", models: [] }, hasKey: false }, true);
        }}><Plus data-icon="inline-start" />添加供应商</Button></div>
      </div>
      <div className="grid min-h-96 min-w-0 grid-cols-1 overflow-clip rounded-xl border border-border sm:grid-cols-[160px_minmax(0,1fr)]">
        <nav aria-label="已保存的供应商" className="flex flex-col gap-1 border-b border-border p-2 sm:sticky sm:top-0 sm:max-h-[70vh] sm:self-start sm:overflow-y-auto sm:border-r sm:border-b-0">
          <p className="px-2 py-2 text-xs text-muted-foreground">{modelKind ? `${KIND_LABELS[modelKind]}供应商` : "全部供应商"} · {providers.length}</p>
          {providers.map((provider) => {
            const count = provider.config.models.filter((model) => model.enabled && (!modelKind || model.kind === modelKind)).length;
            const active = !draft && config.id === provider.config.id;
            return <Button key={provider.config.id} type="button" variant={active ? "secondary" : "ghost"} aria-current={active ? "true" : undefined} disabled={saving || loading} className="h-auto min-h-11 w-full justify-start py-2" onClick={() => { if (!active && discardChanges()) loadProvider(provider); }}>
              <Box data-icon="inline-start" /><span className="flex min-w-0 flex-1 flex-col items-start gap-1"><span className="max-w-full truncate">{provider.config.name}</span><span className="text-xs text-muted-foreground">{count ? `${count} 个模型` : "未添加模型"}{modelKind && defaults[modelKind] === provider.config.id ? " · 默认" : ""}</span></span>
            </Button>;
          })}
          {draft && <Button type="button" variant="secondary" aria-current="true" className="justify-start" disabled><Plus data-icon="inline-start" />新供应商</Button>}
          {!providers.length && !draft && <FieldDescription className="px-2">还没有供应商</FieldDescription>}
        </nav>
        <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">
          {loading && <p role="status" className="text-sm text-muted-foreground">正在加载供应商…</p>}
          {!loading && !isSaved && !draft && <FieldGroup><FieldLegend>添加你的第一个供应商</FieldLegend><FieldDescription>点击「添加供应商」，填写 API 地址与 Key，再添加需要的模型。无需先到其他页面，也不需要配置全部类型。</FieldDescription></FieldGroup>}
          {!loading && (isSaved || draft) && <>
            <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><Box className="size-5 shrink-0" /><h3 className="truncate text-sm font-semibold">{draft ? "添加供应商" : config.name}</h3></div>{isSaved && <div className="flex flex-wrap gap-2">{modelKind && <Button type="button" variant="outline" size="sm" disabled={isDefault || !categoryModels.length || saving || dirty || modelDirty} onClick={setDefault}>{isDefault ? <><CircleCheck data-icon="inline-start" />{KIND_LABELS[modelKind]}默认</> : `设为${KIND_LABELS[modelKind]}默认`}</Button>}<Button type="button" variant="ghost" size="icon-sm" aria-label={`删除供应商 ${config.name}`} disabled={saving} onClick={remove}><Trash2 /></Button></div>}</header>
            {isSaved && modelKind && !editingConnection && <FieldGroup className="gap-2"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 truncate text-xs text-muted-foreground">默认{KIND_LABELS[modelKind]}接口：{CONNECTIONS.find((entry) => entry.id === connectionType(config, modelKind))?.name} · {config.baseUrl}</p><Button type="button" variant="outline" size="sm" disabled={saving || modelDirty} onClick={() => setEditingConnection(true)}><Settings2 data-icon="inline-start" />连接设置</Button></div><FieldDescription>Key：{hasKey ? "已保存" : "未设置（本地服务可不填）"}。地址与 Key 共用；每个模型可以覆盖接口方式，不必重复添加供应商。</FieldDescription></FieldGroup>}
            {editingConnection && <form onSubmit={(event) => { event.preventDefault(); void persist().catch(() => {}); }}><FieldSet disabled={saving}>
              <FieldLegend>连接设置</FieldLegend><FieldGroup>
                <Field><FieldLabel htmlFor={`${id}-name`}>供应商名称</FieldLabel><Input id={`${id}-name`} value={config.name} onChange={(event) => { setConfig({ ...config, name: event.target.value }); changed(); }} placeholder="例如：我的 Gemini、公司中转；留空使用地址" /></Field>
                {modelKind !== "video" && <Field><FieldLabel id={`${id}-connection`}>默认{modelKind ? KIND_LABELS[modelKind] : ""}接口方式</FieldLabel><ToggleGroup aria-labelledby={`${id}-connection`} value={[connection]} onValueChange={(values) => { if (values[0]) changeConnection(values[0] as Connection); }} variant="outline" size="sm" className="flex-wrap">{CONNECTIONS.filter((entry) => !modelKind || (modelKind === "image" ? entry.id !== "anthropic" : entry.id !== "custom")).map((entry) => <ToggleGroupItem key={entry.id} value={entry.id}>{entry.name}</ToggleGroupItem>)}</ToggleGroup><FieldDescription>这只是新增模型的默认接口，不限制供应商只能使用一种格式。模型支持其他格式时，在模型编辑中覆盖即可。</FieldDescription></Field>}
                <Field><FieldLabel htmlFor={`${id}-base`}>API 地址（必填）</FieldLabel><Input id={`${id}-base`} type="url" required value={config.baseUrl} onChange={(event) => { setConfig({ ...config, baseUrl: event.target.value }); changed(); }} placeholder={connection === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : connection === "anthropic" ? "https://api.anthropic.com/v1" : "https://your-provider.example/v1"} /></Field>
                <Field><FieldLabel htmlFor={`${id}-key`}>API Key</FieldLabel><Input id={`${id}-key`} type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); changed(); }} placeholder={hasKey && !clearKey ? "已保存，留空保留原 Key" : "本地免鉴权服务可留空"} /><FieldDescription>Key 只存储在本地服务端，不回传明文。</FieldDescription>{hasKey && <Button type="button" variant="outline" size="sm" onClick={() => { setClearKey(!clearKey); changed(); }}>{clearKey ? "取消清除 Key" : "清除已保存的 Key"}</Button>}</Field>
                <details><summary className="cursor-pointer text-sm">高级连接设置（可选）</summary><FieldGroup className="mt-4"><Field><FieldLabel htmlFor={`${id}-advanced`}>协议、路径与请求模板</FieldLabel><Textarea id={`${id}-advanced`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); changed(); }} rows={10} /><FieldDescription>标准接口不需要修改。自定义异步接口按服务商文档设置创建、轮询路径和响应字段。</FieldDescription></Field></FieldGroup></details>
                <div className="flex gap-2"><Button type="submit" disabled={!config.baseUrl.trim() || (!dirty && isSaved)}>{saving ? "保存中…" : "保存连接"}</Button><Button type="button" variant="outline" onClick={() => {
                  if (!discardChanges()) return;
                  const stored = providers.find((provider) => provider.config.id === config.id) ?? providers[0];
                  if (stored) { loadProvider(stored); setEditingConnection(!modelKind); }
                  else { setDraft(false); setDirty(false); }
                }}>取消</Button></div>
              </FieldGroup>
            </FieldSet></form>}
            {isSaved && modelKind && !editingConnection && <><Separator /><ProviderModelsPanel key={`${config.id}-${modelKind}`} config={config} kind={modelKind} onSave={saveModels} onDirtyChange={setModelDirty} /></>}
            {isSaved && !modelKind && onOpenModels && <FieldGroup><Separator /><FieldLegend>已配置模型</FieldLegend><div className="flex flex-wrap gap-2">{(["image", "video", "text"] as const).map((kind) => <Button key={kind} type="button" variant="outline" disabled={dirty || saving} onClick={() => onOpenModels(kind)}>{KIND_LABELS[kind]}模型 · {config.models.filter((model) => model.enabled && model.kind === kind).length}</Button>)}</div><FieldDescription>只添加需要的类型。每种类型可使用不同供应商，不需要全局切换。</FieldDescription></FieldGroup>}
          </>}
          {error && <Field data-invalid><FieldError role="alert">{error}</FieldError></Field>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </div>
      </div>
    </section>
  );
}
