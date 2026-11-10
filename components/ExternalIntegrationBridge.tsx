"use client";

import { useEffect } from "react";
import { integrationSettings, type ExternalJob } from "@/lib/integrations";
import { useExternalTaskStore } from "@/lib/externalTaskStore";

export default function ExternalIntegrationBridge() {
  useEffect(() => {
    const controller = new AbortController();
    const store = useExternalTaskStore.getState();
    let sequence = 0;
    const refresh = async () => {
      const current = ++sequence;
      try {
        const overview = await integrationSettings(undefined, controller.signal);
        if (!controller.signal.aborted && current === sequence) store.setOverview(overview);
      } catch (failure) { if (!controller.signal.aborted && current === sequence) store.setConnectionError(failure instanceof Error ? failure.message : "连接应用失败"); }
    };
    void refresh();
    const events = new EventSource("/api/integration-events");
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (typeof event.openJob === "string") {
          void integrationSettings<{ job: ExternalJob }>({ action: "inspect", jobId: event.openJob }, controller.signal).then(({ job }) => { if (!controller.signal.aborted) store.showJob(job); }).catch(() => {});
        }
        void refresh();
        window.dispatchEvent(new CustomEvent("helios-integrations-changed", { detail: event }));
      } catch {}
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("aiui-providers-changed", refresh);
    return () => { controller.abort(); events.close(); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("aiui-providers-changed", refresh); };
  }, []);
  return null;
}
