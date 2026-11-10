import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const root = resolve(".");
const scratch = await mkdtemp(join(tmpdir(), "helios-go-parity-"));
const children = new Set();
let assertions = 0;
const captures = [];
const picture = await sharp({ create: { width: 32, height: 16, channels: 4, background: "#33669980" } }).png().toBuffer();
const encodedPicture = picture.toString("base64");
const schema = (await readFile("internal/server/schema.go", "utf8")).split("`")[1];
const legacy = resolve(process.argv[2] ?? "desktop/resources/server");

function check(value, message) { assert(value, message); assertions++; }
function equal(first, second, message) { assert.deepEqual(first, second, message); assertions++; }
async function waitUntil(callback, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const result = await callback(); if (result) return result; } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
  throw new Error("Validation timed out");
}
async function port() { const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening"); const value = listener.address().port; await new Promise((done) => listener.close(done)); return value; }
async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, new Promise((done) => setTimeout(done, 6000))]); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } children.delete(child); }

const mock = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks); let payload = null;
  try { payload = JSON.parse(raw.toString()); } catch {}
  captures.push({ path: request.url, method: request.method, headers: request.headers, payload, raw });
  const url = new URL(request.url, "http://mock");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname.endsWith("/models")) { response.end(JSON.stringify({ data: [{ id: "chat-model", type: "text" }, { id: "image-model", type: "image" }, { id: "veo-model", type: "video" }] })); return; }
  if (url.pathname.endsWith("/media.png")) { response.setHeader("Content-Type", "image/png"); response.end(picture); return; }
  if (url.pathname.endsWith("/media.mp4")) { response.setHeader("Content-Type", "video/mp4"); response.end(picture); return; }
  if (url.pathname.includes("/tasks/")) { response.end(JSON.stringify({ status: "completed", output: url.pathname.includes("video") ? `${mockOrigin}/media.mp4` : [{ b64_json: encodedPicture }] })); return; }
  if (url.pathname.endsWith("/upload")) { response.end(JSON.stringify({ url: "https://mock.invalid/reference.png" })); return; }
  if (url.pathname.endsWith("/videos")) { response.end(JSON.stringify({ id: "video-task" })); return; }
  if (url.pathname.endsWith("/task-images")) { response.end(JSON.stringify({ id: "image-task" })); return; }
  if (url.pathname.includes(":generateContent")) { response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: encodedPicture } }] } }] })); return; }
  if (url.pathname.includes("/images/")) { response.end(JSON.stringify({ data: [{ b64_json: encodedPicture }] })); return; }
  response.setHeader("Content-Type", "text/event-stream");
  const messages = payload?.input ?? payload?.messages ?? payload?.contents;
  const fail = JSON.stringify(messages).includes("fail-stream");
  let events;
  if (url.pathname.endsWith("/responses")) events = fail ? [{ type: "response.failed", response: { error: { message: "mock failure" } } }] : [{ type: "response.output_text.delta", delta: "你好" }, { type: "response.output_text.delta", delta: "，世界" }, { type: "response.completed" }];
  else if (url.pathname.endsWith("/messages")) events = [{ type: "content_block_delta", delta: { type: "text_delta", text: "你好，世界" } }];
  else if (url.pathname.includes(":streamGenerateContent")) events = [{ candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "你好，世界" }] } }] }];
  else events = [{ choices: [{ delta: { content: "你好" } }] }, { choices: [{ delta: { content: "，世界" } }] }];
  for (const event of events) { const line = Buffer.from(`data: ${JSON.stringify(event)}\n\n`); for (let offset = 0; offset < line.length; offset += 3) response.write(line.subarray(offset, offset + 3)); await new Promise((done) => setTimeout(done, 15)); }
  response.end("data: [DONE]\n\n");
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
const certificate = join(scratch, "mock-cert.pem");
const privateKey = join(scratch, "mock-key.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey, "-out", certificate, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
const secureMock = createSecureServer({ cert: await readFile(certificate), key: await readFile(privateKey) }, mock.listeners("request")[0]);
secureMock.listen(0, "127.0.0.1"); await once(secureMock, "listening");
const azureOrigin = `https://127.0.0.1:${secureMock.address().port}`;

const tools = join(scratch, "tools"); await mkdir(tools);
await writeFile(join(scratch, "picture.png"), picture);
await writeFile(join(tools, "ffmpeg"), '#!/bin/sh\ninput=""\nprevious=""\nfor argument in "$@"; do\n  if [ "$previous" = "-i" ]; then input="$argument"; fi\n  previous="$argument"\ndone\ncase "$previous" in *.jpg) cp "$HELIOS_TEST_IMAGE" "$previous" ;; *) cp "$input" "$previous" ;; esac\n', { mode: 0o700 });
await writeFile(join(tools, "ffprobe"), '#!/bin/sh\nprintf "2.5\\n"\n', { mode: 0o700 });
await writeFile(join(tools, "codex"), '#!/bin/sh\nif [ "$2" = "status" ]; then printf "Logged in using ChatGPT\\n"; exit 0; fi\nprintf "https://auth.example.test/device\\nABCD-EFGH\\n"\nsleep 0.3\nmkdir -p "$CODEX_HOME"\nprintf "{}" > "$CODEX_HOME/auth.json"\n', { mode: 0o700 });
await writeFile(join(tools, "codex-imagegen"), '#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\nprevious=""\nfor argument in "$@"; do\n  if [ "$previous" = "--out" ]; then cp "$HELIOS_TEST_IMAGE" "$argument"; fi\n  previous="$argument"\ndone\n', { mode: 0o700 });
for (const tool of ["open", "xdg-open"]) await writeFile(join(tools, tool), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

async function start(name) {
  const directory = join(scratch, name); await mkdir(join(directory, "generated"), { recursive: true });
  const database = new DatabaseSync(join(directory, "guest.db")); database.exec(schema);
  database.prepare("INSERT OR IGNORE INTO generations (id,user_id,task_id,generation_type,status,prompt,model,image_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("old-generation", "guest", "old-job", "image", "done", "existing history", "existing model", "/generated/old.png", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  database.prepare("INSERT OR IGNORE INTO uploads (id,user_id,r2_url,mime_type,source,created_at) VALUES (?,?,?,?,?,?)").run("old-upload", "guest", "/generated/old.png", "image/png", "user_upload", "2024-01-01T00:00:00.000Z");
  database.close(); await writeFile(join(directory, "generated/old.png"), picture);
  await writeFile(join(directory, "guest-spaces.json"), JSON.stringify([{ id: "legacy-space", name: "Legacy", nodes: [], edges: [], nodeCounters: {}, createdAt: 1 }]));
  const listen = await port();
  const environment = { ...process.env, HELIOS_DATA_DIR: directory, HELIOS_MEDIA_DIR: join(directory, "generated"), CODEX_HOME: join(directory, "codex"), HELIOS_TEST_IMAGE: join(scratch, "picture.png"), PATH: `${tools}:${process.env.PATH}`, NODE_ENV: "production", PORT: String(listen), HOSTNAME: "127.0.0.1", NEXT_PUBLIC_APP_VERSION: "1.2.1", AZURE_API_KEY: "", REPLICATE_API_TOKEN: "", CUSTOM_PROVIDER_API_KEY: "", CUSTOM_PROVIDER_BASE_URL: "", SSL_CERT_FILE: certificate, NODE_EXTRA_CA_CERTS: certificate };
  const command = name === "go" ? join(scratch, "server") : process.execPath;
  const args = name === "go" ? ["-listen", `127.0.0.1:${listen}`, "-assets", resolve("desktop/resources/frontend")] : ["--experimental-sqlite", join(legacy, "server.js")];
  const child = spawn(command, args, { cwd: name === "go" ? root : legacy, env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
  let logs = ""; child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
  const origin = `http://127.0.0.1:${listen}`;
  try { await waitUntil(async () => (await fetch(`${origin}/api/health`)).ok); } catch (error) { throw new Error(`${name} startup failed: ${logs}`, { cause: error }); }
  return { name, origin, child, directory };
}

async function json(app, endpoint, payload, method = payload === undefined ? "GET" : "POST") {
  const response = await fetch(app.origin + endpoint, { method, headers: payload === undefined ? {} : { "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const value = await response.json(); return { status: response.status, value };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["created_at", "updated_at", "id", "taskId"].includes(key)).map(([key, entry]) => [key, normalize(entry)]));
  if (typeof value === "string") return value.replace(/\/generated\/(uploads|generated|references|images|videos)\/[a-f\d-]+\.[a-z]+/g, "/generated/$1/<asset>");
  return value;
}

function model(kind, protocol, extra = {}) { return { id: `${kind}-${protocol}`, apiId: `${kind}-model`, name: `${kind} ${protocol}`, kind, enabled: true, connection: { protocol }, parameterProtocol: protocol, promptMaxLength: 32000, ratios: kind === "image" ? ["1:1"] : ["auto"], qualityOptions: kind === "image" && protocol === "gemini" ? ["1k"] : [], maxImages: kind === "image" ? 2 : 0, maxReferenceVideos: 0, maxReferenceAudios: 0, durations: [], resolutions: [], handles: ["prompt"], sound: false, sizeMap: kind === "image" ? { "1:1": "1024x1024" } : {}, parameterKeys: {}, extraBody: {}, maxOutputTokens: kind === "text" ? 321 : null, ...extra }; }
function config(models, extra = {}) { return { id: "mock", name: "Mock", baseUrl: `${mockOrigin}/v1`, models, imageProtocol: "openai", chatProtocol: "openai", timeoutSeconds: 15, ...extra }; }
async function save(app, configuration) { const result = await json(app, "/api/settings/provider", { config: configuration, apiKey: "secret-key" }); equal(result.status, 200, `${app.name} provider save: ${JSON.stringify(result.value)}`); check(!JSON.stringify(result.value).includes("secret-key"), "API key is never returned"); return result; }
async function settled(app, taskId) { return waitUntil(async () => { const job = await json(app, `/api/job-status?taskId=${taskId}`); return job.value.status === "pending" ? null : job.value; }); }

try {
  execFileSync("go", ["build", "-o", join(scratch, "server"), "./cmd/helios-server"], { cwd: root, stdio: "inherit" });
  const apps = [await start("go"), await start("legacy")];
  for (const endpoint of ["/api/workflows", "/api/gallery", "/api/gallery?source=upload", "/api/gallery?source=generation", "/api/gallery?type=video", "/api/folders", "/api/settings/azure-key", "/api/settings/codex-status", "/api/settings/codex-login", "/api/job-status?taskId=old-job", "/api/job-status?taskId=missing"]) equal(normalize(await json(apps[0], endpoint)), normalize(await json(apps[1], endpoint)), endpoint);
  check((await readdir(apps[0].directory)).some((file) => file.startsWith("guest-before-go-")), "Existing SQLite is backed up");
  for (const app of apps) {
    const space = { id: "roundtrip", name: "工作流", nodes: [{ id: "node", type: "note", position: { x: 10, y: 20 }, data: { text: "保存" } }], edges: [], nodeCounters: { note: 1 }, createdAt: 1, viewport: { x: 3, y: 4, zoom: 0.6 } };
    equal((await json(app, "/api/workflows", { spaces: [space] }, "PUT")).status, 200, "Workflow write"); equal((await json(app, "/api/workflows")).value.spaces, [space], "Workflow roundtrip");
    const folder = (await json(app, "/api/folders", { name: "测试文件夹", orderIndex: 2 })).value.folder;
    equal((await json(app, `/api/folders/${folder.id}`, { color: "#112233", name: "Renamed" }, "PATCH")).status, 200, "Folder editing");
    await json(app, "/api/folder-items", { folderId: folder.id, itemIds: ["old-generation"] });
    const folders = (await json(app, "/api/folders")).value; equal(folders.folders[0].color, "#112233", "Folder color"); equal(folders.folderItems[0].item_id, "old-generation", "Folder contents");
    await json(app, `/api/folders/${folder.id}`, undefined, "DELETE"); equal((await json(app, "/api/folders")).value.folderItems, [], "Folder cleanup");
    await json(app, "/api/settings/azure-key", { azureApiKey: "temporary" }); equal((await json(app, "/api/settings/azure-key")).value, { hasToken: true }, "Azure key saved"); await json(app, "/api/settings/azure-key", undefined, "DELETE");
  }
  for (const protocol of ["openai", "responses", "anthropic", "gemini"]) {
    const definition = model("text", protocol, { extraBody: { custom: "preserved", generationConfig: { temperature: 0.3 } }, parameterKeys: { maxOutputTokens: protocol === "gemini" ? "maxOutputTokens" : protocol === "responses" ? "max_output_tokens" : "max_tokens" } });
    const requests = []; const streams = [];
    for (const app of apps) {
      await save(app, config([definition]));
      const response = await fetch(`${app.origin}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: `provider-model:mock:${definition.id}`, messages: [{ role: "system", content: "system" }, { role: "user", content: "hello" }] }) });
      equal(response.status, 200, `${protocol} HTTP`); streams.push(await response.text()); requests.push(captures.at(-1));
    }
    const events = (stream) => stream.split("\n").filter((line) => line.startsWith("data:") && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5)));
    equal(events(streams[0]), events(streams[1]), `${protocol} stream parity`); equal(requests[0].payload, requests[1].payload, `${protocol} payload parity`); equal(requests[0].path, requests[1].path, `${protocol} endpoint parity`);
    for (const header of ["authorization", "x-api-key", "x-goog-api-key", "anthropic-version"]) equal(requests[0].headers[header], requests[1].headers[header], `${protocol} ${header}`);
  }
  for (const protocol of ["openai", "gemini", "task"]) {
    const definition = model("image", protocol, protocol === "task" ? { connection: { protocol: "task", generatePath: "task-images" }, handles: ["prompt", "resource"], parameterKeys: { aspectRatio: "ratio" } } : {});
    const outputs = []; const requests = [];
    for (const app of apps) {
      await save(app, config([definition]));
      const generated = await json(app, "/api/generate", { model: `provider-model:mock:${definition.id}`, prompt: "a beautiful image", aspectRatio: "1:1", ...(protocol === "gemini" ? { quality: "1k" } : {}) });
      equal(generated.status, 200, `${protocol} generation start: ${JSON.stringify(generated.value)}`);
      outputs.push(await settled(app, generated.value.taskId)); requests.push(captures.findLast((entry) => entry.method === "POST"));
      equal(outputs.at(-1).status, "done", `${protocol} generation done`);
      const stream = await fetch(`${app.origin}/api/job-stream?taskId=${generated.value.taskId}`); check((await stream.text()).includes('"status":"done"'), "Settled job SSE");
    }
    equal(normalize(outputs[0]), normalize(outputs[1]), `${protocol} generation output parity`); equal(requests[0].payload, requests[1].payload, `${protocol} image payload parity`); equal(requests[0].path, requests[1].path, `${protocol} image path parity`);
  }
  const encodedModel = model("text", "gemini", { apiId: "models/ft:demo +&!()@" });
  for (const app of apps) {
    await save(app, config([encodedModel]));
    const response = await fetch(`${app.origin}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: `provider-model:mock:${encodedModel.id}`, prompt: "encoded model" }) });
    await response.text();
    equal(captures.at(-1).path, `/v1/models/${encodeURIComponent("ft:demo +&!()@")}\:streamGenerateContent?alt=sse`, "Model placeholder escaping matches encodeURIComponent");
  }
  const overridden = model("text", "responses", { connection: { protocol: "responses", basePath: "/special", generatePath: "responses", authMode: "custom", authHeader: "X-Secret", authPrefix: "Token " } });
  for (const app of apps) {
    const edited = model("image", "openai");
    await save(app, config([edited]));
    const generated = await json(app, "/api/generate", { model: `provider-model:mock:${edited.id}`, prompt: "edit with reference", aspectRatio: "1:1", imageUrls: [`data:image/png;base64,${encodedPicture}`] });
    equal(generated.status, 200, "Image editing start"); equal((await settled(app, generated.value.taskId)).status, "done", "Image editing result");
    const submitted = captures.findLast((entry) => entry.method === "POST");
    check(submitted.path.endsWith("/images/edits"), "Reference switches to image edits");
    check(submitted.headers["content-type"].startsWith("multipart/form-data"), "Image edit uses multipart");
    check(submitted.raw.includes(Buffer.from('name="image[]"')), "Image-array multipart field retained");
    check(submitted.raw.includes(Buffer.from('name="prompt"')), "Multipart prompt retained");
    const templated = model("image", "task", { connection: { protocol: "task", generatePath: "task-images", uploadPath: "upload", body: { model: "{{model}}", text: "{{prompt}}", references: "{{image_urls}}", omit: "{{duration}}", nested: { fixed: true } } } });
    await save(app, config([templated]));
    const task = await json(app, "/api/generate", { model: `provider-model:mock:${templated.id}`, prompt: "template", imageUrls: [`data:image/png;base64,${encodedPicture}`], aspectRatio: "1:1" });
    equal(task.status, 200, "Task template start");
    const stream = await fetch(`${app.origin}/api/job-stream?taskId=${task.value.taskId}`); check((await stream.text()).includes('"status":"done"'), "Pending task SSE completion");
    const submission = captures.findLast((entry) => entry.path.endsWith("/task-images"));
    equal(submission.payload, { model: "image-model", text: "template", references: ["https://mock.invalid/reference.png"], nested: { fixed: true } }, "Typed template substitution and undefined omission");
    check(captures.findLast((entry) => entry.path.endsWith("/upload")).payload.file.startsWith("data:image/png;base64,"), "Reference upload field retained");
  }
  for (const app of apps) { await save(app, config([overridden])); const response = await fetch(`${app.origin}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: `provider-model:mock:${overridden.id}`, prompt: "test" }) }); await response.text(); equal(captures.at(-1).path, "/special/responses", "Per-model base path"); equal(captures.at(-1).headers["x-secret"], "Token secret-key", "Per-model authentication"); }
  for (const app of apps) {
    const failedRequest = async () => {
      const response = await fetch(`${app.origin}/api/assistant`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: `provider-model:mock:${overridden.id}`, prompt: "fail-stream" }) });
      return response.text();
    };
    if (app.name === "go") check((await failedRequest()).includes("mock failure"), "Responses stream error propagation");
    else { let rejected = false; try { await failedRequest(); } catch { rejected = true; } check(rejected, "Legacy propagates Responses failures by closing the stream"); }
    const invalid = await json(app, "/api/settings/provider", { config: config([model("text", "openai", { parameterKeys: { maxOutputTokens: "model" } })]) }); equal(invalid.status, 400, "Reject reserved parameter mappings");
    const definition = model("video", "task"); await save(app, config([definition])); const generated = await json(app, "/api/generate-video", { model: `provider-model:mock:${definition.id}`, prompt: "video" }); equal(generated.status, 200, "Video task start"); equal((await settled(app, generated.value.taskId)).status, "done", "Video polling and storage");
    const first = await fetch(`${app.origin}/api/upload-asset`, { method: "POST", headers: { "Content-Type": "image/png" }, body: picture }).then((response) => response.json());
    const second = await fetch(`${app.origin}/api/upload-asset`, { method: "POST", headers: { "Content-Type": "image/png" }, body: picture }).then((response) => response.json()); equal(first.cdnUrl, second.cdnUrl, "Upload hash deduplication");
    const download = await fetch(`${app.origin}/api/download?url=${encodeURIComponent(first.cdnUrl)}&filename=photo.png`); equal(download.status, 200, "Media download"); check(download.headers.get("content-disposition").includes("photo.png"), "Download filename");
    const ranged = await fetch(app.origin + first.cdnUrl, { headers: { Range: "bytes=0-7" } });
    if (app.name === "go") { equal(ranged.status, 206, "Media byte ranges"); equal((await ranged.arrayBuffer()).byteLength, 8, "Media range bytes"); }
    else { equal(ranged.status, 200, "Legacy serves complete media for range requests"); await ranged.arrayBuffer(); }
    const fetched = await json(app, "/api/fetch-url", { url: mockOrigin + "/media.png" }); equal(fetched.status, 200, "Fetch URL"); equal(fetched.value.mediaType, "image", "Fetched media kind");
    const listed = await json(app, "/api/settings/provider/models?id=mock"); equal(listed.status, 200, "Provider model listing"); equal(listed.value.models.length, 3, "Provider model count");
    const key = await json(app, "/api/settings/azure-key", { azureApiKey: "azure-test" }); equal(key.status, 200, "Azure setup");
    const azure = await json(app, "/api/generate", { model: "gpt-image-2", prompt: "azure image", aspectRatio: "16:9", azureResolution: "2k", azureQuality: "high", azureBaseUrl: azureOrigin, azureDeployment: "image-deployment" }); equal(azure.status, 200, "Azure generation start"); const azureResult = await settled(app, azure.value.taskId); equal(azureResult.status, "done", `${app.name} Azure generation storage: ${JSON.stringify(azureResult)}`);
    const codex = await json(app, "/api/generate", { prompt: "codex image", codexProvider: true }); equal(codex.status, 200, "Codex image start"); equal((await settled(app, codex.value.taskId)).status, "done", "Codex image CLI result");
    const login = await json(app, "/api/settings/codex-login", {}); equal(login.status, 200, "Device login start"); check(["pending", "success"].includes(login.value.status), "Device code parsed"); await waitUntil(async () => (await json(app, "/api/settings/codex-login")).value.status === "success"); equal((await json(app, "/api/settings/codex-status")).value.ready, true, "Codex login readiness");
    for (const [endpoint, fields] of [["trim-video", { startTime: 0, endTime: 1 }], ["extract-frame", { timeSeconds: 1 }], ["extract-frame", { lastFrame: true }]]) { const result = await json(app, `/api/${endpoint}`, { videoUrl: mockOrigin + "/media.mp4", ...fields }); equal(result.status, 200, `${endpoint} CLI contract`); check(result.value.cdnUrl.startsWith("/generated/"), `${endpoint} stored output`); }
    equal((await json(app, "/api/open-external", { url: "https://example.test/" })).status, 200, "External link OS dispatch");
    equal((await json(app, "/api/generate-image", { prompt: "legacy" })).value.error, "REPLICATE_API_TOKEN not set", "Legacy Replicate configuration failure");
  }
  const go = apps[0];
  const jobsFile = join(go.directory, ".job-store.json"); const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
  const provider = (await json(go, "/api/settings/provider")).value.config;
  jobs["custom-resume-validation"] = { status: "pending", type: "image", providerTask: { id: "image-task", config: provider } }; jobs["custom-interrupted-validation"] = { status: "pending", type: "image" }; await writeFile(jobsFile, JSON.stringify(jobs));
  equal((await settled(go, "custom-resume-validation")).status, "done", "Persistent provider task recovery"); equal((await settled(go, "custom-interrupted-validation")).status, "error", "Interrupted synchronous job failure");
  for (const endpoint of ["/", "/gallery?tab=videos", "/chat", "/workflow", "/workflow/roundtrip"]) { const response = await fetch(go.origin + endpoint); equal(response.status, 200, "Static direct route " + endpoint); check((await response.text()).includes('id="root"'), "SPA index fallback"); }
  const thumbnail = await fetch(`${go.origin}/api/thumbnail?url=%2Fgenerated%2Fold.png&w=16&q=75`); equal(thumbnail.status, 200, "Go thumbnail"); const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata(); equal([metadata.width, metadata.height], [16, 8], "Thumbnail dimensions"); check(metadata.hasAlpha, "Transparent thumbnails retain alpha");
  console.log(`PASS: ${assertions} assertions against the isolated legacy Next backend.`);
  console.log("Provider network and optional CLI services are mocked; real credentials are never read or charged.");
} finally {
  await Promise.all([...children].map(stop)); await Promise.all([new Promise((done) => mock.close(done)), new Promise((done) => secureMock.close(done))]); await rm(scratch, { recursive: true, force: true });
}
