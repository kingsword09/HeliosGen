"use client";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useRef } from "react";
import { useGeneratingBorderAnimation } from "@/lib/useGeneratingBorderAnimation";

type ImageGenNodeType = Node<NodeData, "imageGenNode">;

const IMAGE_MODELS = [
  { value: "flux-schnell", label: "Flux Schnell (fast)" },
  { value: "flux-dev", label: "Flux Dev (quality)" },
  { value: "sdxl", label: "Stable Diffusion XL" },
];

const STATUS_RING: Record<string, string> = {
  idle: "border-border",
  pending: "border-muted-foreground",
  running: "border-status-warning",
  done: "border-status-success",
  error: "border-destructive",
};

export default function ImageGenNode({ id, data }: NodeProps<ImageGenNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const status = data.status ?? "idle";
  const cardRef = useRef<HTMLDivElement>(null);
  const busy = status === "running";

  useGeneratingBorderAnimation(cardRef, busy);

  return (
    <div
      ref={cardRef}
      className={`node-card bg-card border-2 rounded-xl w-72 shadow-lg ${STATUS_RING[status]} ${busy ? "node-generating" : ""}`}
    >
      {/* Input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="prompt"
        className="!w-3 !h-3 !bg-node-purple !border-2 !border-node-purple"
      />

      <div className="overflow-hidden rounded-[7px]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-node-blue/15 border-b border-node-blue/30">
        <span className="text-node-blue text-sm">🎨</span>
        <span className="text-node-blue font-semibold text-sm">Image Generation</span>
        {status === "running" && (
          <span className="ml-auto text-status-warning text-xs animate-pulse">Generating…</span>
        )}
        {status === "done" && (
          <span className="ml-auto text-status-success text-xs">Done</span>
        )}
        {status === "error" && (
          <span className="ml-auto text-destructive text-xs">Error</span>
        )}
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        <div>
          <label className="text-muted-foreground text-xs mb-1 block">Model</label>
          <select
            className="w-full bg-muted border border-input rounded-lg text-foreground text-xs px-2 py-1.5 focus:outline-none focus:border-node-blue"
            value={data.model ?? "flux-schnell"}
            onChange={(e) => updateNodeData(id, { model: e.target.value })}
          >
            {IMAGE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Preview */}
        <div className="rounded-lg overflow-hidden bg-muted border border-border min-h-[120px] flex items-center justify-center">
          {data.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.imageUrl}
              alt="Generated"
              className="w-full object-cover"
            />
          ) : (
            <span className="text-muted-foreground text-xs">
              {status === "running" ? "Generating image…" : "Output will appear here"}
            </span>
          )}
        </div>

        {data.imageUrl && (
          <a
            href={data.imageUrl}
            target="_blank"
            rel="noreferrer"
            className="block text-center text-xs text-node-blue hover:text-node-blue"
          >
            Open full size ↗
          </a>
        )}
      </div>
      </div>

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-node-blue !border-2 !border-node-blue"
      />
    </div>
  );
}
