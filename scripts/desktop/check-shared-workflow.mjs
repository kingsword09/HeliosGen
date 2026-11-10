import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const storage = new Map();
const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
globalThis.localStorage = localStorage;
globalThis.sessionStorage = localStorage;
globalThis.window = { dispatchEvent() {} };
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename);
  const exported = {};
  modules.set(filename, exported);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const native = createRequire(filename);
  new Function("exports", "require", compiled)(exported, (specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return native(specifier);
    const target = specifier.startsWith("@/") ? resolve(specifier.slice(2)) : resolve(dirname(filename), specifier);
    return load(`${target}.ts`);
  });
  return exported;
}
const { buildWorkflowZip, WORKFLOW_FORMAT } = load(resolve("lib/exportWorkflow.ts"));
const { importWorkflowZip } = load(resolve("lib/importWorkflow.ts"));
const { makeZip } = load(resolve("lib/makeZip.ts"));
const { resolveInputs, buildPipelineWaves, topoSort } = load(resolve("lib/executor.ts"));
const { useWorkflowStore } = load(resolve("lib/store.ts"));
const { persistentWorkflowNode, persistentWorkflowSpace } = load(resolve("lib/workflowPersistence.ts"));
const { useAssetDrafts } = load(resolve("lib/sharedAssets.ts"));
let checks = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
const image = "/generated/source.png";
const video = "/generated/reference.mp4";
const nodes = [
  { id: "text", type: "promptNode", position: { x: 0, y: 0 }, data: { label: "Prompt", prompt: "draw a cat" } },
  { id: "image", type: "imageInputNode", position: { x: 0, y: 100 }, data: { label: "Reference", inputImage: image, r2Url: image } },
  { id: "video", type: "videoInputNode", position: { x: 0, y: 300 }, data: { label: "Video", videoUrl: video } },
  { id: "generate", type: "generateNode", position: { x: 500, y: 0 }, data: { label: "Generate", model: "provider-model:portable:image" } },
  { id: "videoGen", type: "videoGeneratorNode", position: { x: 1000, y: 0 }, data: { label: "Video Generate" } },
];
const edges = [
  { id: "prompt", source: "text", target: "generate", targetHandle: "prompt" },
  { id: "reference", source: "image", target: "generate", targetHandle: "image" },
  { id: "next", source: "generate", target: "videoGen", targetHandle: "startFrame" },
  { id: "videoRef", source: "video", target: "videoGen", targetHandle: "referenceVideo" },
];
equal(resolveInputs("generate", nodes, edges).imageUrls, [image], "durable local asset resolves to image generator");
equal(resolveInputs("generate", nodes, edges).prompt, "draw a cat");
equal(persistentWorkflowNode({ ...nodes[1], data: { label: "old local", inputImage: image } }).data.r2Url, image, "legacy local input URLs gain durable storage during save");
equal(persistentWorkflowSpace({ id: "empty", name: "Empty", nodes: [], edges: [], nodeCounters: {}, createdAt: 1 }).nodes, [], "empty workflows can be saved");
equal(topoSort(nodes, edges).indexOf("generate") < topoSort(nodes, edges).indexOf("videoGen"), true, "dependency order");
equal(buildPipelineWaves(nodes, edges).flat().includes("generate"), true);
const generatedNodes = nodes.map((node) => node.id === "generate" ? { ...node, data: { ...node.data, imageUrl: "/generated/output.png" } } : node);
equal(resolveInputs("videoGen", generatedNodes, edges).startFrameUrl, "/generated/output.png", "generated outputs chain into next stage");
equal(resolveInputs("videoGen", generatedNodes, edges).referenceVideoUrls, [video], "video references remain intact");

const store = useWorkflowStore.getState();
store.createSpace("Existing", { nodes, edges, nodeCounters: { generateNode: 1 } });
const existingId = useWorkflowStore.getState().activeSpaceId;
store.addNode({ id: "library", type: "imageInputNode", position: { x: 1500, y: 0 }, data: { label: "library", inputImage: image, r2Url: image } });
equal(useWorkflowStore.getState().nodes.length, 6, "library insertion preserves existing nodes");
equal(useWorkflowStore.getState().edges, edges, "library insertion preserves connections");
equal(useWorkflowStore.getState().spaces.find((space) => space.id === existingId).nodes.at(-1).data.r2Url, image, "persistent space contains durable asset");
store.createSpace("New from library");
store.addNode({ id: "new-library", type: "videoInputNode", position: { x: 0, y: 0 }, data: { label: "video", videoUrl: video } });
store.switchSpace(existingId);
equal(useWorkflowStore.getState().nodes.length, 6, "returning to original workflow preserves work");

const drafts = useAssetDrafts.getState();
drafts.add("chat", [image, image]); drafts.add("generation", [image]);
equal(useAssetDrafts.getState().chat, [image], "shared chat draft deduplicates URLs");
drafts.clear("chat");
equal(useAssetDrafts.getState().generation, [image], "chat and generator drafts are independent");
drafts.remove("generation", image); equal(useAssetDrafts.getState().generation, []);

let uploads = 0;
globalThis.fetch = async (path, options) => {
  if (path.startsWith("/api/download?")) { const url = new URL(path, "http://localhost").searchParams.get("url"); return new Response(url.endsWith("mp4") ? new Uint8Array([0, 1, 2]) : new Uint8Array([3, 4, 5]), { headers: { "Content-Type": url.endsWith("mp4") ? "video/mp4" : "image/png" } }); }
  if (path === "/api/upload-asset") { uploads++; assert(options.body.length > 0); return Response.json({ cdnUrl: `/generated/import-${uploads}.${options.headers["Content-Type"].endsWith("mp4") ? "mp4" : "png"}` }); }
  throw new Error(`Unexpected fetch: ${path}`);
};
const space = { id: "portable", name: "Portable", nodes, edges, nodeCounters: { generateNode: 1 }, createdAt: 10, viewport: { x: 25, y: 75, zoom: 0.8 } };
const exported = await buildWorkflowZip(space);
equal(exported.result.assetCount, 2, "image/video bundled with URL deduplication");
equal(exported.result.skipped, 0);
const restored = await importWorkflowZip(new File([exported.blob], "portable.zip"));
equal(restored.nodes.length, nodes.length);
equal(restored.edges, edges);
equal(restored.viewport, space.viewport);
equal(restored.nodes.find((node) => node.id === "image").data.r2Url, restored.nodes.find((node) => node.id === "image").data.inputImage, "all references to one image rewrite consistently");
equal(restored.nodes.find((node) => node.id === "generate").data.model, "provider-model:portable:image", "configuration IDs survive portable workflow export");
equal(restored.assetCount, 2);
equal(uploads, 2);
equal(JSON.stringify(restored.nodes).includes(image), false, "old machine paths do not survive successful import");

function archive(manifest, entries = []) { return new File([makeZip([{ name: "workflow.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }, ...entries])], "test.zip"); }
const manifest = { format: WORKFLOW_FORMAT, version: 1, workflow: { nodes, edges } };
for (const invalid of [
  { ...manifest, version: 99 },
  { ...manifest, workflow: { nodes: [nodes[0], nodes[0]], edges: [] } },
  { ...manifest, workflow: { nodes, edges: [{ id: "bad", source: "missing", target: "image" }] } },
  { ...manifest, workflow: { nodes: [{ ...nodes[0], data: { label: "missing", inputImage: "assets/missing.png" } }], edges: [] } },
]) { await assert.rejects(() => importWorkflowZip(archive(invalid))); checks++; }
globalThis.fetch = async () => new Response("upload failed", { status: 500 });
await assert.rejects(() => importWorkflowZip(new File([exported.blob], "failed.zip")), /未创建工作流/); checks++;
const truncated = new Uint8Array(await exported.blob.arrayBuffer()).slice(0, 80);
await assert.rejects(() => importWorkflowZip(new File([truncated], "truncated.zip"))); checks++;
console.log(`Shared assets / workflow: ${checks} checks passed (isolated storage, mock media only).`);
