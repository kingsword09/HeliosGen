import { MODEL_PARAMETER_PRESETS } from "./modelParameterPresets";

export type ProviderModelKind = "image" | "text" | "video";
export type ModelProtocol = "openai" | "responses" | "gemini" | "anthropic" | "task";
export interface ProviderModelConnection {
  protocol?: ModelProtocol;
  basePath?: string;
  generatePath?: string;
  editsPath?: string;
  statusPath?: string;
  uploadPath?: string;
  uploadResultPath?: string;
  taskIdPath?: string;
  taskStatePath?: string;
  taskOutputPath?: string;
  authMode?: "provider" | "bearer" | "gemini" | "anthropic" | "custom";
  authHeader?: string;
  authPrefix?: string;
  body?: Record<string, unknown> | null;
}
export const MODEL_VIDEO_HANDLES = ["prompt", "startFrame", "endFrame", "resource", "videoRef", "referenceVideo", "audioRef"] as const;

export interface ProviderModel {
  id: string;
  apiId: string;
  name: string;
  kind: ProviderModelKind;
  enabled: boolean;
  ratios: string[];
  qualityOptions: string[];
  maxImages: number;
  maxReferenceVideos: number;
  maxReferenceAudios: number;
  promptMaxLength: number;
  durations: number[];
  resolutions: string[];
  handles: Array<(typeof MODEL_VIDEO_HANDLES)[number]>;
  sound: boolean;
  sizeMap: Record<string, string>;
  parameterKeys: Partial<Record<"aspectRatio" | "quality" | "duration" | "resolution" | "sound" | "maxOutputTokens", string>>;
  extraBody: Record<string, unknown>;
  maxOutputTokens: number | null;
  connection?: ProviderModelConnection;
  parameterProtocol?: ModelProtocol;
  parameterPreset?: string;
}

export function modelProtocols(kind: ProviderModelKind): ModelProtocol[] {
  return kind === "image" ? ["openai", "gemini", "task"] : kind === "text" ? ["openai", "responses", "gemini", "anthropic"] : ["task"];
}

export function validateModelConnection(value: unknown, kind: ProviderModelKind): ProviderModelConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型接口设置必须是对象。");
  const input = value as Record<string, unknown>;
  const connection: ProviderModelConnection = {};
  const keys = ["protocol", "basePath", "generatePath", "editsPath", "statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath", "authMode", "authHeader", "authPrefix", "body"];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("模型接口设置包含不支持的字段；API Key 请保存在供应商连接中。");
  if (input.protocol !== undefined) {
    if (!modelProtocols(kind).includes(input.protocol as ModelProtocol)) throw new Error("此模型类型不支持所选接口方式。");
    connection.protocol = input.protocol as ModelProtocol;
  }
  for (const field of ["basePath", "generatePath", "editsPath", "statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath", "authHeader", "authPrefix"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 2000 || /[\r\n]/.test(value)) throw new Error(`模型接口 ${field} 必须是有效字符串。`);
    connection[field] = field === "authPrefix" ? value : value.trim();
  }
  for (const field of ["basePath", "generatePath", "editsPath", "statusPath", "uploadPath"] as const) {
    const path = connection[field];
    if (path === undefined) continue;
    if (/^[a-z]+:/i.test(path) || path.startsWith("//") || path.includes("\\") || path.includes("#")) throw new Error("模型接口只能使用同一供应商下的路径，不能填写其他域名。");
    if (field === "basePath") {
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { throw new Error("接口前缀包含无效编码。"); }
      if (!path.startsWith("/") || /[?#\\]/.test(decoded) || decoded.startsWith("//") || decoded.split("/").some((part) => part === "." || part === "..")) throw new Error("接口前缀请填写 /v1、/v1beta 等绝对路径，不要包含域名、查询参数或上级目录。");
    }
  }
  if (input.authMode !== undefined) {
    if (!["provider", "bearer", "gemini", "anthropic", "custom"].includes(String(input.authMode))) throw new Error("不支持的模型认证方式。");
    connection.authMode = input.authMode as ProviderModelConnection["authMode"];
  }
  if (connection.authHeader !== undefined && !/^[!#$%&'*+.^_`|~\w-]+$/.test(connection.authHeader)) throw new Error("认证请求头名称无效。");
  if (connection.authMode === "custom" && !connection.authHeader) throw new Error("请填写自定义认证请求头名称。");
  if (input.body !== undefined) {
    if (input.body !== null && (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || JSON.stringify(input.body).length > 32000)) throw new Error("模型任务请求模板必须是 JSON 对象或 null（最多 32000 字符）。");
    connection.body = input.body as Record<string, unknown> | null;
  }
  if (kind === "text" && ["editsPath", "statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath", "body"].some((key) => input[key] !== undefined)) throw new Error("对话接口不支持图片编辑或异步任务设置。");
  if (kind === "video" && input.editsPath !== undefined) throw new Error("视频接口不支持图片编辑路径。");
  return connection;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  suggestedKind: ProviderModelKind | null;
}

export interface OnlineModel {
  id: string;
  apiId: string;
  name: string;
  provider: string;
  kind: ProviderModelKind;
  inputs: string[];
  outputs: string[];
  source: "vercel" | "models.dev";
}

export interface OnlineModelCatalog {
  models: OnlineModel[];
  updatedAt: string;
  sources: string[];
  stale: boolean;
  notice: string;
}

export function newProviderModel(kind: ProviderModelKind, apiId = "", name = apiId): ProviderModel {
  return {
    id: `model-${crypto.randomUUID()}`, apiId, name, kind, enabled: true,
    ratios: ["auto"],
    qualityOptions: [], maxImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, promptMaxLength: 32000,
    durations: [], resolutions: [], handles: ["prompt"], sound: false,
    sizeMap: {}, parameterKeys: {}, extraBody: {}, maxOutputTokens: null,
  };
}

export function validateProviderModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Models must be an array of at most 1000 entries.");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each model must be an object.");
    const input = entry as Record<string, unknown>;
    if (!["image", "text", "video"].includes(String(input.kind))) throw new Error("Model type must be image, text, or video.");
    const model = newProviderModel(input.kind as ProviderModelKind);
    for (const key of ["id", "apiId", "name"] as const) {
      if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 300) throw new Error(`Model ${key} is required (maximum 300 characters).`);
      model[key] = input[key].trim();
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(model.id) || ids.has(model.id)) throw new Error("Model IDs must be unique and contain only letters, numbers, underscores, or hyphens.");
    ids.add(model.id);
    if (input.connection !== undefined) model.connection = validateModelConnection(input.connection, model.kind);
    if (input.parameterProtocol !== undefined) {
      if (!modelProtocols(model.kind).includes(input.parameterProtocol as ModelProtocol)) throw new Error("模型参数所属接口无效。");
      model.parameterProtocol = input.parameterProtocol as ModelProtocol;
    }
    if (input.parameterPreset !== undefined) {
      if (typeof input.parameterPreset !== "string" || !["auto", "custom", ...MODEL_PARAMETER_PRESETS.filter((preset) => preset.kind === model.kind).map((preset) => preset.id)].includes(input.parameterPreset)) throw new Error("模型参数预设无效。");
      model.parameterPreset = input.parameterPreset;
    }
    for (const key of ["enabled", "sound"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Model ${key} must be a boolean.`);
      if (input[key] !== undefined) model[key] = input[key] as boolean;
    }
    for (const key of ["ratios", "qualityOptions", "resolutions", "handles"] as const) {
      if (input[key] === undefined) continue;
      const values = input[key];
      if (!Array.isArray(values) || values.length > 50 || values.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) throw new Error(`Model ${key} must be a list of nonempty strings.`);
      Object.assign(model, { [key]: [...new Set(values.map((item: string) => item.trim()))] });
    }
    if (!model.ratios.length || model.ratios.some((ratio) => !/^(auto|[1-9]\d*:[1-9]\d*)$/i.test(ratio))) throw new Error("Model aspect ratios must be auto or positive ratios such as 16:9.");
    if (model.handles.some((handle) => !MODEL_VIDEO_HANDLES.includes(handle)) || !model.handles.includes("prompt")) throw new Error("Video handles must include prompt and use supported handle names.");
    model.maxReferenceVideos = model.handles.includes("referenceVideo") ? 1 : 0;
    model.maxReferenceAudios = model.handles.includes("audioRef") ? 1 : 0;
    for (const [key, minimum, maximum] of [["maxImages", 0, 50], ["maxReferenceVideos", 0, 50], ["maxReferenceAudios", 0, 50], ["promptMaxLength", 1, 1000000]] as const) {
      const number = input[key] ?? model[key];
      if (typeof number !== "number" || !Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`Model ${key} must be an integer between ${minimum} and ${maximum}.`);
      model[key] = number;
    }
    if ((model.handles.includes("referenceVideo") && !model.maxReferenceVideos) || (model.handles.includes("audioRef") && !model.maxReferenceAudios)) throw new Error("启用参考视频或音频后，需设置至少 1 个参考文件的数量上限。");
    if (input.durations !== undefined) {
      if (!Array.isArray(input.durations) || input.durations.length > 50 || input.durations.some((duration) => typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > 1200)) throw new Error("Video durations must be a list of seconds between 0 and 1200 (empty disables this parameter).");
      model.durations = [...new Set(input.durations as number[])].sort((first, second) => first - second);
    }
    if (input.sizeMap !== undefined) {
      if (!input.sizeMap || typeof input.sizeMap !== "object" || Array.isArray(input.sizeMap)) throw new Error("Size mappings must be an object.");
      const entries = Object.entries(input.sizeMap);
      if (entries.length > 50 || entries.some(([ratio, size]) => !/^(auto|[1-9]\d*:[1-9]\d*)$/.test(ratio) || typeof size !== "string" || !/^(auto|[1-9]\d*x[1-9]\d*)$/.test(size))) throw new Error("Size mappings must map aspect ratios to sizes such as 1024x1024.");
      model.sizeMap = Object.fromEntries(entries) as Record<string, string>;
      for (const [ratio, size] of entries) {
        if (ratio === "auto") continue;
        const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
        const [width, height] = (size as string).split("x").map(Number);
        if (![ratioWidth, ratioHeight, width, height].every(Number.isSafeInteger) || width * ratioHeight !== height * ratioWidth) throw new Error(`尺寸 ${size} 与比例 ${ratio} 不匹配，请填写真实比例，不要将其他尺寸当成该比例。`);
      }
    }
    if (input.parameterKeys !== undefined) {
      if (!input.parameterKeys || typeof input.parameterKeys !== "object" || Array.isArray(input.parameterKeys)) throw new Error("Parameter names must be an object.");
      const entries = Object.entries(input.parameterKeys);
      if (entries.some(([key, name]) => !["aspectRatio", "quality", "duration", "resolution", "sound", "maxOutputTokens"].includes(key) || typeof name !== "string" || !/^[a-zA-Z][\w-]{0,99}$/.test(name))) throw new Error("Parameter names must use supported keys and simple upstream field names.");
      if (entries.some(([, name]) => ["model", "prompt", "messages", "stream", "contents", "system", "generationConfig"].includes(name as string)) || new Set(entries.map(([, name]) => name)).size !== entries.length) throw new Error("自定义参数名不能覆盖模型、提示词等必需字段，也不能重复。");
      model.parameterKeys = Object.fromEntries(entries);
    }
    if (input.extraBody !== undefined) {
      if (!input.extraBody || typeof input.extraBody !== "object" || Array.isArray(input.extraBody) || JSON.stringify(input.extraBody).length > 32000) throw new Error("Extra request parameters must be a JSON object of at most 32000 characters.");
      model.extraBody = input.extraBody as Record<string, unknown>;
    }
    if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
      if (typeof input.maxOutputTokens !== "number" || !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 1000000) throw new Error("Maximum output tokens must be an integer between 1 and 1000000.");
      model.maxOutputTokens = input.maxOutputTokens;
    }
    return model;
  });
}

export function providerModelId(providerId: string, model: Pick<ProviderModel, "id">): string {
  return `provider-model:${providerId}:${model.id}`;
}
