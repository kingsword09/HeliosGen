"use client";
import { NodeProps, Node } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";

type NoteNodeType = Node<NodeData, "noteNode">;

export default function NoteNode({ id, data }: NodeProps<NoteNodeType>) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  return (
    <div className="bg-note border border-note-border rounded-xl w-52 shadow-md">
      <div className="px-3 py-2 border-b border-note-border text-note-foreground text-xs font-semibold">
        📝 Note
      </div>
      <textarea
        className="w-full bg-transparent text-note-foreground text-xs p-2 resize-none focus:outline-none min-h-[60px] placeholder:text-note-muted"
        placeholder="Add a note…"
        value={data.prompt ?? ""}
        onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
      />
    </div>
  );
}
