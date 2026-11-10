import { IMAGE_MODELS, VIDEO_MODELS } from "./modelConfig";
import type { ModelProtocol, ProviderModel, ProviderModelKind } from "./providerModelConfig";

export const MODEL_PARAMETER_FIELDS = ["ratios", "qualityOptions", "maxImages", "maxReferenceVideos", "maxReferenceAudios", "promptMaxLength", "durations", "resolutions", "handles", "sound", "sizeMap", "parameterKeys", "extraBody", "maxOutputTokens"] as const;
type ModelParameters = Pick<ProviderModel, (typeof MODEL_PARAMETER_FIELDS)[number]>;
export interface ModelParameterPreset {
  id: string;
  name: string;
  kind: ProviderModelKind;
  protocol: ModelProtocol;
  apiIds: string[];
  parameters: Partial<ModelParameters>;
  description?: string;
  sizeAlternative?: string;
}

const standardSizes = { auto: "auto", "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
const flexibleSizes = { ...standardSizes, "16:9": "1536x864", "9:16": "864x1536", "4:3": "1536x1152", "3:4": "1152x1536" };
const openaiImages = [
  { id: "gpt-image-1", apiIds: ["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"], sizes: standardSizes, qualities: ["auto", "low", "medium", "high"], description: "旧版 GPT Image 使用标准尺寸，不将 16:9 等比例替换为近似尺寸。" },
  { id: "gpt-image-2", apiIds: ["gpt-image-2", "gpt-image-2-2026-04-21"], sizes: flexibleSizes, qualities: ["auto", "low", "medium", "high"], description: "使用自定义 size 精确表达七种比例。若兼容服务商仅接受标准尺寸，可切换标准预设。" },
  { id: "gpt-image-2.5", apiIds: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare-2026-09-08", "gpt-image-2.5-sunburst-2026-09-08"], sizes: flexibleSizes, qualities: ["auto", "low", "medium", "high", "xhigh", "max"], description: "使用自定义 size 精确表达七种比例。若兼容服务商仅接受标准尺寸，可切换标准预设。" },
  { id: "gpt-image-2.6", apiIds: ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"], sizes: standardSizes, qualities: ["auto", "low", "medium", "high"], description: "2.6 默认使用标准尺寸。普通图片的自定义尺寸支持未在官方文档中明确列出；仅在服务商确认支持自定义 size 时启用扩展比例。" },
];
const geminiRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];

export const MODEL_PARAMETER_PRESETS: ModelParameterPreset[] = [
  ...openaiImages.map((model): ModelParameterPreset => ({
    id: `openai:${model.id}`, name: `${model.id} · OpenAI 图片接口`, kind: "image", protocol: "openai",
    apiIds: model.apiIds.flatMap((apiId) => [apiId, `openai/${apiId}`]),
    parameters: { ratios: Object.keys(model.sizes), sizeMap: model.sizes, qualityOptions: model.qualities, maxImages: 16, promptMaxLength: 32000 },
    description: model.description,
    ...(model.id !== "gpt-image-1" ? { sizeAlternative: `openai:${model.id}-${model.id === "gpt-image-2.6" ? "extended" : "standard"}` } : {}),
  })),
  ...openaiImages.filter((model) => model.id !== "gpt-image-1").map((model): ModelParameterPreset => ({
    id: `openai:${model.id}-${model.id === "gpt-image-2.6" ? "extended" : "standard"}`,
    name: `${model.id} · ${model.id === "gpt-image-2.6" ? "扩展比例（需服务商支持）" : "标准尺寸（兼容受限服务商）"}`,
    kind: "image", protocol: "openai", apiIds: [],
    parameters: { ratios: Object.keys(model.id === "gpt-image-2.6" ? flexibleSizes : standardSizes), sizeMap: model.id === "gpt-image-2.6" ? flexibleSizes : standardSizes, qualityOptions: model.qualities, maxImages: 16, promptMaxLength: 32000 },
    description: model.id === "gpt-image-2.6"
      ? "兼容服务商扩展预设，不代表官方 2.6 已确认支持这些普通图片尺寸。会发送精确的 size；服务商拒绝时请切回标准尺寸，不会降级比例或自动重试生成。"
      : "仅发送标准尺寸，适合未开放自定义 size 的兼容服务商；不会将宽屏或竖屏比例映射成其他比例。",
    sizeAlternative: `openai:${model.id}`,
  })),
  { id: "gemini:flash-image", name: "Gemini 2.5 Flash Image", kind: "image", protocol: "gemini", apiIds: ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"], parameters: { ratios: geminiRatios, maxImages: 3, promptMaxLength: 32000 } },
  { id: "gemini:pro-image", name: "Gemini 3 Pro Image", kind: "image", protocol: "gemini", apiIds: ["gemini-3-pro-image-preview"], parameters: { ratios: geminiRatios, qualityOptions: ["1K", "2K", "4K"], maxImages: 14, promptMaxLength: 32000 } },
  ...IMAGE_MODELS.filter((model) => model.id !== "custom-image" && !model.id.startsWith("gpt-image-2.6")).map((model): ModelParameterPreset => ({
    id: `task:${model.id}`, name: `${model.name} · 异步任务接口`, kind: "image", protocol: "task",
    apiIds: [...new Set([model.id, model.apiId, ...(model.textOnlyApiId ? [model.textOnlyApiId] : [])])],
    parameters: {
      ratios: model.ratios, maxImages: model.maxImages, promptMaxLength: model.apiInput.promptMaxLength,
      qualityOptions: [...new Set((model.apiInput.qualityOptions ?? []).map((quality) => model.apiInput.qualityMap?.[quality] ?? quality))],
      parameterKeys: { aspectRatio: model.apiInput.aspectRatioKey, ...(model.apiInput.qualityKey ? { quality: model.apiInput.qualityKey } : {}) },
    },
  })),
  ...VIDEO_MODELS.filter((model) => model.id !== "custom-video").map((model): ModelParameterPreset => ({
    id: `task:video:${model.id}`, name: `${model.name} · 异步任务接口`, kind: "video", protocol: "task", apiIds: [...new Set([model.id, model.apiId])],
    parameters: { ratios: model.ratios.length ? model.ratios.map((ratio) => ["adaptive", "auto"].includes(ratio.toLowerCase()) ? "auto" : ratio) : ["auto"], durations: model.durations, resolutions: model.resolutions ?? [], handles: model.handles, sound: model.sound, maxImages: model.maxResources ?? 0, maxReferenceVideos: model.handles.includes("referenceVideo") ? model.maxReferenceVideos ?? 1 : 0, maxReferenceAudios: model.handles.includes("audioRef") ? model.maxReferenceAudios ?? 1 : 0, promptMaxLength: model.apiInput.promptMaxLength },
  })),
];

export function modelParameterPreset(model: Pick<ProviderModel, "apiId" | "kind" | "parameterPreset">, protocol: ModelProtocol) {
  if (model.parameterPreset === "custom") return undefined;
  return MODEL_PARAMETER_PRESETS.find((preset) => preset.kind === model.kind && preset.protocol === protocol && (model.parameterPreset && model.parameterPreset !== "auto" ? preset.id === model.parameterPreset : preset.apiIds.includes(model.apiId.trim())));
}

export function resolveModelParameters(model: ProviderModel, protocol: ModelProtocol): ProviderModel {
  const empty: ModelParameters = { ratios: ["auto"], qualityOptions: [], maxImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, promptMaxLength: 32000, durations: [], resolutions: [], handles: ["prompt"], sound: false, sizeMap: {}, parameterKeys: {}, extraBody: {}, maxOutputTokens: null };
  const unconfigured = MODEL_PARAMETER_FIELDS.every((key) => JSON.stringify(model[key]) === JSON.stringify(empty[key]));
  const source = model.parameterPreset ?? (unconfigured ? "auto" : "custom");
  if (source === "custom") return { ...model, parameterPreset: source };
  const preset = modelParameterPreset({ ...model, parameterPreset: source }, protocol);
  if (!preset && source !== "auto") throw new Error("所选参数预设不支持当前模型类型或接口，请重新选择。");
  return { ...model, ...structuredClone(empty), ...structuredClone(preset?.parameters ?? {}), parameterPreset: source, parameterProtocol: protocol };
}
