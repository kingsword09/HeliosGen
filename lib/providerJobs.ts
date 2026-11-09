import { randomUUID } from "node:crypto";
import { jobStore, type JobResult } from "./jobStore";
import { jobEvents } from "./jobEvents";
import { pollProviderTask, type ProviderOutput } from "./customProvider";
import * as guestDb from "./guest/db";

const runtime = globalThis as typeof globalThis & { heliosProviderJobs?: Set<string> };
const active = runtime.heliosProviderJobs ??= new Set<string>();

function settle(taskId: string, result: JobResult): void {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
  if (result.status === "done") guestDb.updateGeneration(taskId, { status: "done", image_url: result.imageUrl, image_urls: result.imageUrls, video_url: result.videoUrl });
  else if (result.status === "error") guestDb.updateGeneration(taskId, { status: "error", error_msg: result.error });
}

function complete(taskId: string, kind: "image" | "video", urls: string[]): void {
  settle(taskId, kind === "image" ? { status: "done", imageUrl: urls[0], imageUrls: urls } : { status: "done", videoUrl: urls[0] });
}

export function resumeProviderJob(taskId: string, kind: "image" | "video"): void {
  const job = jobStore.get(taskId);
  if (!taskId.startsWith("custom-") || job?.status !== "pending" || active.has(taskId)) return;
  if (!job.providerTask) {
    settle(taskId, { status: "error", error: "The server restarted during a synchronous request. Please generate again." });
    return;
  }
  active.add(taskId);
  const task = job.providerTask;
  void (async () => {
    try {
      const deadline = Date.now() + task.config.timeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const output = await pollProviderTask(task, kind);
        if ("urls" in output) { complete(taskId, kind, output.urls); return; }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      throw new Error("Provider generation timed out.");
    } catch (error) {
      settle(taskId, { status: "error", error: error instanceof Error ? error.message : "Provider generation failed." });
    } finally {
      active.delete(taskId);
    }
  })();
}

export function startProviderJob(kind: "image" | "video", generate: () => Promise<ProviderOutput>, metadata: Omit<Parameters<typeof guestDb.insertGeneration>[0], "task_id" | "status" | "generation_type">): string {
  const taskId = `custom-${randomUUID()}`;
  jobStore.set(taskId, { status: "pending", type: kind });
  guestDb.insertGeneration({ ...metadata, task_id: taskId, status: "pending", generation_type: kind });
  active.add(taskId);
  void (async () => {
    try {
      const output = await generate();
      if (output.task) {
        jobStore.set(taskId, { status: "pending", type: kind, providerTask: output.task });
        active.delete(taskId);
        resumeProviderJob(taskId, kind);
      } else complete(taskId, kind, output.urls);
    } catch (error) {
      settle(taskId, { status: "error", error: error instanceof Error ? error.message : "Provider generation failed." });
    } finally {
      if (jobStore.get(taskId)?.status !== "pending") active.delete(taskId);
    }
  })();
  return taskId;
}
