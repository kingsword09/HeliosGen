import { IMAGE_MODELS, VIDEO_MODELS, type ImageModel, type VideoModel } from "./modelConfig";
import { MODEL_GROUPS, type ModelGroup } from "./models";
import { providerModelId, type ProviderModelKind } from "./providerModelConfig";
import type { ProviderConfig, PublicProviderSettings } from "./providerConfig";

export function buildModelCatalog(source?: ProviderConfig | PublicProviderSettings, imageBackendIds: string[] = []) {
  const settings = source && "providers" in source ? source : undefined;
  const providers = settings ? settings.providers.map((provider) => provider.config) : source ? [source as ProviderConfig] : [];
  const entries = providers.flatMap((config) => config.models.filter((model) => model.enabled).map((model) => ({ config, model })));
  const preference = ({ config, model }: typeof entries[number]) => {
    const defaultProviderId = settings?.defaultProviderIds[model.kind];
    const defaultModelId = config[model.kind === "text" ? "chatModel" : model.kind === "image" ? "imageModel" : "videoModel"];
    return Number(!defaultProviderId || config.id === defaultProviderId) * 2 + Number(model.apiId === defaultModelId);
  };
  entries.sort((first, second) => preference(second) - preference(first));
  const imageModels: ImageModel[] = [];
  const videoModels: VideoModel[] = [];
  const textGroups = new Map<string, ModelGroup>();
  const label = (config: ProviderConfig) => providers.filter((provider) => provider.name === config.name).length > 1 ? `${config.name} · ${new URL(config.baseUrl).host} · ${config.id.slice(-6)}` : config.name;
  for (const { config, model } of entries) {
    const id = providerModelId(config.id, model);
    if (model.kind === "text") {
      const group = textGroups.get(config.id) ?? { label: label(config), models: [] };
      group.models.push({ id, label: model.name, desc: model.apiId });
      textGroups.set(config.id, group);
    }
    else if (model.kind === "image") imageModels.push({
      id, apiId: model.apiId, name: model.name, provider: label(config),
      ratios: model.ratios, supportsImages: model.maxImages > 0, maxImages: model.maxImages,
      supportsQuality: model.qualityOptions.length > 0, defaultQuality: model.qualityOptions[0],
      apiInput: { aspectRatioKey: "aspect_ratio", imageInputKey: "image_urls", qualityKey: "quality", qualityOptions: model.qualityOptions, promptMaxLength: model.promptMaxLength },
    });
    else videoModels.push({
      id, apiId: model.apiId, name: model.name, provider: label(config),
      ratios: model.ratios, defaultRatio: model.ratios[0], durations: model.durations, defaultDuration: model.durations[0] ?? 5,
      handles: model.handles, sound: model.sound, resolutions: model.resolutions.length ? model.resolutions : undefined, defaultResolution: model.resolutions[0],
      maxResources: model.maxImages, apiInput: { durationMin: model.durations[0] ?? 0, durationMax: model.durations[model.durations.length - 1] ?? 1200, promptMaxLength: model.promptMaxLength },
      maxReferenceVideos: model.maxReferenceVideos, maxReferenceAudios: model.maxReferenceAudios,
    });
  }
  if (settings) {
    const backendModels = IMAGE_MODELS.filter((model) => imageBackendIds.includes(model.id));
    const emptyImage: ImageModel = { id: "custom-image", apiId: "custom-image", name: "请添加图片模型", provider: "未配置", ratios: ["auto"], supportsImages: false, maxImages: 0, supportsQuality: false, apiInput: { aspectRatioKey: "aspect_ratio", imageInputKey: "image_urls", qualityKey: "quality", promptMaxLength: 32000 } };
    const emptyVideo: VideoModel = { ...VIDEO_MODELS[0], name: "请添加视频模型", provider: "未配置", ratios: ["auto"], durations: [], resolutions: undefined, handles: ["prompt"], maxResources: 0, sound: false };
    const modelGroups = [...textGroups.values(), ...MODEL_GROUPS.filter((group) => group.label === "Azure")];
    if (!textGroups.size) modelGroups.unshift({ label: "未配置", models: [{ id: "custom-text", label: "请添加对话模型", desc: "在设置中添加供应商及模型" }] });
    return { ready: true, IMAGE_MODELS: imageModels.length || backendModels.length ? [...imageModels, ...backendModels] : [emptyImage], VIDEO_MODELS: videoModels.length ? videoModels : [emptyVideo], MODEL_GROUPS: modelGroups, MODELS: modelGroups.flatMap((group) => group.models) };
  }
  const hasModels = (kind: ProviderModelKind) => entries.some((entry) => entry.model.kind === kind);
  const presets = MODEL_GROUPS.map((group) => ({ ...group, models: group.models.filter((model) => !hasModels("text") || model.id !== "custom-text") })).filter((group) => group.models.length);
  const modelGroups = [...textGroups.values(), ...presets];
  return {
    ready: source !== undefined,
    IMAGE_MODELS: [...imageModels, ...IMAGE_MODELS.filter((model) => !imageModels.length || model.id !== "custom-image")],
    VIDEO_MODELS: [...videoModels, ...VIDEO_MODELS.filter((model) => !videoModels.length || model.id !== "custom-video")],
    MODEL_GROUPS: modelGroups, MODELS: modelGroups.flatMap((group) => group.models),
  };
}
