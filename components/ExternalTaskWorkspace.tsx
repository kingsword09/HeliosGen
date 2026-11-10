"use client";

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import ExternalTaskDock from "@/components/ExternalTaskDock";
import { useExternalTaskStore } from "@/lib/externalTaskStore";

export default function ExternalTaskWorkspace({ children }: { children: ReactNode }) {
  const open = useExternalTaskStore((state) => state.open);
  const workspace = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = workspace.current;
    const main = container?.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
    if (!container || !main) return;
    const measure = () => {
      const bounds = main.getBoundingClientRect();
      container.style.setProperty("--helios-workspace-width", `${bounds.width}px`);
      container.style.setProperty("--helios-workspace-center", `${bounds.left + bounds.width / 2}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    measure();
    return () => observer.disconnect();
  }, []);
  return <div ref={workspace} className="flex h-full min-h-0 min-w-0 flex-1" data-external-task-workspace style={{ "--helios-task-dock-width": open ? "clamp(20rem, 32vw, 26rem)" : "3rem" } as CSSProperties}>
    {children}
    <ExternalTaskDock />
  </div>;
}
