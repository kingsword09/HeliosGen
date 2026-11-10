import { create } from "zustand";
import type { ExternalJob, GenerationParameters, IntegrationOverview } from "@/lib/integrations";

export interface ExternalTaskDraft extends GenerationParameters {
  referenceUrls: string[];
}

export function taskDraft(job: ExternalJob): ExternalTaskDraft {
  return { prompt: job.prompt, modelId: job.modelId, aspectRatio: job.aspectRatio ?? "", quality: job.quality ?? "", referenceIds: job.referenceIds ?? [], referenceUrls: job.referenceUrls ?? [] };
}

export const EXTERNAL_TASK_STATUS: Record<ExternalJob["status"], string> = {
  awaiting_approval: "等待确认", approved: "已批准", launching: "提交中", pending: "生成中", done: "已完成", error: "失败", rejected: "已拒绝",
};

export function isProcessedTask(job: ExternalJob): boolean {
  return ["done", "error", "rejected"].includes(job.status);
}

export function externalTaskCounts(jobs: ExternalJob[]) {
  const visible = jobs.filter((job) => !job.inboxDismissed);
  const pending = visible.filter((job) => job.status === "awaiting_approval").length;
  const processed = visible.filter(isProcessedTask).length;
  const active = visible.length - processed;
  return { pending, running: active - pending, active, processed };
}

const TASK_PROGRESS: Record<ExternalJob["status"], number> = { awaiting_approval: 0, approved: 1, launching: 2, pending: 3, done: 4, error: 4, rejected: 4 };

function firstPending(overview: IntegrationOverview) {
  return [...overview.jobs].reverse().find((job) => job.status === "awaiting_approval");
}

interface ExternalTaskState {
  overview: IntegrationOverview | null;
  open: boolean;
  view: "inbox" | "detail";
  inboxTab: "active" | "processed";
  dismissedJobIds: string[];
  selectedJobId: string | null;
  inspectedJob: ExternalJob | null;
  drafts: Record<string, ExternalTaskDraft>;
  errors: Record<string, string>;
  busyJobId: string | null;
  connectionError: string;
  setOverview: (overview: IntegrationOverview) => void;
  openPanel: (tab?: "active" | "processed") => void;
  closePanel: () => void;
  showJob: (job: ExternalJob) => void;
  selectJob: (jobId: string) => void;
  returnToInbox: () => void;
  setInboxTab: (tab: "active" | "processed") => void;
  dismissJobs: (jobIds: string[]) => void;
  setDraft: (jobId: string, draft: ExternalTaskDraft) => void;
  clearDraft: (jobId: string) => void;
  setBusyJob: (jobId: string | null) => void;
  setError: (jobId: string, error: string) => void;
  setConnectionError: (error: string) => void;
}

export const useExternalTaskStore = create<ExternalTaskState>((set) => ({
  overview: null, open: false, view: "inbox", inboxTab: "active", dismissedJobIds: [], selectedJobId: null, inspectedJob: null, drafts: {}, errors: {}, busyJobId: null, connectionError: "",
  setOverview: (overview) => set((state) => {
    const dismissedJobIds = [...new Set([...state.dismissedJobIds, ...(overview.dismissedJobIds ?? []), ...overview.jobs.filter((job) => job.inboxDismissed).map((job) => job.jobId)])];
    const existing = state.inspectedJob;
    const refreshed = overview.jobs.filter((job) => !dismissedJobIds.includes(job.jobId)).map((job) => {
      const previous = state.overview?.jobs.find((entry) => entry.jobId === job.jobId);
      return previous && TASK_PROGRESS[previous.status] > TASK_PROGRESS[job.status] ? previous : job;
    });
    const jobs = existing && !existing.inboxDismissed && !dismissedJobIds.includes(existing.jobId) && !refreshed.some((job) => job.jobId === existing.jobId) ? [...refreshed, existing] : refreshed;
    const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([jobId]) => !dismissedJobIds.includes(jobId) && (!jobs.some((job) => job.jobId === jobId) || jobs.some((job) => job.jobId === jobId && job.status === "awaiting_approval"))));
    return { overview: { ...overview, jobs }, selectedJobId: state.selectedJobId ?? firstPending(overview)?.jobId ?? jobs[0]?.jobId ?? null, inspectedJob: existing && !refreshed.some((job) => job.jobId === existing.jobId) ? existing : null, dismissedJobIds, drafts, connectionError: "" };
  }),
  openPanel: (tab) => set((state) => {
    const current = state.overview?.jobs.find((job) => job.jobId === state.selectedJobId);
    return { open: true, view: "inbox", inboxTab: tab ?? state.inboxTab, selectedJobId: current?.status === "awaiting_approval" ? current.jobId : (state.overview && firstPending(state.overview)?.jobId) ?? state.selectedJobId };
  }),
  closePanel: () => set({ open: false }),
  showJob: (job) => set((state) => ({
    open: true, view: "detail", selectedJobId: job.jobId, inspectedJob: job,
    overview: state.overview && !job.inboxDismissed && !state.dismissedJobIds.includes(job.jobId) ? { ...state.overview, jobs: [...state.overview.jobs.filter((entry) => entry.jobId !== job.jobId), job] } : state.overview,
  })),
  selectJob: (jobId) => set({ selectedJobId: jobId, view: "detail", inspectedJob: null }),
  returnToInbox: () => set({ view: "inbox", inspectedJob: null }),
  setInboxTab: (inboxTab) => set({ inboxTab, view: "inbox", inspectedJob: null }),
  dismissJobs: (jobIds) => set((state) => ({
    dismissedJobIds: [...new Set([...state.dismissedJobIds, ...jobIds])],
    overview: state.overview ? { ...state.overview, jobs: state.overview.jobs.filter((job) => !jobIds.includes(job.jobId)) } : null,
    drafts: Object.fromEntries(Object.entries(state.drafts).filter(([jobId]) => !jobIds.includes(jobId))),
    errors: Object.fromEntries(Object.entries(state.errors).filter(([jobId]) => !jobIds.includes(jobId))),
    ...(jobIds.includes(state.selectedJobId ?? "") ? { selectedJobId: null, inspectedJob: null, view: "inbox" as const } : {}),
  })),
  setDraft: (jobId, draft) => set((state) => ({ drafts: { ...state.drafts, [jobId]: draft } })),
  clearDraft: (jobId) => set((state) => ({ drafts: Object.fromEntries(Object.entries(state.drafts).filter(([entryId]) => entryId !== jobId)) })),
  setBusyJob: (busyJobId) => set({ busyJobId }),
  setError: (jobId, error) => set((state) => ({ errors: { ...state.errors, [jobId]: error } })),
  setConnectionError: (connectionError) => set({ connectionError }),
}));
