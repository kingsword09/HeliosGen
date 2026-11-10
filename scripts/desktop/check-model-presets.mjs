import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename);
  const exported = {};
  modules.set(filename, exported);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("exports", "require", compiled)(exported, (specifier) => load(resolve(dirname(filename), `${specifier}.ts`)));
  return exported;
}
const { newProviderModel } = load(resolve("lib/providerModelConfig.ts"));
const { validateProviderConfig } = load(resolve("lib/providerConfig.ts"));
const { MODEL_PARAMETER_FIELDS, MODEL_PARAMETER_PRESETS, resolveModelParameters } = load(resolve("lib/modelParameterPresets.ts"));
const scratch = await mkdtemp(join(tmpdir(), "helios-model-presets-"));
const binary = join(scratch, "server");
const home = join(scratch, "home");
const data = join(scratch, "data");
const marker = join(tmpdir(), "helios-model-presets-ui.json");
const environment = { ...process.env, HOME: home, HELIOS_DATA_DIR: data, HELIOS_MEDIA_DIR: join(scratch, "media"), AZURE_API_KEY: "", CUSTOM_PROVIDER_BASE_URL: "", CUSTOM_PROVIDER_API_KEY: "" };
let checks = 0;
let providerCalls = 0;
let backend;
let origin;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function check(actual, message) { assert(actual, message); checks++; }
const mock = createServer((request, response) => {
  if (request.url.endsWith("/models")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "gpt-image-2.6-flare", type: "image" }] }));
    return;
  }
  providerCalls++; response.writeHead(500); response.end("Preset checks must not generate images");
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
async function start() {
  backend = spawn(binary, ["-listen", "127.0.0.1:0", "-data", data, "-media", environment.HELIOS_MEDIA_DIR, "-assets", resolve("desktop/resources/frontend")], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  backend.stderr.on("data", (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 150; attempt++) {
    origin = log.match(/Go server: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (origin) return;
    if (backend.exitCode !== null) throw new Error(log);
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Server startup timeout: ${log}`);
}
async function stop() {
  if (!backend || backend.exitCode !== null) return;
  const exited = once(backend, "exit"); backend.kill("SIGTERM"); await exited;
}
async function api(path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, { headers: { "Content-Type": "application/json", ...headers }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}
function config(model, protocol = "openai") { return { id: "preset-provider", name: "隔离参数预设测试", baseUrl: `${mockOrigin}/v1`, imageProtocol: protocol, models: [model] }; }
function parameters(model) { return Object.fromEntries([...MODEL_PARAMETER_FIELDS, "parameterPreset", "parameterProtocol"].map((key) => [key, model[key]])); }
async function compare(input) {
  let expected;
  try { expected = validateProviderConfig(input); }
  catch (failure) { throw new Error(`Invalid preset test input: ${JSON.stringify(input)}`, { cause: failure }); }
  equal(validateProviderConfig(expected), expected, "Resolved presets remain valid and normalization is idempotent");
  const saved = await api("/api/settings/provider", { config: input, apiKey: "mock-only-not-a-real-key" });
  equal(saved.status, 200, `Go accepts ${input.models[0]?.apiId ?? input.imageModel}: ${JSON.stringify(saved.value)}`);
  const actual = saved.value.providers.find((provider) => provider.config.id === input.id).config;
  equal(actual.models.map(parameters), expected.models.map(parameters), "Go and TypeScript resolve the same capabilities");
  equal(actual.models.map((model) => model.apiId), expected.models.map((model) => model.apiId), "Preset selection never rewrites API model IDs");
  return actual;
}

try {
  await mkdir(home, { recursive: true });
  execFileSync("go", ["build", "-o", binary, "./cmd/helios-server"], { stdio: "inherit" });
  await start();
  const testedIds = new Set();
  for (const preset of MODEL_PARAMETER_PRESETS) {
    for (const apiId of preset.apiIds) {
      const identity = `${preset.kind}:${preset.protocol}:${apiId}`;
      if (testedIds.has(identity)) continue;
      testedIds.add(identity);
      const actual = await compare(config(newProviderModel(preset.kind, apiId), preset.protocol));
      equal(actual.models[0].parameterPreset, "auto");
      for (const [key, value] of Object.entries(preset.parameters)) equal(actual.models[0][key], value, `${preset.id} ${key}`);
    }
    const mapped = await compare(config({ ...newProviderModel(preset.kind, "preset-alias"), parameterPreset: preset.id }, preset.protocol));
    for (const [key, value] of Object.entries(preset.parameters)) equal(mapped.models[0][key], value, `Explicit preset ${preset.id} ${key}`);
  }
  for (const apiId of ["my-flare-alias", "gpt-image-2.6-flare-custom", "unknown/gpt-image-2.6-flare", "unknown-model"]) {
    const actual = await compare(config(newProviderModel("image", apiId)));
    equal(actual.models[0].ratios, ["auto"]); equal(actual.models[0].qualityOptions, []); equal(actual.models[0].maxImages, 0);
  }
  const bare = newProviderModel("image", "gpt-image-2.6-flare");
  const automatic = resolveModelParameters(bare, "openai");
  equal(automatic.ratios, ["auto", "1:1", "3:2", "2:3"], "2.6 retains conservative standard sizes unless the user enables a provider extension");
  equal(automatic.qualityOptions, ["auto", "low", "medium", "high"]);
  const extended = await compare(config({ ...bare, parameterPreset: "openai:gpt-image-2.6-extended" }));
  equal(extended.models[0].ratios, ["auto", "1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"], "opt-in 2.6 provider extension offers all seven ratios");
  equal(extended.models[0].sizeMap["16:9"], "1536x864", "wide images are not silently converted to 3:2");
  equal(extended.models[0].sizeMap["9:16"], "864x1536", "portrait images are not silently converted to 2:3");
  const extendedAlias = await compare(config({ ...bare, apiId: "provider-flare-alias", parameterPreset: "openai:gpt-image-2.6-extended" }));
  equal(extendedAlias.models[0].apiId, "provider-flare-alias", "extended preset selection preserves the upstream model alias");
  for (const family of ["gpt-image-2", "gpt-image-2.5-flare"]) {
    const full = await compare(config(newProviderModel("image", family)));
    equal(full.models[0].ratios, extended.models[0].ratios, "documented flexible models automatically include seven ratios");
    const standard = await compare(config({ ...newProviderModel("image", family), parameterPreset: `openai:${family === "gpt-image-2" ? family : "gpt-image-2.5"}-standard` }));
    equal(standard.models[0].ratios, automatic.ratios, "restricted compatible providers can explicitly select standard sizes");
    equal(standard.models[0].qualityOptions, full.models[0].qualityOptions, "size restriction does not downgrade quality capabilities");
  }
  for (const [ratio, size] of Object.entries(extended.models[0].sizeMap)) {
    if (ratio === "auto") continue;
    const [width, height] = size.split("x").map(Number);
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
    equal(width * ratioHeight, height * ratioWidth, `exact dimensions for ${ratio}`);
    equal([width % 16, height % 16], [0, 0], "custom OpenAI dimensions are multiples of 16");
  }
  const legacyManual = { ...bare, maxImages: 1, ratios: ["auto", "16:9"], sizeMap: { "16:9": "1536x864" } };
  const preserved = await compare(config(legacyManual));
  equal(preserved.models[0].parameterPreset, "custom"); equal(preserved.models[0].maxImages, 1); equal(preserved.models[0].sizeMap, legacyManual.sizeMap);
  const disabled = await compare(config({ ...bare, parameterPreset: "custom" }));
  equal(disabled.models[0].maxImages, 0); equal(disabled.models[0].qualityOptions, [], "An explicit disabled capability remains disabled");
  const alias = await compare(config({ ...bare, apiId: "my-flare-alias", parameterPreset: "openai:gpt-image-2.6" }));
  equal(alias.models[0].apiId, "my-flare-alias"); equal(alias.models[0].sizeMap["3:2"], "1536x1024");
  await compare({ ...config(bare), models: [], imageModel: bare.apiId });
  const reloaded = await compare(config({ ...automatic, maxImages: 0 }));
  equal(reloaded.models[0].maxImages, 16, "Automatic profiles are reapplied, not silently downgraded by stale fields");
  const changedProtocol = await compare(config(automatic, "gemini"));
  equal(changedProtocol.models[0].ratios, ["auto"]); equal(changedProtocol.models[0].sizeMap, {}, "Protocol changes never reuse OpenAI size fields for Gemini");
  for (const input of [config({ ...bare, parameterPreset: "not-a-preset" }), config({ ...bare, parameterPreset: "openai:gpt-image-2.6" }, "gemini")]) {
    assert.throws(() => validateProviderConfig(input)); checks++;
    equal((await api("/api/settings/provider", { config: input })).status, 400);
  }
  const before = resolveModelParameters(bare, "openai"); before.ratios.push("21:9"); before.sizeMap["1:1"] = "512x512";
  const after = resolveModelParameters(bare, "openai");
  equal(after.sizeMap["1:1"], "1024x1024"); check(!after.ratios.includes("21:9"), "Preset objects are not shared mutable state");
  await compare(config({ ...bare, parameterPreset: "openai:gpt-image-2.6-extended" }));
  await stop(); await start();
  const restartedExtension = (await api("/api/settings/provider")).value.providers.find((provider) => provider.config.id === "preset-provider").config.models[0];
  equal(parameters(restartedExtension), parameters(extended.models[0]), "provider extension presets and exact dimensions survive application restart");
  await compare(config(bare));
  await stop(); await start();
  const restarted = (await api("/api/settings/provider")).value.providers.find((provider) => provider.config.id === "preset-provider").config.models[0];
  equal(parameters(restarted), parameters(automatic), "Automatic model parameters survive restart");
  const adminHeaders = { "X-Helios-UI": "1" };
  await api("/api/settings/integrations", { action: "enable", enabled: true }, adminHeaders);
  const pair = await api("/api/settings/integrations", { action: "pair", name: "Rex 预设验证" }, adminHeaders);
  const credential = JSON.parse(await readFile(join(data, "integrations", "clients", `${pair.value.clientId}.json`), "utf8"));
  const catalog = await api("/api/integrations/v1/models", undefined, { Authorization: `Bearer ${credential.token}` });
  equal(catalog.value.models[0].ratios, automatic.ratios); equal(catalog.value.models[0].qualityOptions, automatic.qualityOptions); equal(catalog.value.models[0].maxImages, automatic.maxImages);
  const request = await api("/api/integrations/v1/jobs", { requestId: "preset-ui-request", prompt: "预设验证：温暖阳光下的橘猫；仅待审批，不调用服务商。", source: { name: "rex" } }, { Authorization: `Bearer ${credential.token}` });
  equal(request.value.status, "awaiting_approval"); equal(providerCalls, 0, "No paid or mock generation during capability checks");
  console.log(`PASS: ${checks} isolated preset / alias / protocol / legacy / restart / Agent catalog checks. Zero generation calls.`);
  if (process.argv.includes("--ui")) {
    await writeFile(marker, JSON.stringify({ directory: scratch, binary, pid: backend.pid, origin, clientId: pair.value.clientId, jobId: request.value.jobId }));
    console.log(`UI fixture: ${origin}`);
    await once(backend, "exit");
  }
} finally {
  await stop(); mock.closeAllConnections(); await new Promise((done) => mock.close(done));
  if (process.argv.includes("--ui")) await rm(marker, { force: true });
  await rm(scratch, { recursive: true, force: true });
}
