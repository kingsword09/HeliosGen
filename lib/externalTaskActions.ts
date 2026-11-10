import { integrationSettings, type ExternalJob, type GenerationParameters } from "./integrations";
import { isProcessedTask, taskDraft, useExternalTaskStore } from "./externalTaskStore";
import { taskValidation } from "./externalTaskOptions";

export async function reviewExternalTask(job: ExternalJob, action: "approve" | "reject", parameters?: GenerationParameters): Promise<void> {
  const store = useExternalTaskStore.getState();
  if (store.busyJobId || job.status !== "awaiting_approval") return;
  const draft = parameters ?? store.drafts[job.jobId] ?? taskDraft(job);
  if (action === "approve") {
    const model = store.overview?.models.find((entry) => entry.id === draft.modelId);
    const validation = taskValidation(draft, model);
    if (validation) { store.setError(job.jobId, validation); return; }
  }
  store.setBusyJob(job.jobId);
  store.setError(job.jobId, "");
  try {
    const result = await integrationSettings({ action, jobId: job.jobId, ...(action === "approve" ? { parameters: { prompt: draft.prompt, modelId: draft.modelId, aspectRatio: draft.aspectRatio, quality: draft.quality, referenceIds: draft.referenceIds } } : {}) });
    store.setOverview(result);
    store.clearDraft(job.jobId);
    if (useExternalTaskStore.getState().selectedJobId === job.jobId) store.setInboxTab("active");
  } catch (failure) { store.setError(job.jobId, failure instanceof Error ? failure.message : "审批失败"); }
  finally { store.setBusyJob(null); }
}

export async function dismissExternalTasks(job?: ExternalJob): Promise<void> {
  const store = useExternalTaskStore.getState();
  if (store.busyJobId || job && !isProcessedTask(job)) return;
  store.setBusyJob(job?.jobId ?? "inbox-cleanup");
  store.setConnectionError("");
  try {
    const result = await integrationSettings({ action: job ? "dismiss" : "clear-processed", ...(job ? { jobId: job.jobId } : {}) });
    store.dismissJobs(result.dismissedJobIds ?? []);
    store.setOverview(result);
  } catch (failure) { store.setConnectionError(failure instanceof Error ? failure.message : "清理失败"); }
  finally { store.setBusyJob(null); }
}
