export type ImageProtocol = "openai" | "gemini" | "task";
export type ChatProtocol = "openai" | "responses" | "gemini" | "anthropic";

export const DEFAULT_CHAT_PATHS: Record<ChatProtocol, string> = {
  openai: "chat/completions",
  responses: "responses",
  gemini: "models/{model}:streamGenerateContent?alt=sse",
  anthropic: "messages",
};

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  imageProtocol: ImageProtocol;
  chatProtocol: ChatProtocol;
  imageModel: string;
  chatModel: string;
  videoModel: string;
  models: ProviderModel[];
  modelsPath: string;
  modelsProtocol: "auto" | "openai" | "gemini" | "anthropic";
  modelsResultPath: string;
  imagesPath: string;
  editsPath: string;
  chatPath: string;
  videoPath: string;
  statusPath: string;
  uploadPath: string;
  uploadResultPath: string;
  taskIdPath: string;
  taskStatePath: string;
  taskOutputPath: string;
  authHeader: string;
  authPrefix: string;
  timeoutSeconds: number;
  modelMap: Record<string, string>;
  imageBody: Record<string, unknown> | null;
  videoBody: Record<string, unknown> | null;
}

export interface PublicProvider {
  config: ProviderConfig;
  hasKey: boolean;
}

export interface PublicProviderSettings {
  providers: PublicProvider[];
  defaultProviderIds: Partial<Record<ProviderModel["kind"], string>>;
  activeId: string | null;
  config: ProviderConfig;
  hasKey: boolean;
  ready: boolean;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  id: "provider-default",
  name: "Custom Provider",
  baseUrl: "",
  imageProtocol: "openai",
  chatProtocol: "openai",
  imageModel: "",
  chatModel: "",
  videoModel: "",
  models: [],
  modelsPath: "models",
  modelsProtocol: "auto",
  modelsResultPath: "",
  imagesPath: "images/generations",
  editsPath: "images/edits",
  chatPath: "chat/completions",
  videoPath: "videos",
  statusPath: "tasks/{id}",
  uploadPath: "",
  uploadResultPath: "url",
  taskIdPath: "id",
  taskStatePath: "status",
  taskOutputPath: "output",
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  timeoutSeconds: 720,
  modelMap: {},
  imageBody: null,
  videoBody: null,
};

export function validateProviderConfig(value: unknown): ProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider configuration must be an object.");
  }
  const input = value as Record<string, unknown>;
  const config = { ...DEFAULT_PROVIDER_CONFIG };
  for (const key of Object.keys(DEFAULT_PROVIDER_CONFIG) as Array<keyof ProviderConfig>) {
    const field = input[key];
    if (field === undefined) continue;
    if (["models", "modelMap", "imageBody", "videoBody", "timeoutSeconds"].includes(key)) continue;
    if (typeof field !== "string") throw new Error(`${key} must be a string.`);
    Object.assign(config, { [key]: key === "authPrefix" ? field : field.trim() });
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.id)) throw new Error("Provider ID must contain only letters, numbers, underscores, or hyphens.");
  if (config.baseUrl) {
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Base URL must be an HTTP(S) URL without credentials, query parameters, or fragments.");
    }
    config.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }
  if (!["openai", "gemini", "task"].includes(config.imageProtocol)) throw new Error("Unsupported image protocol.");
  if (!["openai", "responses", "gemini", "anthropic"].includes(config.chatProtocol)) throw new Error("Unsupported chat protocol.");
  if (input.chatPath === undefined) config.chatPath = DEFAULT_CHAT_PATHS[config.chatProtocol];
  if (!["auto", "openai", "gemini", "anthropic"].includes(config.modelsProtocol)) throw new Error("Unsupported model-list protocol.");
  config.models = validateProviderModels(input.models ?? []);
  for (const [kind, field] of [["image", "imageModel"], ["text", "chatModel"], ["video", "videoModel"]] as const) {
    const legacyId = config[field];
    if (legacyId && !config.models.some((model) => model.kind === kind && model.apiId === legacyId)) {
      const model = newProviderModel(kind, legacyId);
      model.id = `legacy-${kind}`;
      while (config.models.some((entry) => entry.id === model.id)) model.id += "-default";
      config.models.push(model);
    }
  }
  config.models = config.models.map((model) => resolveModelParameters(model, model.connection?.protocol ?? (model.kind === "image" ? config.imageProtocol : model.kind === "text" ? config.chatProtocol : "task")));
  Object.assign(config, withProviderModels(config, config.models));
  for (const model of config.models) model.parameterProtocol ??= model.connection?.protocol ?? (model.kind === "image" ? config.imageProtocol : model.kind === "text" ? config.chatProtocol : "task");
  for (const key of ["modelsPath", "imagesPath", "editsPath", "chatPath", "videoPath", "statusPath", "uploadPath"] as const) {
    const path = config[key];
    if (path && (/^[a-z]+:/i.test(path) || path.startsWith("//") || path.includes("\\"))) {
      throw new Error(`${key} must be a relative path on the configured provider.`);
    }
  }
  if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(config.authHeader) || /[\r\n]/.test(config.authPrefix)) {
    throw new Error("Invalid authentication header.");
  }
  if (input.timeoutSeconds !== undefined) {
    const seconds = input.timeoutSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 5 || seconds > 1200) {
      throw new Error("Timeout must be between 5 and 1200 seconds.");
    }
    config.timeoutSeconds = seconds;
  }
  if (input.modelMap !== undefined) {
    if (!input.modelMap || typeof input.modelMap !== "object" || Array.isArray(input.modelMap)) throw new Error("modelMap must be an object.");
    const entries = Object.entries(input.modelMap);
    if (entries.some(([, model]) => typeof model !== "string" || !model.trim())) throw new Error("Model mappings must contain nonempty model IDs.");
    config.modelMap = Object.fromEntries(entries.map(([alias, model]) => [alias, (model as string).trim()]));
  }
  for (const key of ["imageBody", "videoBody"] as const) {
    const template = input[key];
    if (template === undefined) continue;
    if (template !== null && (typeof template !== "object" || Array.isArray(template))) throw new Error(`${key} must be an object or null.`);
    config[key] = template as Record<string, unknown> | null;
  }
  return config;
}

export function resolveProviderModel(config: ProviderConfig, kind: "image" | "chat" | "video", selected: string): string {
  if (selected.startsWith("provider-model:")) {
    const custom = config.models?.find((model) => providerModelId(config.id, model) === selected);
    if (!custom?.enabled || custom.kind !== (kind === "chat" ? "text" : kind)) throw new Error("This model is unavailable for the active provider. Select a model again or enable it in Settings.");
    return custom.apiId;
  }
  const mapped = Object.hasOwn(config.modelMap, selected) ? config.modelMap[selected] : undefined;
  const model = mapped || (selected === `custom-${kind === "chat" ? "text" : kind}` ? config[`${kind}Model`] : selected);
  if (!model) throw new Error(`请先在设置的${kind === "image" ? "图片" : kind === "video" ? "视频" : "对话"}模型页面添加模型。`);
  const definitions = config.models.filter((entry) => entry.kind === (kind === "chat" ? "text" : kind) && entry.apiId === model);
  if (definitions.length && !definitions.some((entry) => entry.enabled)) throw new Error("此模型已停用，请在对应模型页面启用或选择其他模型。");
  return model;
}

export function withProviderModels(config: ProviderConfig, models: ProviderModel[]): ProviderConfig {
  const next = { ...config, models };
  for (const [kind, field] of [["image", "imageModel"], ["text", "chatModel"], ["video", "videoModel"]] as const) {
    const available = models.filter((model) => model.kind === kind && model.enabled);
    next[field] = available.find((model) => model.apiId === config[field])?.apiId ?? available[0]?.apiId ?? "";
  }
  return next;
}

export function getProviderModelDefinition(config: ProviderConfig, kind: "image" | "video" | "chat", selected: string): ProviderModel | undefined {
  const apiId = resolveProviderModel(config, kind, selected);
  const modelKind = kind === "chat" ? "text" : kind;
  const configured = config.models.find((model) => model.enabled && model.kind === modelKind && (selected.startsWith("provider-model:") ? providerModelId(config.id, model) === selected : model.apiId === apiId));
  if (configured) return configured;
  if (kind === "image" && config.imageProtocol === "openai" && ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"].includes(apiId)) {
    return resolveModelParameters({ ...newProviderModel("image", apiId), id: `preset-${apiId.replaceAll(".", "-")}`, parameterPreset: "auto" }, "openai");
  }
  return undefined;
}
import { newProviderModel, providerModelId, validateProviderModels, type ProviderModel } from "./providerModelConfig";
import { resolveModelParameters } from "./modelParameterPresets";
