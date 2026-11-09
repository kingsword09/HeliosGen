import { EnvHttpProxyAgent, fetch } from "undici";
import { getSetting, setSetting } from "./guest/db";
import type { OnlineModel, OnlineModelCatalog, ProviderModelKind } from "./providerModelConfig";

const CACHE_KEY = "online_model_catalog_v2";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_MODELS = 10000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const dispatcher = new EnvHttpProxyAgent();
let pending: Promise<OnlineModelCatalog> | undefined;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length < 100).slice(0, 20) : [];
}

function modelKind(type: unknown, outputs: string[]): ProviderModelKind | null {
  if (type === "video" || outputs.includes("video")) return "video";
  if (type === "image" || outputs.includes("image")) return "image";
  if (type === "language" || type === "chat" || type === "text" || outputs.includes("text")) return "text";
  return null;
}

export function parseOnlineModels(value: unknown, source: OnlineModel["source"]): OnlineModel[] {
  const models: OnlineModel[] = [];
  function add(entry: unknown, provider: string) {
    const item = record(entry);
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 300) return;
    const modalities = record(item.modalities);
    const inputs = strings(modalities.input);
    const outputs = strings(modalities.output);
    const kind = modelKind(item.type, outputs);
    if (!kind || !provider || provider.length > 100) return;
    const id = item.id.trim();
    const prefix = `${provider}/`;
    const upstreamId = source === "vercel" && id.startsWith(prefix) ? id.slice(prefix.length) : id;
    if (!upstreamId) return;
    const explicitCanonical = typeof item.canonical_model_id === "string" && /^[a-zA-Z0-9_-]+\/.+/.test(item.canonical_model_id) && item.canonical_model_id.length <= 300 ? item.canonical_model_id : undefined;
    const canonical = explicitCanonical ?? (source === "models.dev" && ["vercel", "openrouter"].includes(provider) && id.includes("/") ? id : `${provider}/${upstreamId}`);
    const separator = canonical.indexOf("/");
    const apiId = canonical.slice(separator + 1);
    const name = typeof item.name === "string" && item.name.trim() && item.name.length <= 300 ? item.name.trim() : apiId;
    models.push({ id: canonical, apiId, name, provider: canonical.slice(0, separator), kind, inputs, outputs, source });
  }
  if (source === "vercel") {
    const entries = record(value).data;
    if (!Array.isArray(entries)) throw new Error("在线目录返回了无效的模型列表。");
    for (const entry of entries.slice(0, MAX_MODELS)) {
      const item = record(entry);
      const provider = typeof item.owned_by === "string" ? item.owned_by : typeof item.id === "string" ? item.id.split("/")[0] : "";
      add(entry, provider);
    }
  } else {
    for (const [provider, data] of Object.entries(record(value))) {
      for (const entry of Object.values(record(record(data).models))) {
        add(entry, provider);
        if (models.length >= MAX_MODELS) break;
      }
      if (models.length >= MAX_MODELS) break;
    }
  }
  if (!models.length) throw new Error("在线目录中没有可识别的生成模型。");
  return models;
}

async function download(url: string): Promise<unknown> {
  const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("模型目录过大。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("模型目录为空。");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("模型目录过大。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cachedCatalog(): OnlineModelCatalog | undefined {
  try {
    const saved = getSetting(CACHE_KEY);
    if (!saved) return;
    const catalog = JSON.parse(saved) as OnlineModelCatalog;
    if (!Array.isArray(catalog.models) || !catalog.models.length || !Number.isFinite(Date.parse(catalog.updatedAt))) return;
    return catalog;
  } catch { return; }
}

export async function getOnlineModelCatalog(force = false): Promise<OnlineModelCatalog> {
  const cached = cachedCatalog();
  if (!force && cached && Date.now() - Date.parse(cached.updatedAt) < CACHE_TTL) return cached;
  if (pending) return pending;
  pending = (async () => {
    const results = await Promise.allSettled([
      download("https://ai-gateway.vercel.sh/v1/models").then((json) => parseOnlineModels(json, "vercel")),
      download("https://models.dev/api.json").then((json) => parseOnlineModels(json, "models.dev")),
    ]);
    const models = new Map<string, OnlineModel>();
    const sources: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled") continue;
      sources.push(index === 0 ? "Vercel AI Gateway" : "models.dev");
      for (const model of result.value) if (!models.has(model.id) && models.size < MAX_MODELS) models.set(model.id, model);
    }
    if (!models.size) {
      if (cached) return { ...cached, stale: true, notice: "在线目录暂时不可用，正在使用上次保存的目录。" };
      throw new Error("无法连接在线模型目录。可继续拉取服务商模型或手动添加。");
    }
    const failedSources = results.flatMap((result, index) => result.status === "rejected" ? [index === 0 ? "vercel" : "models.dev"] : []);
    let usedCache = false;
    for (const model of cached?.models ?? []) {
      if (failedSources.includes(model.source) && !models.has(model.id) && models.size < MAX_MODELS) {
        models.set(model.id, model);
        usedCache = true;
      }
    }
    const catalog: OnlineModelCatalog = {
      models: [...models.values()].sort((first, second) => first.name.localeCompare(second.name)),
      updatedAt: new Date().toISOString(), sources, stale: usedCache,
      notice: sources.length < 2 ? usedCache ? "部分目录暂时不可用，已保留该数据源的上次缓存。" : "部分目录暂时不可用，已使用可用的数据源。" : "",
    };
    setSetting(CACHE_KEY, JSON.stringify(catalog));
    return catalog;
  })().finally(() => { pending = undefined; });
  return pending;
}
