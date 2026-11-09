import { getSetting, setSetting } from "./guest/db";
import { DEFAULT_PROVIDER_CONFIG, validateProviderConfig, type ProviderConfig, type PublicProviderSettings } from "./providerConfig";
import type { ProviderModelKind } from "./providerModelConfig";

interface SavedProvider {
  config: ProviderConfig;
  apiKey: string;
}

interface ProviderRegistry {
  activeId: string | null;
  providers: SavedProvider[];
  defaultProviderIds?: Partial<Record<ProviderModelKind, string>>;
}

function registry(): ProviderRegistry {
  const saved = getSetting("custom_provider_registry");
  if (saved) {
    const existing = JSON.parse(saved) as ProviderRegistry;
    return { ...existing, providers: existing.providers.map((provider) => ({ ...provider, config: validateProviderConfig(provider.config) })) };
  }
  const legacy = getSetting("custom_provider_config");
  const config = validateProviderConfig(legacy ? JSON.parse(legacy) : {
    ...DEFAULT_PROVIDER_CONFIG,
    baseUrl: process.env.CUSTOM_PROVIDER_BASE_URL ?? "",
    imageProtocol: process.env.CUSTOM_PROVIDER_IMAGE_PROTOCOL ?? "openai",
    chatProtocol: process.env.CUSTOM_PROVIDER_CHAT_PROTOCOL ?? "openai",
    imageModel: process.env.CUSTOM_PROVIDER_IMAGE_MODEL ?? "",
    chatModel: process.env.CUSTOM_PROVIDER_CHAT_MODEL ?? "",
    videoModel: process.env.CUSTOM_PROVIDER_VIDEO_MODEL ?? "",
  });
  const initial: ProviderRegistry = {
    activeId: config.baseUrl ? config.id : null,
    providers: config.baseUrl ? [{ config, apiKey: getSetting("custom_provider_api_key") ?? process.env.CUSTOM_PROVIDER_API_KEY ?? "" }] : [],
  };
  setSetting("custom_provider_registry", JSON.stringify(initial));
  return initial;
}

function defaultProvider(saved: ProviderRegistry, kind: ProviderModelKind): SavedProvider | undefined {
  const available = saved.providers.filter((provider) => provider.config.baseUrl && provider.config.models.some((model) => model.enabled && model.kind === kind));
  return available.find((provider) => provider.config.id === saved.defaultProviderIds?.[kind])
    ?? available.find((provider) => provider.config.id === saved.activeId)
    ?? available[0];
}

export function getProviderConfig(id?: string, kind?: ProviderModelKind): ProviderConfig {
  const saved = registry();
  if (!id && kind) return defaultProvider(saved, kind)?.config ?? { ...DEFAULT_PROVIDER_CONFIG };
  return saved.providers.find((provider) => provider.config.id === (id ?? saved.activeId))?.config ?? { ...DEFAULT_PROVIDER_CONFIG, id: id ?? DEFAULT_PROVIDER_CONFIG.id };
}

export function getProviderForModel(kind: ProviderModelKind, selected: string): ProviderConfig {
  if (!selected.startsWith("provider-model:")) {
    const config = getProviderConfig(undefined, kind);
    return config.baseUrl ? config : getProviderConfig();
  }
  const match = /^provider-model:([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(selected);
  if (!match) throw new Error("模型标识无效，请重新选择模型。");
  const provider = getProviderConfig(match[1]);
  const model = provider.models.find((entry) => entry.id === match[2]);
  if (!provider.baseUrl || !model?.enabled || model.kind !== kind) throw new Error("供应商或模型已删除、停用，或不支持当前类型，请重新选择模型。");
  return provider;
}

export function getProviderApiKey(id?: string): string {
  const saved = registry();
  return saved.providers.find((provider) => provider.config.id === (id ?? saved.activeId))?.apiKey ?? "";
}

export function publicProviderSettings(): PublicProviderSettings {
  const saved = registry();
  const active = saved.providers.find((provider) => provider.config.id === saved.activeId);
  return {
    providers: saved.providers.map((provider) => ({ config: provider.config, hasKey: !!provider.apiKey })),
    activeId: saved.activeId,
    defaultProviderIds: Object.fromEntries((["image", "video", "text"] as const).flatMap((kind) => {
      const provider = defaultProvider(saved, kind);
      return provider ? [[kind, provider.config.id]] : [];
    })),
    config: active?.config ?? DEFAULT_PROVIDER_CONFIG,
    hasKey: !!active?.apiKey,
    ready: saved.providers.some((provider) => !!provider.config.baseUrl),
  };
}

export function saveProviderSettings(config: ProviderConfig, apiKey?: string): void {
  const saved = registry();
  const index = saved.providers.findIndex((provider) => provider.config.id === config.id);
  const provider = { config, apiKey: apiKey !== undefined ? apiKey.trim() : index >= 0 ? saved.providers[index].apiKey : "" };
  if (index >= 0) saved.providers[index] = provider;
  else saved.providers.push(provider);
  if (!saved.activeId) saved.activeId = config.id;
  setSetting("custom_provider_registry", JSON.stringify(saved));
}

export function activateProvider(id: string, kind?: ProviderModelKind): void {
  const saved = registry();
  const provider = saved.providers.find((provider) => provider.config.id === id);
  if (!provider) throw new Error("供应商不存在。");
  if (kind) {
    if (!provider.config.models.some((model) => model.enabled && model.kind === kind)) throw new Error("请先为此供应商添加并启用当前类型的模型。");
    saved.defaultProviderIds = { ...saved.defaultProviderIds, [kind]: id };
  } else saved.activeId = id;
  setSetting("custom_provider_registry", JSON.stringify(saved));
}

export function deleteProviderSettings(id?: string): void {
  const saved = registry();
  const target = id ?? saved.activeId;
  saved.providers = saved.providers.filter((provider) => provider.config.id !== target);
  saved.defaultProviderIds = Object.fromEntries(Object.entries(saved.defaultProviderIds ?? {}).filter(([, providerId]) => providerId !== target));
  if (saved.activeId === target) saved.activeId = saved.providers[0]?.config.id ?? null;
  setSetting("custom_provider_registry", JSON.stringify(saved));
}
