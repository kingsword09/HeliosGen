import { getProviderModelDefinition, type ProviderConfig } from "./providerConfig";
import type { GenerationInput } from "./customProvider";

export function prepareProviderGeneration(config: ProviderConfig, kind: "image" | "video", input: GenerationInput): GenerationInput {
  const definition = getProviderModelDefinition(config, kind, input.model);
  if (!definition) return input;
  const next = { ...input, prompt: input.prompt.slice(0, definition.promptMaxLength) };
  function choice<Key extends "aspectRatio" | "quality" | "resolution">(key: Key, values: string[]) {
    if (!values.length || (key === "aspectRatio" && values.every((value) => value === "auto"))) {
      delete next[key];
      return;
    }
    if (next[key] !== undefined && !values.includes(next[key]!)) throw new Error(`模型「${definition!.name}」不支持 ${key}=${next[key]}，支持的值：${values.join(", ")}。`);
    next[key] ??= values[0];
  }
  choice("aspectRatio", definition.ratios);
  if ((next.imageUrls?.length ?? 0) > definition.maxImages) throw new Error(`模型「${definition.name}」最多支持 ${definition.maxImages} 张参考图片。`);
  if (kind === "image") {
    choice("quality", definition.qualityOptions);
    delete next.duration;
    delete next.resolution;
    delete next.sound;
  } else {
    delete next.quality;
    if (definition.durations.length) {
      if (next.duration !== undefined && !definition.durations.includes(next.duration)) throw new Error(`模型「${definition.name}」仅支持这些时长：${definition.durations.join(", ")} 秒。`);
      next.duration ??= definition.durations[0];
    } else delete next.duration;
    choice("resolution", definition.resolutions);
    if (!definition.sound) delete next.sound;
    if ((next.referenceVideoUrls?.length ?? 0) > definition.maxReferenceVideos) throw new Error(`模型「${definition.name}」最多支持 ${definition.maxReferenceVideos} 个参考视频。`);
    if ((next.referenceAudioUrls?.length ?? 0) > definition.maxReferenceAudios) throw new Error(`模型「${definition.name}」最多支持 ${definition.maxReferenceAudios} 个参考音频。`);
    const handles = definition.handles;
    for (const [field, handle] of [["startFrameUrl", "startFrame"], ["endFrameUrl", "endFrame"], ["videoRefUrl", "videoRef"], ["referenceVideoUrls", "referenceVideo"], ["referenceAudioUrls", "audioRef"], ["imageUrls", "resource"]] as const) {
      const value = next[field];
      if ((Array.isArray(value) ? value.length > 0 : !!value) && !handles.includes(handle)) throw new Error(`模型「${definition.name}」未启用 ${handle} 输入，请检查模型支持的参数。`);
      if (!handles.includes(handle)) delete next[field];
    }
  }
  return next;
}
