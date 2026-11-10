import type { Node } from "@xyflow/react";
import type { NodeData, Space } from "./store";

export function persistentWorkflowNode(node: Node<NodeData>): Node<NodeData> {
  const input = node.data.inputImage;
  const durable = node.data.r2Url || (input && (input.startsWith("/generated/") || /^https?:\/\//.test(input)) ? input : undefined);
  return { ...node, data: { ...node.data, r2Url: durable, inputImage: undefined } };
}

export function persistentWorkflowSpace(space: Space): Space {
  return { ...space, nodes: space.nodes.map(persistentWorkflowNode) };
}
