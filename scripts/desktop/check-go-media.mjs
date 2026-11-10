import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const origin = process.argv[2];
const tools = process.argv[3];
if (!origin || !tools || new URL(origin).port === "41730") throw new Error("Pass an isolated Go server URL (not 41730) and a directory containing real ffmpeg/ffprobe.");
const directory = await mkdtemp(join(tmpdir(), "helios-real-media-"));
let checks = 0;
async function post(endpoint, body) {
  const response = await fetch(origin + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); checks++; return result;
}
try {
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#336699" } }).jpeg().toFile(join(directory, "input.jpg"));
  execFileSync(join(tools, "ffmpeg"), ["-loop", "1", "-i", join(directory, "input.jpg"), "-r", "12", "-t", "2", "-c:v", "mpeg4", "-y", join(directory, "sample.mp4")], { stdio: "ignore" });
  const video = await readFile(join(directory, "sample.mp4"));
  const uploaded = await fetch(origin + "/api/upload-video", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: video });
  const { cdnUrl } = await uploaded.json(); assert.equal(uploaded.status, 200); checks++;
  const ranged = await fetch(origin + cdnUrl, { headers: { Range: "bytes=0-15" } }); assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 16); checks += 2;
  const trimmed = await post("/api/trim-video", { videoUrl: cdnUrl, startTime: 0, endTime: 1 });
  await writeFile(join(directory, "trim.mp4"), Buffer.from(await fetch(origin + trimmed.cdnUrl).then((response) => response.arrayBuffer())));
  const duration = Number(execFileSync(join(tools, "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(directory, "trim.mp4")]).toString());
  assert(duration > 0.8 && duration < 1.2); checks++;
  for (const options of [{ timeSeconds: 0.8 }, { lastFrame: true }]) {
    const result = await post("/api/extract-frame", { videoUrl: cdnUrl, ...options });
    const metadata = await sharp(Buffer.from(await fetch(origin + result.cdnUrl).then((response) => response.arrayBuffer()))).metadata();
    assert.equal(metadata.width, 160); assert.equal(metadata.height, 90); checks += 2;
  }
  for (const format of ["png", "jpeg", "webp", "gif", "tiff", "avif"]) {
    const input = await sharp({ create: { width: 32, height: 16, channels: 4, background: "#33669980" } }).withMetadata({ exif: { IFD0: { Artist: "private artist", ImageDescription: "private metadata" } } }).toFormat(format).toBuffer();
    const response = await fetch(origin + "/api/upload-asset", { method: "POST", headers: { "Content-Type": `image/${format}` }, body: input });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    const metadata = await sharp(Buffer.from(await fetch(origin + result.cdnUrl).then((response) => response.arrayBuffer()))).metadata();
    assert.equal(metadata.width, 32); assert.equal(metadata.height, 16); assert.equal(metadata.exif, undefined, `${format} EXIF`); assert.equal(metadata.xmp, undefined, `${format} XMP`); checks += 5;
  }
  const svg = await readFile("public/HG.svg");
  const response = await fetch(origin + "/api/upload-asset", { method: "POST", headers: { "Content-Type": "image/svg+xml" }, body: svg });
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
  const metadata = await sharp(Buffer.from(await fetch(origin + result.cdnUrl).then((response) => response.arrayBuffer()))).metadata();
  assert.equal(metadata.format, "png"); checks += 2;
  console.log(`PASS: ${checks} real MP4 upload/range/trim/frame and PNG/JPEG/WebP/GIF/TIFF/AVIF/SVG checks.`);
} finally { await rm(directory, { recursive: true, force: true }); }
