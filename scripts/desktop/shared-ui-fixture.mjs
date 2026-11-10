import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const directory = await mkdtemp(join(tmpdir(), "helios-shared-ui-"));
const marker = join(tmpdir(), "helios-shared-ui.json");
const home = join(directory, "home");
await mkdir(home);
let backend;
const calls = [];
const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="#dce9e4"/><path d="M0 480L180 120L330 320L460 180L600 480" fill="#567a6a"/><circle cx="420" cy="95" r="45" fill="#f6c67a"/></svg>')).png().toBuffer();
const second = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="#f1e4d6"/><rect x="180" y="100" width="240" height="280" rx="40" fill="#aa7960"/><rect x="220" y="180" width="160" height="110" rx="10" fill="#fff8ef"/></svg>')).png().toBuffer();
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  calls.push({ path: request.url, bytes: Buffer.concat(chunks).length });
  await writeFile(join(directory, "calls.json"), JSON.stringify(calls));
  if (request.url.includes("chat/completions")) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "这是一张隔离测试图片，素材已成功传入 Chat。" } }] })}\n\ndata: [DONE]\n\n`);
  } else if (request.url.includes("images/")) {
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  } else { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [] })); }
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const mockURL = `http://127.0.0.1:${mock.address().port}`;
const binary = join(directory, "server");
process.on("uncaughtException", async (failure) => { console.error(failure); await cleanup(1); });
execFileSync("go", ["build", "-o", binary, "./cmd/helios-server"], { stdio: "inherit" });
backend = spawn(binary, ["-listen", "127.0.0.1:0", "-data", join(directory, "data"), "-media", join(directory, "media"), "-assets", resolve("desktop/resources/frontend")], { env: { ...process.env, HOME: home, CUSTOM_PROVIDER_BASE_URL: "", CUSTOM_PROVIDER_API_KEY: "", AZURE_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
let origin;
let logs = "";
backend.stderr.on("data", (chunk) => { logs += chunk; });
for (let attempt = 0; attempt < 100; attempt++) {
  origin = logs.match(/Go server: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if (origin) break;
  await new Promise((done) => setTimeout(done, 100));
}
if (!origin) throw new Error(`Fixture failed: ${logs}`);
async function api(path, data, method = "POST") {
  const response = await fetch(origin+path, { method, headers: { "Content-Type": "application/json", "X-Helios-UI": "1" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
await api("/api/settings/provider", { apiKey: "mock-only", config: { id: "fixture", name: "隔离测试服务商", baseUrl: mockURL+"/v1", imageProtocol: "openai", chatProtocol: "openai", models: [{ id: "image", name: "测试图片模型", apiId: "gpt-image-2.6-flare", kind: "image", enabled: true }, { id: "text", name: "测试视觉模型", apiId: "fixture-vision", kind: "text", enabled: true, promptMaxLength: 32000 }] } });
const locations = [];
for (const [buffer, title] of [[png, "山野色彩参考"], [second, "产品包装参考"]]) {
  const uploaded = await api("/api/upload", { dataUrl: `data:image/png;base64,${buffer.toString("base64")}`, mimeType: "image/png" });
  locations.push(uploaded.cdnUrl);
  const registered = await api("/api/assets", { url: uploaded.cdnUrl, title });
  await api("/api/assets", { id: registered.id, tags: ["参考", "隔离测试"], favorite: true }, "PATCH");
}
await api("/api/workflows", { spaces: [{ id: "fixture-workflow", name: "共享素材生图链路（隔离测试）", createdAt: Date.now(), updatedAt: Date.now(), nodeCounters: { promptNode: 1, imageInputNode: 1, generateNode: 1 }, nodes: [
  { id: "prompt", type: "promptNode", position: { x: 0, y: 0 }, data: { label: "Text #1", prompt: "根据参考图生成山野插画" } },
  { id: "reference", type: "imageInputNode", position: { x: 0, y: 350 }, data: { label: "Image #1", r2Url: locations[0], inputImage: locations[0] } },
  { id: "generate", type: "generateNode", position: { x: 500, y: 0 }, data: { label: "Image Generator #1", model: "provider-model:fixture:image", aspectRatio: "1:1", quality: "auto" } },
], edges: [
  { id: "text-edge", source: "prompt", target: "generate", targetHandle: "prompt" },
  { id: "image-edge", source: "reference", target: "generate", targetHandle: "image" },
], viewport: { x: 90, y: 70, zoom: 0.8 } }] }, "PUT");
const backup = await api("/api/settings/transfer", { action: "export", preferences: { "heliosgen-theme": "light" } });
const configFile = join(directory, "config.json");
await writeFile(configFile, JSON.stringify(backup.backup, null, 2));
await writeFile(marker, JSON.stringify({ origin, directory, configFile, locations, pid: backend.pid }));
console.log(`Isolated fixture ready: ${origin}\nMarker: ${marker}`);
async function cleanup(exitCode = 0) {
  if (backend && backend.exitCode === null) { const exited = once(backend, "exit"); backend.kill("SIGTERM"); await exited; }
  mock.close(); await rm(marker, { force: true }); await rm(directory, { recursive: true, force: true }); process.exit(exitCode);
}
process.on("SIGINT", () => void cleanup()); process.on("SIGTERM", () => void cleanup());
await new Promise(() => {});
