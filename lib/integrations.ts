export interface ExternalJob {
  jobId: string;
  clientId: string;
  requestId: string;
  status: "awaiting_approval" | "approved" | "launching" | "pending" | "done" | "error" | "rejected";
  prompt: string;
  modelId: string;
  aspectRatio: string;
  quality: string;
  referenceUrls: string[];
  referenceIds?: string[];
  originalRequest?: Partial<GenerationParameters>;
  configurationEdited?: boolean;
  approvedAt?: string | null;
  inboxDismissed?: boolean;
  source: { name?: string; rexSessionId?: string; rexBlockId?: string };
  createdAt: string;
  error?: string;
  outputs?: Array<{ assetId: string; url: string; index: number }>;
}

export interface GenerationParameters {
  prompt: string;
  modelId: string;
  aspectRatio: string;
  quality: string;
  referenceIds: string[];
}

export interface ExternalImageModel {
  id: string;
  name: string;
  providerName: string;
  ratios: string[];
  qualityOptions: string[];
  maxImages: number;
  promptMaxLength: number;
}

export interface ExternalConnection {
  id: string;
  name: string;
  autoApprove: boolean;
}

export interface IntegrationOverview {
  enabled: boolean;
  installedAgents: string[];
  clients: ExternalConnection[];
  jobs: ExternalJob[];
  endpoint: string;
  models: ExternalImageModel[];
  dismissedJobIds?: string[];
}

export async function importTaskReference(jobId: string, file: File): Promise<{ assetId: string; url: string }> {
  if (file.size > 50 * 1024 * 1024) throw new Error("参考图不能超过 50 MiB");
  const response = await fetch(`/api/settings/integrations/reference?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "X-Helios-UI": "1", "Content-Type": "application/octet-stream" },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "导入参考图失败");
  return result;
}

export async function integrationSettings<T = IntegrationOverview>(action?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/settings/integrations", {
    method: action ? "POST" : "GET",
    headers: { "X-Helios-UI": "1", ...(action ? { "Content-Type": "application/json" } : {}) },
    ...(action ? { body: JSON.stringify(action) } : {}),
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "外部互联请求失败");
  return result;
}
