/**
 * Import a workflow ("space") from a `.zip` produced by `lib/exportWorkflow.ts`:
 *
 *   workflow.json      — nodes, edges, counters, viewport (asset URLs point at
 *                        the bundled files)
 *   assets/<hash>.<ext> — every referenced image/video
 *
 * Each bundled asset is re-uploaded to local storage via `/api/upload-asset`
 * and its `assets/…` reference in the workflow is rewritten to the fresh URL.
 * Missing assets or failed uploads abort the import without creating a broken workflow.
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "./store";
import { WORKFLOW_FORMAT, WORKFLOW_FORMAT_VERSION } from "./exportWorkflow";

const ASSET_PREFIX = "assets/";

// ── Minimal ZIP reader ────────────────────────────────────────────────────────
// Handles STORE (0) entries directly and DEFLATE (8) via DecompressionStream,
// scanning local file headers sequentially. Enough for our own exports and for
// zips produced by standard tools.

interface UnzipEntry {
  name: string;
  data: Uint8Array;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.length;
    if (total > 100 * 1024 * 1024) { await reader.cancel(); throw new Error("workflow asset exceeds 100 MB"); }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function unzip(buf: ArrayBuffer): Promise<UnzipEntry[]> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  const entries: UnzipEntry[] = [];
  let off = 0;
  const names = new Set<string>();
  let total = 0;

  while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x04034b50) {
    const flags = view.getUint16(off + 6, true);
    const compression = view.getUint16(off + 8, true);
    const compSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart + compSize > bytes.length || names.has(name) || name.includes("..") || name.startsWith("/")) throw new Error("invalid or duplicate zip entry");
    if (compSize > 100 * 1024 * 1024 || entries.length >= 2000) throw new Error("workflow zip exceeds limits");
    names.add(name);

    if (flags & 0x08 && compSize === 0) {
      throw new Error("zip uses streaming data descriptors — re-export the workflow");
    }

    const raw = bytes.slice(dataStart, dataStart + compSize);
    let data: Uint8Array;
    if (compression === 0) data = raw;
    else if (compression === 8) data = await inflateRaw(raw);
    else throw new Error(`unsupported zip compression method ${compression}`);
    total += data.length;
    if (total > 250 * 1024 * 1024) throw new Error("workflow zip exceeds 250 MB");

    entries.push({ name, data });
    off = dataStart + compSize;
  }

  return entries;
}

// ── Asset content types ───────────────────────────────────────────────────────

function contentTypeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "jpg":
    case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

// ── Rewrite bundled asset paths back to real URLs ─────────────────────────────

type Json = unknown;

function rewrite(value: Json, pathToUrl: Map<string, string>): Json {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, pathToUrl));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, pathToUrl);
    return out;
  }
  if (typeof value === "string" && value.startsWith(ASSET_PREFIX) && pathToUrl.has(value)) {
    return pathToUrl.get(value)!;
  }
  return value;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ImportedWorkflow {
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  nodeCounters: Record<string, number>;
  viewport?: { x: number; y: number; zoom: number };
  assetCount: number;
  skipped: number;
}

export async function importWorkflowZip(file: File): Promise<ImportedWorkflow> {
  if (file.size > 250 * 1024 * 1024) throw new Error("workflow zip exceeds 250 MB");
  const entries = await unzip(await file.arrayBuffer());

  const manifestEntry = entries.find((e) => e.name === "workflow.json");
  if (!manifestEntry) throw new Error("workflow.json not found in zip");

  let manifest: {
    format?: string;
    version?: number;
    name?: string;
    workflow?: {
      name?: string;
      nodes?: Node<NodeData>[];
      edges?: Edge[];
      nodeCounters?: Record<string, number>;
      viewport?: { x: number; y: number; zoom: number };
    };
  };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch {
    throw new Error("workflow.json is not valid JSON");
  }

  if (manifest.format !== WORKFLOW_FORMAT) {
    throw new Error("this zip is not a HeliosGen workflow export");
  }
  if (manifest.version !== WORKFLOW_FORMAT_VERSION) throw new Error("unsupported workflow format version");

  const wf = manifest.workflow ?? {};
  if (wf.edges !== undefined && !Array.isArray(wf.edges)) throw new Error("workflow edges must be an array");
  const rawNodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  if (rawNodes.length === 0) throw new Error("workflow has no nodes");
  const nodeIds = new Set<string>();
  for (const node of rawNodes) {
    if (!node || typeof node.id !== "string" || !node.id || nodeIds.has(node.id) || !node.data || !node.position || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) throw new Error("workflow contains invalid or duplicate nodes");
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of wf.edges ?? []) {
    if (!edge || typeof edge.id !== "string" || edgeIds.has(edge.id) || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error("workflow contains invalid edges");
    edgeIds.add(edge.id);
  }
  const referencedPaths = new Set<string>();
  function findAssets(value: unknown) {
    if (Array.isArray(value)) value.forEach(findAssets);
    else if (value && typeof value === "object") Object.values(value).forEach(findAssets);
    else if (typeof value === "string" && value.startsWith(ASSET_PREFIX)) referencedPaths.add(value);
  }
  rawNodes.forEach((node) => findAssets(node.data));
  for (const path of referencedPaths) if (!entries.some((entry) => entry.name === path)) throw new Error(`workflow is missing bundled asset: ${path}`);

  // Re-upload every bundled asset, mapping its path → fresh URL.
  const pathToUrl = new Map<string, string>();
  for (const entry of entries) {
    if (!referencedPaths.has(entry.name)) continue;
    try {
      const res = await fetch("/api/upload-asset", {
        method: "POST",
        headers: { "Content-Type": contentTypeFromName(entry.name) },
        body: entry.data as BodyInit,
      });
      if (!res.ok) throw new Error(`upload ${entry.name} → ${res.status}`);
      const { cdnUrl } = (await res.json()) as { cdnUrl: string };
      if (!cdnUrl || typeof cdnUrl !== "string") throw new Error("upload returned no asset URL");
      pathToUrl.set(entry.name, cdnUrl);
    } catch (failure) {
      throw new Error(`无法导入素材 ${entry.name}，未创建工作流。请重试。`, { cause: failure });
    }
  }

  const nodes = rawNodes.map((n) => ({
    ...n,
    data: rewrite(n.data, pathToUrl) as NodeData,
  }));

  return {
    name: wf.name || manifest.name || "Imported workflow",
    nodes,
    edges: Array.isArray(wf.edges) ? wf.edges : [],
    nodeCounters: wf.nodeCounters ?? {},
    viewport: wf.viewport,
    assetCount: pathToUrl.size,
    skipped: 0,
  };
}
