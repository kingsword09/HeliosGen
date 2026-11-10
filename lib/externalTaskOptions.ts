export interface TaskParameterChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

const QUALITY_LABELS: Record<string, string> = { auto: "自动", standard: "标准", low: "低", medium: "中", high: "高", hd: "高清" };

export function taskParameterChoices(allowed: string[], current: string, kind: "ratio" | "quality"): TaskParameterChoice[] {
  const choices: TaskParameterChoice[] = [...new Set(allowed)].map((value) => ({ value, label: kind === "quality" ? QUALITY_LABELS[value] ?? value : value === "auto" ? "自动" : value }));
  if (current && !allowed.includes(current)) {
    if (!choices.length) choices.push({ value: "", label: "模型默认" });
    choices.push({ value: current, label: `${current} · 已不支持`, disabled: true });
  }
  return choices;
}

export function selectedTaskParameter(allowed: string[], current: string): string {
  return current || allowed[0] || "";
}

export function taskValidation(draft: GenerationParameters, model?: ExternalImageModel): string {
  return !draft.prompt.trim() ? "请填写提示词" : !model ? "请选择可用的图片模型" : draft.prompt.length > model.promptMaxLength ? "提示词超过该模型的长度限制" : draft.aspectRatio && !model.ratios.includes(draft.aspectRatio) ? "请选择该模型支持的比例" : draft.quality && !model.qualityOptions.includes(draft.quality) ? "请选择该模型支持的质量" : draft.referenceIds.length > Math.min(14, model.maxImages) ? "参考图数量超过所选模型的限制，请移除多余参考图" : "";
}
import type { ExternalImageModel, GenerationParameters } from "./integrations";
