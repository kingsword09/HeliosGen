import { DEFAULT_PROVIDER_CONFIG, getProviderModelDefinition, type ProviderConfig } from "./providerConfig";
import type { ModelProtocol, ProviderModel, ProviderModelConnection, ProviderModelKind } from "./providerModelConfig";

export interface EffectiveProviderConfig extends ProviderConfig {
  requestConnection?: ProviderModelConnection;
}

export const MODEL_PROTOCOL_LABELS: Record<ModelProtocol, string> = { openai: "OpenAI 兼容", gemini: "Gemini 原生", anthropic: "Anthropic 原生", task: "异步任务" };

export function providerModelProtocol(config: ProviderConfig, model: Pick<ProviderModel, "kind" | "connection">): ModelProtocol {
  return model.connection?.protocol ?? (model.kind === "image" ? config.imageProtocol : model.kind === "text" ? config.chatProtocol : "task");
}

export function resolveModelConnection(config: ProviderConfig, model: ProviderModel): EffectiveProviderConfig {
  const connection = model.connection;
  const protocol = providerModelProtocol(config, model);
  const inherited = providerModelProtocol(config, { kind: model.kind });
  const changed = protocol !== inherited;
  const next: EffectiveProviderConfig = { ...config, requestConnection: connection };
  if (changed && ((inherited === "gemini" && config.authHeader.toLowerCase() === "x-goog-api-key") || (inherited === "anthropic" && config.authHeader.toLowerCase() === "x-api-key"))) {
    next.authHeader = "Authorization";
    next.authPrefix = "Bearer ";
  }
  if (model.kind === "image") {
    next.imageProtocol = protocol as ProviderConfig["imageProtocol"];
    next.imagesPath = connection?.generatePath ?? (protocol === "gemini" ? "models/{model}:generateContent" : changed ? DEFAULT_PROVIDER_CONFIG.imagesPath : config.imagesPath);
    next.editsPath = connection?.editsPath ?? (changed ? DEFAULT_PROVIDER_CONFIG.editsPath : config.editsPath);
    next.imageBody = connection?.body !== undefined ? connection.body : changed ? null : config.imageBody;
  } else if (model.kind === "text") {
    next.chatProtocol = protocol as ProviderConfig["chatProtocol"];
    next.chatPath = connection?.generatePath ?? (protocol === "gemini" ? "models/{model}:streamGenerateContent?alt=sse" : changed ? protocol === "anthropic" ? "messages" : DEFAULT_PROVIDER_CONFIG.chatPath : config.chatPath);
  } else {
    next.videoPath = connection?.generatePath ?? config.videoPath;
    next.videoBody = connection?.body !== undefined ? connection.body : config.videoBody;
  }
  for (const field of ["statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath"] as const) {
    if (connection?.[field] !== undefined) next[field] = connection[field];
  }
  return next;
}

export function providerRequestConfig(config: ProviderConfig, kind: ProviderModelKind, selected: string): EffectiveProviderConfig {
  const model = getProviderModelDefinition(config, kind === "text" ? "chat" : kind, selected);
  if (!model) {
    if (kind === "image" && config.imageProtocol === "gemini") return { ...config, imagesPath: "models/{model}:generateContent" };
    if (kind === "text" && config.chatProtocol === "gemini") return { ...config, chatPath: "models/{model}:streamGenerateContent?alt=sse" };
    return config;
  }
  const protocol = providerModelProtocol(config, model);
  if (model.parameterProtocol && model.parameterProtocol !== protocol && hasModelParameters(model)) throw new Error(`模型「${model.name}」的参数仍属于 ${MODEL_PROTOCOL_LABELS[model.parameterProtocol]}，当前接口为 ${MODEL_PROTOCOL_LABELS[protocol]}。请在设置中重新确认模型参数后保存。`);
  return resolveModelConnection(config, model);
}

export function hasModelParameters(model: ProviderModel): boolean {
  return model.ratios.some((ratio) => ratio !== "auto") || model.qualityOptions.length > 0 || model.maxImages > 0 || model.durations.length > 0 || model.resolutions.length > 0 || model.sound || model.handles.some((handle) => handle !== "prompt") || model.maxOutputTokens !== null || Object.keys(model.parameterKeys).length > 0 || Object.keys(model.extraBody).length > 0;
}

export function modelRequestUrl(config: EffectiveProviderConfig, path: string, model = "", id = ""): string {
  const base = new URL(`${config.baseUrl.replace(/\/+$/, "")}/`);
  if (config.requestConnection?.basePath !== undefined) base.pathname = `${config.requestConnection.basePath.replace(/\/+$/, "")}/`;
  const url = new URL(path.replace(/\{model\}/g, encodeURIComponent(model)).replace(/\{id\}/g, encodeURIComponent(id)).replace(/^\/+/, ""), base);
  if (url.origin !== base.origin) throw new Error("Provider endpoints must use the configured origin.");
  return url.toString();
}
