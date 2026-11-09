import { fetch as providerFetch, FormData } from "undici";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { MEDIA_DIR } from "./guest/paths";
import { uploadBuffer } from "./storage";
import { getProviderModelDefinition, resolveProviderModel, type ProviderConfig } from "./providerConfig";
import { getProviderApiKey, getProviderConfig, getProviderForModel } from "./providerSettings";
import type { DiscoveredModel, ProviderModelKind } from "./providerModelConfig";
import { prepareProviderGeneration } from "./providerRequest";
import { modelRequestUrl, providerRequestConfig, type EffectiveProviderConfig } from "./providerConnection";

export interface GenerationInput {
  model: string;
  prompt: string;
  imageUrls?: string[];
  aspectRatio?: string;
  quality?: string;
  duration?: number;
  resolution?: string;
  sound?: boolean;
  startFrameUrl?: string;
  endFrameUrl?: string;
  videoRefUrl?: string;
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
}

export interface ProviderTask {
  id: string;
  config: EffectiveProviderConfig;
}

export type ProviderOutput = { urls: string[]; task?: never } | { task: ProviderTask; urls?: never };

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function readJsonPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) return undefined;
    return current && typeof current === "object" && Object.hasOwn(current, key)
      ? (current as JsonObject)[key] : undefined;
  }, value);
}

export function providerUrl(config: EffectiveProviderConfig, path: string, id = "", model = ""): string {
  return modelRequestUrl(config, path, model, id);
}

function authHeaders(config: EffectiveProviderConfig, protocol = "openai"): Record<string, string> {
  if (getProviderConfig(config.id).baseUrl !== config.baseUrl) throw new Error("This provider was removed or its Base URL changed. Restore it before retrying.");
  const key = getProviderApiKey(config.id);
  const headers: Record<string, string> = {};
  const connection = config.requestConnection;
  if (key) {
    if (connection?.authMode === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (connection?.authMode === "gemini") headers["x-goog-api-key"] = key;
    else if (connection?.authMode === "anthropic") headers["x-api-key"] = key;
    else if (connection?.authMode === "custom") headers[connection.authHeader!] = `${connection.authPrefix ?? ""}${key}`;
    else if (config.authHeader === "Authorization" && protocol === "gemini") headers["x-goog-api-key"] = key;
    else if (config.authHeader === "Authorization" && protocol === "anthropic") headers["x-api-key"] = key;
    else headers[config.authHeader] = `${config.authPrefix}${key}`;
  }
  if (protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

export function configuredProvider(selected?: string, kind: ProviderModelKind = "image"): EffectiveProviderConfig {
  const config = selected ? getProviderForModel(kind, selected) : getProviderConfig();
  if (!config.baseUrl) throw new Error("请先在设置 → 服务商页面保存 API 地址。");
  return selected ? providerRequestConfig(config, kind, selected) : config;
}

export async function fetchProviderModels(config: ProviderConfig): Promise<{ models: DiscoveredModel[]; truncated: boolean }> {
  const protocol = config.modelsProtocol === "auto"
    ? config.chatProtocol === "gemini" || config.imageProtocol === "gemini" ? "gemini" : config.chatProtocol
    : config.modelsProtocol;
  const models = new Map<string, DiscoveredModel>();
  const tokens = new Set<string>();
  let token = "";
  for (let page = 0; page < 20; page += 1) {
    const parameters = new URLSearchParams();
    if (protocol === "gemini") { parameters.set("pageSize", "100"); if (token) parameters.set("pageToken", token); }
    if (protocol === "anthropic") { parameters.set("limit", "100"); if (token) parameters.set("after_id", token); }
    const path = `${config.modelsPath}${parameters.size ? `${config.modelsPath.includes("?") ? "&" : "?"}${parameters}` : ""}`;
    const json = await requestJson({ ...config, timeoutSeconds: Math.min(config.timeoutSeconds, 30) }, path, undefined, protocol);
    const envelope = record(json);
    const list = config.modelsResultPath ? readJsonPath(json, config.modelsResultPath) : Array.isArray(json) ? json : envelope.data ?? envelope.models;
    if (!Array.isArray(list)) throw new Error("Model-list response must contain data[] or models[]. Configure modelsResultPath for a custom response.");
    for (const entry of list) {
      const item = record(entry);
      const rawId = typeof entry === "string" ? entry : item.id ?? item.name;
      if (typeof rawId !== "string" || !rawId.trim()) continue;
      const id = protocol === "gemini" ? rawId.replace(/^models\//, "") : rawId;
      const label = item.displayName ?? item.display_name ?? item.name;
      const name = typeof label === "string" && !label.startsWith("models/") ? label : id;
      const hint = `${id} ${name}`.toLowerCase();
      let suggestedKind: ProviderModelKind | null = null;
      const output = record(item.modalities).output;
      const outputs = Array.isArray(output) ? output : [];
      if (item.type === "video" || outputs.includes("video")) suggestedKind = "video";
      else if (item.type === "image" || outputs.includes("image")) suggestedKind = "image";
      else if (["text", "chat", "language"].includes(String(item.type)) || outputs.includes("text")) suggestedKind = "text";
      else if (/(video|veo|kling|sora|wan[\d-]|seedance)/.test(hint)) suggestedKind = "video";
      else if (/(image|imagen|flux|dall[-_]?e|banana|stable[-_ ]diffusion)/.test(hint)) suggestedKind = "image";
      else if (/(chat|claude|gemini|gpt|llama|qwen|deepseek)/.test(hint) && !/(embed|audio|tts|whisper)/.test(hint)) suggestedKind = "text";
      models.set(id, { id, name, suggestedKind });
      if (models.size >= 1000) return { models: [...models.values()], truncated: true };
    }
    const next = protocol === "gemini" ? envelope.nextPageToken : protocol === "anthropic" && envelope.has_more ? envelope.last_id : undefined;
    if (typeof next !== "string" || !next) return { models: [...models.values()], truncated: false };
    if (tokens.has(next)) throw new Error("The provider repeated a model-list pagination token.");
    tokens.add(next);
    token = next;
  }
  return { models: [...models.values()], truncated: true };
}

async function requestJson(config: EffectiveProviderConfig, path: string, body?: JsonObject | FormData, protocol = "openai", id = "", model = ""): Promise<unknown> {
  const multipart = body instanceof FormData;
  const response = await providerFetch(providerUrl(config, path, id, model), {
    method: body ? "POST" : "GET",
    headers: { ...authHeaders(config, protocol), ...(!multipart && body ? { "Content-Type": "application/json" } : {}) },
    body: body ? multipart ? body : JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
    redirect: "error",
  });
  const text = await response.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(`Provider returned HTTP ${response.status} with a non-JSON response.`); }
  const envelope = record(json);
  const error = envelope.error;
  if (!response.ok || error) {
    const message = record(error).message ?? error ?? envelope.message ?? `HTTP ${response.status}`;
    throw new Error(`${config.name}: ${String(message).slice(0, 1000)}`);
  }
  return json;
}

export async function mediaDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) {
    if (!/^data:[\w.+/-]+;base64,[\s\w+/=]+$/.test(url)) throw new Error("Reference media must be base64-encoded.");
    return url;
  }
  let bytes: Uint8Array;
  let contentType: string;
  if (url.startsWith("/generated/")) {
    const file = resolve(MEDIA_DIR, decodeURIComponent(url.slice("/generated/".length).split(/[?#]/)[0]));
    const location = relative(MEDIA_DIR, file);
    if (!location || location.startsWith("..") || location.includes("\0")) throw new Error("Invalid local media path.");
    bytes = await readFile(file);
    const ext = file.split(".").pop()?.toLowerCase() ?? "png";
    contentType = ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav" } as Record<string, string>)[ext] ?? "application/octet-stream";
  } else {
    const remote = new URL(url);
    if (!["http:", "https:"].includes(remote.protocol)) throw new Error("Unsupported reference media URL.");
    const response = await providerFetch(remote, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Could not load reference media: HTTP ${response.status}.`);
    bytes = new Uint8Array(await response.arrayBuffer());
    contentType = response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  }
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("Reference media exceeds 50 MB.");
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function inlineMedia(dataUrl: string): { mimeType: string; data: string } {
  const comma = dataUrl.indexOf(",");
  return { mimeType: dataUrl.slice(5, dataUrl.indexOf(";")), data: dataUrl.slice(comma + 1) };
}

async function referenceUrl(config: ProviderConfig, url: string): Promise<string> {
  if (!url.startsWith("data:") && !url.startsWith("/generated/")) return url;
  const dataUrl = await mediaDataUrl(url);
  if (!config.uploadPath) return dataUrl;
  const json = await requestJson(config, config.uploadPath, { file: dataUrl });
  const uploaded = readJsonPath(json, config.uploadResultPath);
  if (typeof uploaded !== "string" || !/^https?:\/\//.test(uploaded)) throw new Error("Upload response did not contain a public media URL.");
  return uploaded;
}

export function renderBody(template: unknown, input: JsonObject): unknown {
  if (typeof template === "string") {
    const placeholder = template.match(/^\{\{([\w_]+)\}\}$/);
    if (placeholder) {
      if (!Object.hasOwn(input, placeholder[1])) throw new Error(`Unknown payload placeholder: ${placeholder[1]}`);
      return input[placeholder[1]];
    }
    return template;
  }
  if (Array.isArray(template)) return template.map((entry) => renderBody(entry, input));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, entry]) => [key, renderBody(entry, input)]));
  }
  return template;
}

async function canonicalInput(config: ProviderConfig, kind: "image" | "video", input: GenerationInput): Promise<JsonObject> {
  const refs = await Promise.all((input.imageUrls ?? []).map((url) => referenceUrl(config, url)));
  const media = async (url?: string) => url ? referenceUrl(config, url) : undefined;
  return {
    model: resolveProviderModel(config, kind, input.model),
    prompt: input.prompt,
    image_urls: refs.length ? refs : undefined,
    aspect_ratio: input.aspectRatio !== "auto" ? input.aspectRatio : undefined,
    quality: kind === "image" ? input.quality : undefined,
    duration: kind === "video" ? input.duration : undefined,
    resolution: kind === "video" ? input.resolution || undefined : undefined,
    sound: kind === "video" ? input.sound : undefined,
    start_frame_url: await media(input.startFrameUrl),
    end_frame_url: await media(input.endFrameUrl),
    video_ref_url: await media(input.videoRefUrl),
    reference_video_urls: input.referenceVideoUrls?.length ? await Promise.all(input.referenceVideoUrls.map((url) => referenceUrl(config, url))) : undefined,
    reference_audio_urls: input.referenceAudioUrls?.length ? await Promise.all(input.referenceAudioUrls.map((url) => referenceUrl(config, url))) : undefined,
  };
}

function modelRequestBody(config: ProviderConfig, kind: "image" | "video", input: GenerationInput, canonical: JsonObject): JsonObject {
  const definition = getProviderModelDefinition(config, kind, input.model);
  const body = { ...definition?.extraBody, ...Object.fromEntries(Object.entries(canonical).filter(([, value]) => value !== undefined)) };
  for (const [field, key] of [["aspectRatio", "aspect_ratio"], ["quality", "quality"], ["duration", "duration"], ["resolution", "resolution"], ["sound", "sound"]] as const) {
    const name = definition?.parameterKeys[field];
    if (name && name !== key && body[key] !== undefined) {
      if (field === "aspectRatio" && name === "size") {
        const size = definition?.sizeMap[String(body[key])];
        if (!size) throw new Error("参数名映射为 size 时，请配置该比例对应的实际图片尺寸。");
        body[name] = size;
      } else body[name] = body[key];
      delete body[key];
    }
  }
  return body;
}

async function saveOutput(config: ProviderConfig, value: unknown, kind: "image" | "video"): Promise<string[]> {
  const folder = kind === "video" ? "videos" : "images";
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const urls: string[] = [];
  for (const entry of entries) {
    const item = record(entry);
    const base64 = item.b64_json ?? item.data;
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : kind === "video" ? "video/mp4" : "image/png";
    if (typeof base64 === "string") {
      urls.push(await uploadBuffer(Buffer.from(base64, "base64"), mimeType, folder));
      continue;
    }
    const source = typeof entry === "string" ? entry : item.url ?? item.image_url ?? item.video_url;
    if (typeof source !== "string") continue;
    if (source.startsWith("data:")) {
      const inline = inlineMedia(await mediaDataUrl(source));
      urls.push(await uploadBuffer(Buffer.from(inline.data, "base64"), inline.mimeType, folder));
      continue;
    }
    const target = new URL(source, `${config.baseUrl}/`);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported generated media URL.");
    const headers = target.origin === new URL(config.baseUrl).origin ? authHeaders(config, kind === "image" ? config.imageProtocol : "openai") : {};
    const response = await providerFetch(target, { headers, redirect: Object.keys(headers).length ? "error" : "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Could not download generated media: HTTP ${response.status}.`);
    urls.push(await uploadBuffer(Buffer.from(await response.arrayBuffer()), response.headers.get("content-type")?.split(";")[0] || mimeType, folder));
  }
  return urls;
}

async function taskOrOutput(config: ProviderConfig, json: unknown, kind: "image" | "video"): Promise<ProviderOutput> {
  const output = readJsonPath(json, config.taskOutputPath) ?? record(json).data;
  const urls = await saveOutput(config, output, kind);
  if (urls.length) return { urls };
  const id = readJsonPath(json, config.taskIdPath);
  if (typeof id !== "string" && typeof id !== "number") throw new Error("Provider returned neither media nor a task ID. Check the configured response paths.");
  return { task: { id: String(id), config } };
}

export async function generateProviderImage(config: ProviderConfig, input: GenerationInput): Promise<ProviderOutput> {
  config = providerRequestConfig(config, "image", input.model);
  input = prepareProviderGeneration(config, "image", input);
  const model = resolveProviderModel(config, "image", input.model);
  const definition = getProviderModelDefinition(config, "image", input.model);
  const requestedQuality = input.quality;
  if (config.imageProtocol === "task") {
    const canonical = await canonicalInput(config, "image", input);
    return taskOrOutput(config, await requestJson(config, config.imagesPath, config.imageBody ? { ...definition?.extraBody, ...record(renderBody(config.imageBody, canonical)) } : modelRequestBody(config, "image", input, canonical), "openai", "", model), "image");
  }
  if (config.imageProtocol === "gemini") {
    const parts: JsonObject[] = [{ text: input.prompt }];
    for (const url of input.imageUrls ?? []) parts.push({ inlineData: inlineMedia(await mediaDataUrl(url)) });
    const imageConfig: JsonObject = {};
    if (input.aspectRatio && input.aspectRatio !== "auto") imageConfig[definition?.parameterKeys.aspectRatio ?? "aspectRatio"] = input.aspectRatio;
    if (requestedQuality) {
      const qualityKey = definition?.parameterKeys.quality ?? "imageSize";
      if (qualityKey === "imageSize" && !/^[124]k$/i.test(requestedQuality)) throw new Error("Gemini 的 imageSize 应为 1k、2k 或 4k；请检查该模型实际支持的尺寸。");
      imageConfig[qualityKey] = qualityKey === "imageSize" ? requestedQuality.toUpperCase() : requestedQuality;
    }
    const json = await requestJson(config, config.imagesPath, {
      ...definition?.extraBody,
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...record(definition?.extraBody.generationConfig), ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    }, "gemini", "", model.replace(/^models\//, ""));
    const candidates = record(json).candidates;
    const images: unknown[] = [];
    if (Array.isArray(candidates)) for (const candidate of candidates) {
      const resultParts = record(record(candidate).content).parts;
      if (Array.isArray(resultParts)) for (const part of resultParts) {
        const inline = record(part).inlineData ?? record(part).inline_data;
        if (inline) images.push(inline);
      }
    }
    const urls = await saveOutput(config, images, "image");
    if (!urls.length) throw new Error("Gemini returned no image. Check the model's image-generation capability and safety response.");
    return { urls };
  }
  const sizeKey = definition?.parameterKeys.aspectRatio ?? "size";
  const legacySizes: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536" };
  let size: string | undefined;
  if (!definition) size = legacySizes[input.aspectRatio ?? "1:1"] ?? "auto";
  else if (sizeKey !== "size") size = input.aspectRatio;
  else if (input.aspectRatio && input.aspectRatio !== "auto") size = definition.sizeMap[input.aspectRatio];
  if (definition && sizeKey === "size" && input.aspectRatio && input.aspectRatio !== "auto" && !size) throw new Error(`请为模型「${definition.name}」配置 ${input.aspectRatio} 对应的实际图片尺寸，不能自动推断上游支持的 size。`);
  const quality = definition ? requestedQuality : ["auto", "low", "medium", "high"].includes(input.quality ?? "") ? input.quality : "auto";
  const prompt = input.prompt;
  const fields: JsonObject = { ...definition?.extraBody, model, prompt, ...(size && size !== "auto" ? { [sizeKey]: size } : {}), ...(quality ? { [definition?.parameterKeys.quality ?? "quality"]: quality } : {}) };
  let payload: JsonObject | FormData = fields;
  let path = config.imagesPath;
  if (input.imageUrls?.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    for (const [index, url] of input.imageUrls.entries()) {
      const media = inlineMedia(await mediaDataUrl(url));
      const extension = media.mimeType.split("/")[1] || "png";
      form.append("image[]", new Blob([new Uint8Array(Buffer.from(media.data, "base64"))], { type: media.mimeType }), `reference-${index}.${extension}`);
    }
    payload = form;
    path = config.editsPath;
  }
  const json = await requestJson(config, path, payload, "openai", "", model);
  const urls = await saveOutput(config, record(json).data, "image");
  if (!urls.length) throw new Error("Provider returned no images in data[]. Check the image API protocol.");
  return { urls };
}

export async function generateProviderVideo(config: ProviderConfig, input: GenerationInput): Promise<ProviderOutput> {
  config = providerRequestConfig(config, "video", input.model);
  input = prepareProviderGeneration(config, "video", input);
  const canonical = await canonicalInput(config, "video", input);
  const definition = getProviderModelDefinition(config, "video", input.model);
  return taskOrOutput(config, await requestJson(config, config.videoPath, config.videoBody ? { ...definition?.extraBody, ...record(renderBody(config.videoBody, canonical)) } : modelRequestBody(config, "video", input, canonical), "openai", "", String(canonical.model)), "video");
}

export async function pollProviderTask(task: ProviderTask, kind: "image" | "video"): Promise<{ pending: true } | { urls: string[] }> {
  if (getProviderConfig(task.config.id).baseUrl !== task.config.baseUrl) throw new Error("This provider was removed or changed while the task was running. Restore it to resume the task.");
  const json = await requestJson(task.config, task.config.statusPath, undefined, "openai", task.id);
  const state = String(readJsonPath(json, task.config.taskStatePath) ?? "").toLowerCase();
  if (["failed", "fail", "error", "cancelled", "canceled"].includes(state)) throw new Error(String(record(json).message ?? record(json).error ?? "Provider generation failed."));
  if (!["success", "succeeded", "completed", "done"].includes(state)) return { pending: true };
  const urls = await saveOutput(task.config, readJsonPath(json, task.config.taskOutputPath), kind);
  if (!urls.length) throw new Error("Task completed without output. Check taskOutputPath in provider settings.");
  return { urls };
}

export async function providerChat(config: ProviderConfig, selected: string, messages: Array<{ role: string; content: string }>, signal: AbortSignal): Promise<Response> {
  config = providerRequestConfig(config, "text", selected);
  const model = resolveProviderModel(config, "chat", selected);
  const definition = getProviderModelDefinition(config, "chat", selected);
  if (definition && messages.some((message) => message.content.length > definition.promptMaxLength)) throw new Error(`This model supports at most ${definition.promptMaxLength} characters per message.`);
  let path = config.chatPath;
  let payload: JsonObject = { ...definition?.extraBody, model, messages, stream: true, ...(definition?.maxOutputTokens ? { [definition.parameterKeys.maxOutputTokens ?? "max_tokens"]: definition.maxOutputTokens } : {}) };
  if (config.chatProtocol === "responses") {
    payload = { store: false, ...definition?.extraBody, model, input: messages, stream: true, ...(definition?.maxOutputTokens ? { [definition.parameterKeys.maxOutputTokens ?? "max_output_tokens"]: definition.maxOutputTokens } : {}) };
  } else if (config.chatProtocol === "anthropic") {
    path = config.chatPath === "chat/completions" ? "messages" : config.chatPath;
    payload = { ...definition?.extraBody, model, max_tokens: definition?.maxOutputTokens ?? 1024, stream: true, system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"), messages: messages.filter((message) => message.role !== "system") };
  } else if (config.chatProtocol === "gemini") {
    path = config.chatPath;
    const system = messages.filter((message) => message.role === "system").map((message) => ({ text: message.content }));
    payload = { ...definition?.extraBody, contents: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), ...(system.length ? { systemInstruction: { parts: system } } : {}), ...(definition?.maxOutputTokens ? { generationConfig: { ...record(definition.extraBody.generationConfig), [definition.parameterKeys.maxOutputTokens ?? "maxOutputTokens"]: definition.maxOutputTokens } } : {}) };
  }
  const upstream = await providerFetch(providerUrl(config, path, "", config.chatProtocol === "gemini" ? model.replace(/^models\//, "") : model), {
    method: "POST",
    headers: { ...authHeaders(config, config.chatProtocol), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutSeconds * 1000)]),
    redirect: "error",
  });
  if (!upstream.ok) {
    const error = await upstream.text();
    throw new Error(`${config.name} HTTP ${upstream.status}: ${error.slice(0, 1000)}`);
  }
  if (config.chatProtocol === "anthropic") return new Response(upstream.body as ReadableStream<Uint8Array>, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emitLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) emitLine(buffer, controller);
    },
  });
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  function emitLine(line: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const json = JSON.parse(data);
    let text = "";
    if (config.chatProtocol === "gemini") {
      const parts = json.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) text = parts.filter((part: { thought?: boolean }) => !part.thought).map((part: { text?: string }) => part.text ?? "").join("");
    } else if (config.chatProtocol === "responses") {
      if (json.type === "error" || json.type === "response.failed" || json.type === "response.incomplete") {
        const message = json.response?.error?.message ?? json.error?.message ?? json.message ?? json.response?.incomplete_details?.reason ?? "Responses request failed.";
        throw new Error(`${config.name}: ${message}`);
      }
      if (json.type === "response.output_text.delta" || json.type === "response.refusal.delta") text = typeof json.delta === "string" ? json.delta : "";
    } else text = json.choices?.[0]?.delta?.content ?? "";
    if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`));
  }
  if (!upstream.body) throw new Error("Provider returned an empty chat stream.");
  return new Response((upstream.body as ReadableStream<Uint8Array>).pipeThrough(transform), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
