import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../../lib/assistantStream.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { assistantText } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\r\n\r\ndata:{"choices":[{"delta":{"content":"，世界"}}]}');
const stream = new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.subarray(index, index + 1)); controller.close(); } });
let output = "";
for await (const text of assistantText(new Response(stream))) output += text;
assert.equal(output, "你好，世界");
await assert.rejects(async () => { for await (const text of assistantText(new Response('data: {"type":"error","error":{"message":"Upstream failed"}}\n\n'))) void text; }, /Upstream failed/);
let cancelled = false;
const endless = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')); }, cancel() { cancelled = true; } });
for await (const text of assistantText(new Response(endless))) { assert.equal(text, "first"); break; }
assert(cancelled);
console.log("PASS: fragmented UTF-8/SSE, unterminated final event, provider error and reader cancellation.");
