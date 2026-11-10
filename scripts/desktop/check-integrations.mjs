import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const scratch = await mkdtemp(join(tmpdir(), "helios-integrations-check-"));
const data = join(scratch, "data");
const home = join(scratch, "home");
const binary = join(scratch, "helios-server");
const children = new Set();
let checks = 0;
let providerCalls = 0;
const captures = [];
const picture = await sharp({ create: { width: 24, height: 16, channels: 4, background: "#33669980" } }).png().toBuffer();
const environment = { ...process.env, HOME: home, HELIOS_DATA_DIR: data, HELIOS_MEDIA_DIR: join(scratch, "media"), CLAUDE_CONFIG_DIR: join(home, ".claude"), AZURE_API_KEY: "", CUSTOM_PROVIDER_BASE_URL: "", CUSTOM_PROVIDER_API_KEY: "" };

function check(actual, message) { assert(actual, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
async function until(callback, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await callback(); if (result) return result; await new Promise((done) => setTimeout(done, 50)); }
  throw new Error("Integration validation timed out");
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([exited, new Promise((done) => setTimeout(done, 6000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  children.delete(child);
}
const mock = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  if (request.url.endsWith("/tasks/mock-task")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ status: "completed", output: [{ b64_json: picture.toString("base64") }] })); return; }
  providerCalls++;
  captures.push({ path: request.url, header: request.headers.authorization, body: buffer.toString() });
  response.setHeader("Content-Type", "application/json");
  if (buffer.includes("fail-provider")) { response.writeHead(500); response.end(JSON.stringify({ error: { message: "mock provider failure" } })); return; }
  if (buffer.includes("slow-provider")) { await new Promise((done) => setTimeout(done, 1000)); }
  if (request.url.includes("task-images")) { response.end(JSON.stringify({ id: "mock-task" })); return; }
  if (request.url.includes("generateContent")) { response.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: picture.toString("base64") } }] } }] })); return; }
  response.end(JSON.stringify({ data: [{ b64_json: picture.toString("base64") }] }));
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
let origin;
let backend;
async function start() {
  const child = spawn(binary, ["-listen", "127.0.0.1:0", "-data", data, "-media", environment.HELIOS_MEDIA_DIR, "-assets", resolve("desktop/resources/frontend")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  origin = await until(() => log.match(/Go server: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]);
  backend = child;
}
async function api(path, options = {}, token) {
  const response = await fetch(origin + path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) } });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = { error: text }; }
  return { status: response.status, value };
}
async function admin(action) {
  return api("/api/settings/integrations", { method: action ? "POST" : "GET", headers: { "X-Helios-UI": "1", "Content-Type": "application/json" }, ...(action ? { body: JSON.stringify(action) } : {}) });
}
async function cli(args, expected = 0, stdin = "") {
  const child = spawn(binary, ["cli", ...args], { env: { ...environment, REX_SESSION: "session:integration-test", REX_BLOCK: "block:integration-test" }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdin.end(stdin);
  const [code] = await once(child, "exit"); children.delete(child);
  equal(code, expected, `CLI ${args.join(" ")}: ${errors} ${output}`);
  return output ? JSON.parse(output) : errors;
}
async function credential(clientId) { return JSON.parse(await readFile(join(data, "integrations", "clients", `${clientId}.json`), "utf8")); }
async function submit(token, request) { return api("/api/integrations/v1/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }, token); }
async function job(token, id) { return api(`/api/integrations/v1/jobs/${id}`, {}, token); }

try {
  await mkdir(home, { recursive: true });
  execFileSync("go", ["build", ...(process.env.HELIOS_CHECK_RACE === "1" ? ["-race"] : []), "-o", binary, "./cmd/helios-server"], { stdio: "inherit" });
  await start();
  equal((await admin()).value.enabled, false, "disabled by default");
  equal((await admin()).value.installedAgents, [], "no tools installed in isolated home");
  equal((await api("/api/settings/integrations")).status, 403, "UI-only admin header required");
  await cli(["models"], 1);
  equal((await admin({ action: "enable", enabled: true })).status, 200);
  const paired = await admin({ action: "pair", name: "Rex validation" });
  equal(paired.status, 200);
  const first = await credential(paired.value.clientId);
  const secondPair = await admin({ action: "pair", name: "Other agent" });
  const second = await credential(secondPair.value.clientId);
  const scope = ["--client", first.clientId];
  check(!(await admin()).value.clients.some((client) => "token" in client || "tokenHash" in client), "UI does not expose credentials");
  equal((await stat(join(data, "integrations", "clients", `${first.clientId}.json`))).mode & 0o777, 0o600, "private credentials");
  equal((await api("/api/integrations/v1/models")).status, 401);
  equal((await api("/api/integrations/v1/models", { headers: { Authorization: first.token } })).status, 401);
  equal((await api("/api/integrations/v1/models", { headers: { Origin: "https://evil.invalid" } }, first.token)).status, 403);
  const model = { id: "model-image", apiId: "mock-image", name: "Mock image", kind: "image", enabled: true, ratios: ["auto", "1:1"], qualityOptions: ["standard"], maxImages: 3, maxReferenceVideos: 0, maxReferenceAudios: 0, promptMaxLength: 32000, durations: [], resolutions: [], handles: ["prompt"], sound: false, sizeMap: { "1:1": "1024x1024" }, parameterKeys: {}, extraBody: {}, maxOutputTokens: null };
  const provider = { id: "provider-test", name: "Mock Provider", baseUrl: `${mockOrigin}/v1`, imageProtocol: "openai", chatProtocol: "openai", imageModel: model.apiId, models: [model] };
  const saved = await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: provider, apiKey: "mock-private-provider-key" }) });
  equal(saved.status, 200, "save isolated mock provider");
  const catalog = await cli([...scope, "models"]);
  equal(catalog.models.length, 1);
  check(!JSON.stringify(catalog).includes("mock-private-provider-key"), "no provider keys in model catalog");
  const modelId = catalog.defaultModelId;
  equal((await submit(first.token, { requestId: "unknown-input", prompt: "test", baseUrl: "https://evil.invalid" })).status, 400, "unknown provider fields rejected");
  equal((await submit(first.token, { requestId: "unsupported-quality", prompt: "test", quality: "unsupported" })).status, 400);
  equal((await submit(first.token, { requestId: "unsupported-ratio", prompt: "test", aspectRatio: "99:1" })).status, 400);
  const pending = await cli([...scope, "image", "submit", "--request", "-"], 0, JSON.stringify({ requestId: "first", prompt: "create test", aspectRatio: "1:1", quality: "standard", source: { name: "codex" } }));
  equal(pending.status, "awaiting_approval"); equal(providerCalls, 0, "no paid call before approval");
  equal(pending.source.name, "codex", "reported agent retained independently of connection nickname and Rex context");
  equal(pending.source.rexSessionId, "session:integration-test"); equal(pending.modelId, modelId, "model pinned before approval");
  equal((await admin({ action: "inspect", jobId: pending.jobId })).value.job.jobId, pending.jobId, "UI can inspect a specific job without relying on its history page");
  equal((await admin({ action: "inspect", jobId: "external-missing" })).status, 404);
  const duplicate = await submit(first.token, { requestId: "first", prompt: "create test", aspectRatio: "1:1", quality: "standard" });
  equal(duplicate.value.jobId, pending.jobId, "idempotency ignores changing terminal context");
  equal((await submit(first.token, { requestId: "first", prompt: "different" })).status, 409, "changed request rejected");
  equal((await job(second.token, pending.jobId)).status, 404, "jobs are scoped to a connection");
  await cli([...scope, "job", "wait", pending.jobId, "--timeout", "1"], 2); equal(providerCalls, 0);
  const changedDefault = { ...provider, imageModel: "different-model", models: [model, { ...model, id: "different-image", apiId: "different-model" }] };
  equal((await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: changedDefault }) })).status, 200);
  check((await cli([...scope, "models"])).defaultModelId !== modelId, "fixture changes the default model while approval is pending");
  equal((await admin({ action: "approve", jobId: pending.jobId })).status, 200);
  const complete = await cli([...scope, "job", "wait", pending.jobId, "--timeout", "10"]);
  equal(complete.status, "done"); equal(providerCalls, 1);
  equal((await admin({ action: "approve", jobId: pending.jobId })).status, 409);
  equal(captures[0].header, "Bearer mock-private-provider-key", "existing provider transport used");
  equal(JSON.parse(captures[0].body).model, "mock-image", "approval uses the submitted model despite default changes");
  equal((await admin({ action: "inspect", jobId: pending.jobId })).value.job.outputs, complete.outputs, "result inspection returns original outputs");
  equal((await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: provider }) })).status, 200);
  const downloaded = join(scratch, "download.png");
  await cli([...scope, "job", "download", pending.jobId, "--output", downloaded]);
  equal(await readFile(downloaded), picture, "original image download");
  await cli([...scope, "job", "download", pending.jobId, "--output", downloaded], 1);
  equal(await readFile(downloaded), picture, "existing file preserved");
  equal((await api(`/api/integrations/v1/jobs/${pending.jobId}/output?index=no`, {}, first.token)).status, 400);
  equal((await api(`/api/integrations/v1/jobs/${pending.jobId}/output`, {}, second.token)).status, 404);
  await cli([...scope, "job", "open", pending.jobId]);
  const gallery = await api("/api/gallery?type=image&page=0&source=generation");
  check(gallery.value.items.some((item) => item.prompt === "create test" && item.url === complete.outputs[0].url), "generation saved to existing gallery");
  const reference = join(scratch, "reference.png"); await writeFile(reference, picture);
  const imported = await cli([...scope, "reference", "import", "--file", reference]);
  equal((await submit(second.token, { requestId: "stolen-ref", prompt: "test", referenceIds: [imported.assetId] })).status, 400);
  equal((await api("/api/integrations/v1/references", { method: "POST", body: "not an image" }, first.token)).status, 400);
  await admin({ action: "policy", clientId: first.clientId, autoApprove: true });
  const edited = await submit(first.token, { requestId: "edit", prompt: "edit previous image", referenceIds: [complete.outputs[0].assetId, imported.assetId] });
  equal(edited.status, 200);
  equal((await cli([...scope, "job", "wait", edited.value.jobId, "--timeout", "10"])).status, "done");
  equal(providerCalls, 2);
  check(captures[1].path.endsWith("/images/edits"), "existing reference-image transport used");
  const failed = await submit(first.token, { requestId: "failed", prompt: "fail-provider" });
  await until(async () => (await job(first.token, failed.value.jobId)).value.status === "error");
  equal(providerCalls, 3);
  equal((await submit(first.token, { requestId: "failed", prompt: "fail-provider" })).value.jobId, failed.value.jobId);
  equal(providerCalls, 3, "failed request not automatically charged again");
  await admin({ action: "policy", clientId: first.clientId, autoApprove: false });
  const rejected = await submit(first.token, { requestId: "reject", prompt: "reject me" });
  await admin({ action: "reject", jobId: rejected.value.jobId });
  equal((await job(first.token, rejected.value.jobId)).value.status, "rejected"); equal(providerCalls, 3);
  const savedEndpoint = await readFile(join(data, "integrations", "endpoint.json"), "utf8");
  const altered = JSON.parse(savedEndpoint); altered.instance = "stale-instance";
  await writeFile(join(data, "integrations", "endpoint.json"), JSON.stringify(altered), { mode: 0o600 });
  await cli([...scope, "models"], 1);
  await writeFile(join(data, "integrations", "endpoint.json"), savedEndpoint, { mode: 0o600 });
  const rexSkill = join(home, ".agents", "skills", "rex", "SKILL.md"); await mkdir(join(home, ".agents", "skills", "rex"), { recursive: true }); await writeFile(rexSkill, "existing Rex skill");
  const installed = await admin({ action: "install", clientId: first.clientId, agent: "shared" });
  equal(installed.status, 200, `isolated CLI/Skill installation: ${JSON.stringify(installed.value)}`);
  equal(installed.value.installedAgents, ["shared"], "install returns current agent-specific status");
  check((await readFile(installed.value.skillPath, "utf8")).includes("name: heliosgen"));
  equal(await readFile(rexSkill, "utf8"), "existing Rex skill", "Rex Skill and hooks preserved");
  equal((await admin()).value.installedAgents, ["shared"], "installed state persists when settings are reopened");
  const timestamps = await Promise.all([installed.value.cliPath, installed.value.skillPath].map(async (path) => (await stat(path)).mtimeMs));
  await new Promise((done) => setTimeout(done, 20));
  equal((await admin({ action: "install", clientId: second.clientId, agent: "shared" })).status, 200, "another connection shares the same installed tools");
  equal(await Promise.all([installed.value.cliPath, installed.value.skillPath].map(async (path) => (await stat(path)).mtimeMs)), timestamps, "repeated installation never rewrites current files");
  await stop(backend); await start();
  equal((await admin()).value.installedAgents, ["shared"], "installed state persists after application restart");
  const claudeInstalled = await admin({ action: "install", clientId: first.clientId, agent: "claude" });
  equal(claudeInstalled.status, 200);
  equal(claudeInstalled.value.installedAgents, ["shared", "claude"], "each agent family has its own Skill installation status");
  await rm(installed.value.skillPath);
  equal((await admin()).value.installedAgents, ["claude"], "missing shared Skill re-enables installation without affecting Claude");
  equal((await admin({ action: "install", clientId: first.clientId, agent: "shared" })).value.installedAgents, ["shared", "claude"], "missing Skill can be repaired");
  await chmod(installed.value.cliPath, 0o600);
  equal((await admin()).value.installedAgents, [], "non-executable CLI is not reported as installed");
  equal((await admin({ action: "install", clientId: first.clientId, agent: "shared" })).value.installedAgents, ["shared", "claude"], "CLI execute permission can be repaired");
  await writeFile(installed.value.cliPath, "foreign command");
  equal((await admin()).value.installedAgents, [], "a changed CLI is not falsely reported as installed");
  equal((await admin({ action: "install", clientId: first.clientId, agent: "shared" })).status, 409);
  equal(await readFile(installed.value.cliPath, "utf8"), "foreign command");
  const persisted = await submit(first.token, { requestId: "persist-approval", prompt: "survive restart" });
  await stop(backend); await start();
  equal((await job(first.token, persisted.value.jobId)).value.status, "awaiting_approval"); equal(providerCalls, 3);
  await admin({ action: "approve", jobId: persisted.value.jobId });
  await cli([...scope, "job", "wait", persisted.value.jobId, "--timeout", "10"]); equal(providerCalls, 4);
  await stop(backend); await start();
  equal((await job(first.token, pending.jobId)).value.status, "done", "completed jobs survive restart"); equal(providerCalls, 4);
  await admin({ action: "policy", clientId: first.clientId, autoApprove: true });
  for (const [protocol, path] of [["gemini", "models/{model}:generateContent"], ["task", "task-images"]]) {
    equal((await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: { ...provider, models: [{ ...model, qualityOptions: protocol === "gemini" ? ["1k"] : ["standard"] }], imageProtocol: protocol, imagesPath: path, statusPath: "tasks/{id}", taskIdPath: "id", taskStatePath: "status", taskOutputPath: "output" }, apiKey: "mock-private-provider-key" }) })).status, 200);
    const request = await submit(first.token, { requestId: `protocol-${protocol}`, prompt: `protocol ${protocol}` });
    equal(request.status, 200);
    equal((await cli([...scope, "job", "wait", request.value.jobId, "--timeout", "10"])).status, "done", `${protocol} uses existing image adapter`);
  }
  await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: provider, apiKey: "mock-private-provider-key" }) });
  const priorCalls = providerCalls;
  const interrupted = await submit(first.token, { requestId: "interrupted", prompt: "slow-provider" });
  await until(() => providerCalls === priorCalls + 1);
  await stop(backend); await start();
  await until(async () => (await job(first.token, interrupted.value.jobId)).value.status === "error");
  equal(providerCalls, priorCalls + 1, "restart during a synchronous provider request never bills an automatic retry");
  const streamController = new AbortController();
  const stream = await fetch(`${origin}/api/integration-events`, { signal: streamController.signal });
  const reader = stream.body.getReader();
  const initialEvent = await reader.read();
  check(new TextDecoder().decode(initialEvent.value).includes("connected"), "UI event stream reconnect snapshot");
  await admin({ action: "policy", clientId: first.clientId, autoApprove: false });
  const changedEvent = await reader.read();
  const eventText = new TextDecoder().decode(changedEvent.value);
  check(eventText.includes("changed") && !eventText.includes("token") && !eventText.includes("prompt"), "UI events contain no credential or chat payload");
  await reader.cancel(); streamController.abort();
  const monitor = spawn(binary, ["cli", ...scope, "jobs", "watch"], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.add(monitor);
  const [monitorOutput] = await once(monitor.stdout, "data");
  check(!monitorOutput.includes(0x1b) && Array.isArray(JSON.parse(monitorOutput.toString())), "piped monitor output contains JSON, not OSC escape sequences");
  await stop(monitor);
  const originalReview = { requestId: "review-parameters", prompt: "Agent original prompt", modelId, aspectRatio: "1:1", quality: "standard", referenceIds: [imported.assetId] };
  const reviewJob = await submit(first.token, originalReview);
  equal(reviewJob.status, 200);
  equal(reviewJob.value.originalRequest.prompt, originalReview.prompt, "Agent original request is preserved before approval");
  equal(reviewJob.value.referenceIds, originalReview.referenceIds, "reference IDs are available for task editing");
  const reviewParameters = { prompt: "User reviewed prompt", modelId, aspectRatio: "1:1", quality: "standard", referenceIds: [] };
  const beforeReviewCalls = providerCalls;
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: { ...reviewParameters, prompt: "" } })).status, 400);
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: { ...reviewParameters, quality: "unsupported" } })).status, 400);
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: { ...reviewParameters, baseUrl: "https://evil.invalid" } })).status, 400, "review schemas reject provider paths");
  const foreignReference = await cli(["--client", second.clientId, "reference", "import", "--file", reference]);
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: { ...reviewParameters, referenceIds: [foreignReference.assetId] } })).status, 400, "review cannot use another connection's assets");
  equal((await job(first.token, reviewJob.value.jobId)).value.status, "awaiting_approval", "invalid edits never approve the job");
  equal(providerCalls, beforeReviewCalls, "invalid review parameters never call a provider");
  const referencePath = `/api/settings/integrations/reference?jobId=${reviewJob.value.jobId}`;
  equal((await api(referencePath, { method: "POST", body: picture })).status, 403, "UI reference imports require the admin header");
  equal((await api(referencePath, { method: "POST", headers: { "X-Helios-UI": "1" }, body: "not an image" })).status, 400);
  const userReference = await api(referencePath, { method: "POST", headers: { "X-Helios-UI": "1" }, body: picture });
  equal(userReference.status, 200);
  equal((await submit(second.token, { requestId: "steal-user-reference", prompt: "test", referenceIds: [userReference.value.assetId] })).status, 400, "UI reference imports retain connection ownership");
  const reviewModel = { ...model, id: "review-model", apiId: "review-other", name: "Review model" };
  equal((await api("/api/settings/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config: { ...provider, models: [model, reviewModel] } }) })).status, 200);
  const effectiveParameters = { ...reviewParameters, modelId: "provider-model:provider-test:review-model", referenceIds: [userReference.value.assetId] };
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: effectiveParameters })).status, 200);
  const reviewed = await cli([...scope, "job", "wait", reviewJob.value.jobId, "--timeout", "10"]);
  equal(reviewed.status, "done");
  equal(reviewed.prompt, effectiveParameters.prompt); equal(reviewed.modelId, effectiveParameters.modelId);
  equal(reviewed.referenceIds, effectiveParameters.referenceIds);
  equal(reviewed.originalRequest.prompt, originalReview.prompt); equal(reviewed.originalRequest.modelId, modelId);
  equal(reviewed.configurationEdited, true); check(typeof reviewed.approvedAt === "string", "approved configuration has a review timestamp");
  check(captures.at(-1).body.includes("User reviewed prompt") && captures.at(-1).body.includes("review-other"), "existing provider transport uses the approved prompt and model");
  equal(providerCalls, beforeReviewCalls + 1, "review generates exactly once");
  equal((await submit(first.token, originalReview)).value.jobId, reviewJob.value.jobId, "retrying the original Agent request returns the edited job");
  equal(providerCalls, beforeReviewCalls + 1);
  equal((await submit(first.token, { ...originalReview, prompt: effectiveParameters.prompt })).status, 409);
  equal((await admin({ action: "approve", jobId: reviewJob.value.jobId, parameters: effectiveParameters })).status, 409, "approved parameters cannot be changed or resubmitted");
  equal((await api(referencePath, { method: "POST", headers: { "X-Helios-UI": "1" }, body: picture })).status, 409, "reference edits are locked after approval");
  await stop(backend); await start();
  const recoveredReview = (await job(first.token, reviewJob.value.jobId)).value;
  equal(recoveredReview.prompt, effectiveParameters.prompt); equal(recoveredReview.originalRequest.prompt, originalReview.prompt);
  equal(recoveredReview.configurationEdited, true); equal(providerCalls, beforeReviewCalls + 1, "review metadata survives a restart without resubmission");
  const legacyRequest = { requestId: "legacy-pending-review", prompt: "Legacy pending prompt" };
  const legacyReview = await submit(first.token, legacyRequest);
  await stop(backend);
  execFileSync(process.execPath, ["--experimental-sqlite", "-e", "const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1]); database.prepare('DELETE FROM integration_job_reviews WHERE job_id=?').run(process.argv[2]); database.close();", join(data, "guest.db"), legacyReview.value.jobId], { stdio: "inherit" });
  await start();
  const legacyPending = (await job(first.token, legacyReview.value.jobId)).value;
  equal(legacyPending.status, "awaiting_approval", "jobs from older builds remain available for approval");
  equal(legacyPending.originalRequest.modelId, legacyPending.modelId, "legacy jobs retain the submitted pinned configuration");
  equal((await admin({ action: "approve", jobId: legacyReview.value.jobId })).status, 200);
  const legacyCompleted = await cli([...scope, "job", "wait", legacyReview.value.jobId, "--timeout", "10"]);
  equal(legacyCompleted.configurationEdited, false, "unchanged approval is not marked edited because of empty reference normalization");
  equal(legacyCompleted.originalRequest.prompt, legacyRequest.prompt);
  equal((await submit(first.token, legacyRequest)).value.jobId, legacyReview.value.jobId, "legacy request identity is retained after review");
  equal(providerCalls, beforeReviewCalls + 2);
  const inboxCalls = providerCalls;
  const inboxPending = await submit(first.token, { requestId: "inbox-pending", prompt: "Keep this active message" });
  equal(inboxPending.status, 200);
  equal((await admin({ action: "dismiss", jobId: inboxPending.value.jobId })).status, 409, "unapproved messages cannot be removed without explicit rejection");
  equal((await admin({ action: "dismiss" })).status, 400, "single removal requires a task ID");
  equal((await admin({ action: "clear-processed", jobId: inboxPending.value.jobId })).status, 400, "bulk cleanup cannot target an active task");
  equal((await admin({ action: "dismiss", jobId: "missing-inbox-job" })).status, 404);
  equal((await api("/api/settings/integrations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear-processed" }) })).status, 403, "cleanup requires the trusted UI header");
  const removedReview = await admin({ action: "dismiss", jobId: reviewJob.value.jobId });
  equal(removedReview.status, 200);
  equal(removedReview.value.dismissedJobIds, [reviewJob.value.jobId]);
  check(!removedReview.value.jobs.some((entry) => entry.jobId === reviewJob.value.jobId), "removed messages no longer appear in the admin inbox");
  equal((await job(first.token, reviewJob.value.jobId)).value.inboxDismissed, true, "Agent inspection keeps the original task and records inbox dismissal");
  equal((await submit(first.token, originalReview)).value.jobId, reviewJob.value.jobId, "dismissal preserves original request idempotency");
  equal((await admin({ action: "dismiss", jobId: reviewJob.value.jobId })).status, 200, "repeated dismissal is idempotent");
  equal((await fetch(`${origin}/api/integrations/v1/jobs/${reviewJob.value.jobId}/output`, { headers: { Authorization: `Bearer ${first.token}` } })).status, 200, "cleanup does not delete generated media");
  const inboxRunning = await submit(first.token, { requestId: "inbox-running", prompt: "inbox slow-provider" });
  equal((await admin({ action: "approve", jobId: inboxRunning.value.jobId })).status, 200);
  await until(() => providerCalls === inboxCalls + 1);
  equal((await admin({ action: "dismiss", jobId: inboxRunning.value.jobId })).status, 409, "generating tasks cannot be removed from the inbox");
  const clearedInbox = await admin({ action: "clear-processed" });
  equal(clearedInbox.status, 200);
  check(clearedInbox.value.dismissedJobIds.includes(rejected.value.jobId), "one cleanup handles rejected messages together with completed/error messages");
  check(clearedInbox.value.jobs.some((entry) => entry.jobId === inboxPending.value.jobId), "bulk cleanup leaves awaiting approvals intact");
  check(clearedInbox.value.jobs.some((entry) => entry.jobId === inboxRunning.value.jobId), "bulk cleanup leaves generating tasks intact");
  check(clearedInbox.value.jobs.every((entry) => !["done", "error", "rejected"].includes(entry.status)), "all currently processed messages leave the inbox");
  const agentHistory = await api("/api/integrations/v1/jobs", {}, first.token);
  check(agentHistory.value.some((entry) => entry.jobId === reviewJob.value.jobId), "Agent job history remains intact after inbox cleanup");
  await cli([...scope, "job", "wait", inboxRunning.value.jobId, "--timeout", "10"]);
  await stop(backend); await start();
  check(!(await admin()).value.jobs.some((entry) => entry.jobId === reviewJob.value.jobId), "cleared notifications stay removed after a restart");
  equal((await job(first.token, rejected.value.jobId)).value.status, "rejected", "reject status survives cleanup and restart");
  equal((await admin({ action: "inspect", jobId: reviewJob.value.jobId })).value.job.inboxDismissed, true, "explicit historical inspection remains available without restoring a notification");
  equal(providerCalls, inboxCalls + 1, "cleanup and restarts never cause additional upstream calls beyond the single approved test task");
  await admin({ action: "reject", jobId: inboxPending.value.jobId });
  await admin({ action: "enable", enabled: false });
  equal((await api("/api/integrations/v1/models", {}, first.token)).status, 403);
  await cli([...scope, "models"], 1);
  await admin({ action: "enable", enabled: true });
  await admin({ action: "revoke", clientId: second.clientId });
  equal((await api("/api/integrations/v1/models", {}, second.token)).status, 401);
  for (let index = 0; index < 4; index++) equal((await submit(first.token, { requestId: `limit-${index}`, prompt: "pending limit" })).status, 200);
  equal((await submit(first.token, { requestId: "over-limit", prompt: "pending limit" })).status, 429);
  await admin({ action: "revoke", clientId: first.clientId });
  check((await admin()).value.jobs.filter((job) => job.requestId.startsWith("limit-")).every((job) => job.status === "rejected"), "revoking rejects unapproved jobs");
  console.log(`PASS: ${checks} isolated external integration / CLI / authorization / media / restart checks. No real credentials or paid providers used.`);
} finally {
  for (const child of children) await stop(child);
  mock.closeAllConnections(); await new Promise((done) => mock.close(done));
  await rm(scratch, { recursive: true, force: true });
}
