"use client";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useWorkflowStore } from "@/lib/store";
import { useSpaceSync } from "@/lib/useSpaceSync";
import { QuickAssist } from "@/components/QuickAssist";

const WorkflowCanvas = dynamic(() => import("@/components/WorkflowCanvas"), {
  ssr: false,
});

export default function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const switchSpace = useWorkflowStore((s) => s.switchSpace);

  const { ready, status } = useSpaceSync();

  // Guard: if this ID doesn't exist in the store, redirect home.
  // Also ensures the correct space is active on direct URL access.
  useEffect(() => {
    if (!ready) return;
    const spaces = useWorkflowStore.getState().spaces;
    if (!spaces.some((sp) => sp.id === id)) {
      router.replace("/");
      return;
    }
    switchSpace(id);
  }, [id, switchSpace, router, ready]);

  if (!ready) return <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><p>{status === "error" ? "无法读取工作流，未修改已有数据。" : "正在加载工作流…"}</p>{status === "error" && <button className="underline" onClick={() => window.location.reload()}>重新加载</button>}</div>;

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      <WorkflowCanvas />
      <QuickAssist />
    </div>
  );
}
