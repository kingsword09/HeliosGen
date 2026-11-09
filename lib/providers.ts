// ─────────────────────────────────────────────────────────────────────────────
// PROVIDERS — single source of truth for per-model backend selection
// (Custom Provider / Azure Foundry / Codex CLI), shared by the Settings modal, the
// workflow GenerateNode, and the gallery generation composer.
// ─────────────────────────────────────────────────────────────────────────────
import { IMAGE_MODELS } from "@/lib/modelConfig";

export const PROVIDERS = [
  { id: "custom",   label: "Custom Provider" },
  { id: "azure", label: "Azure Foundry" },
  { id: "codex", label: "Codex CLI" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

const STORAGE_KEY = "aiui-model-providers";

export function loadModelProviders(): Record<string, ProviderId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const normalized = Object.fromEntries(Object.entries(parsed).map(([model, provider]) => [
      model, PROVIDERS.some((entry) => entry.id === provider) ? provider : "custom",
    ])) as Record<string, ProviderId>;
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return {};
  }
}

export function saveModelProviders(map: Record<string, ProviderId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent("aiui-providers-changed"));
  } catch { /* noop */ }
}

export function getModelProvider(modelId: string): ProviderId {
  return loadModelProviders()[modelId] ?? "custom";
}

/** Persists the backend for a single model, leaving the others untouched. */
export function setModelProvider(modelId: string, provider: ProviderId) {
  const map = loadModelProviders();
  saveModelProviders({ ...map, [modelId]: provider });
}

/**
 * Models with more than one backend to choose from. Both Azure and Codex are
 * image-only, and Azure additionally needs a per-model deployment configured.
 */
const MULTI_PROVIDER_MODEL_IDS = new Set(
  IMAGE_MODELS.filter((m) => !!m.azureSizeMap).map((m) => m.id),
);

export function modelHasProviderChoice(modelId: string): boolean {
  return MULTI_PROVIDER_MODEL_IDS.has(modelId);
}
