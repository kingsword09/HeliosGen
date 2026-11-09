import { NextRequest, NextResponse } from "next/server";
import { configuredProvider, generateProviderVideo } from "@/lib/customProvider";
import { prepareProviderGeneration } from "@/lib/providerRequest";
import { startProviderJob } from "@/lib/providerJobs";
import { GUEST_USER_ID } from "@/lib/guestMode";

export const runtime = "nodejs";

function urls(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((url) => typeof url !== "string")) throw new Error("Reference media must be an array of URL strings.");
  return value;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.debugOnly) return NextResponse.json({ ok: true });
    const model = body.videoModel || body.model || "custom-video";
    const prompt = body.prompt ?? "";
    if (typeof model !== "string" || typeof prompt !== "string") throw new Error("Model and prompt must be strings.");
    const duration = body.duration === undefined ? undefined : Number(body.duration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new Error("Duration must be a positive number.");
    const provider = configuredProvider(model, "video");
    const imageUrls = [...urls(body.referenceImageUrls ?? body.imageUrls)];
    for (const resource of body.resources ?? []) if (typeof resource.url === "string") imageUrls.push(resource.url);
    for (const element of body.klingElements ?? []) imageUrls.push(...urls(element.imageUrls));
    const input = prepareProviderGeneration(provider, "video", {
      model, prompt, imageUrls, aspectRatio: body.aspectRatio ?? body.aspect_ratio, duration,
      resolution: body.resolution, sound: body.sound === undefined ? undefined : !!body.sound,
      startFrameUrl: body.startFrameUrl, endFrameUrl: body.endFrameUrl, videoRefUrl: body.videoRefUrl,
      referenceVideoUrls: urls(body.referenceVideoUrls), referenceAudioUrls: urls(body.referenceAudioUrls),
    });
    const taskId = startProviderJob("video", () => generateProviderVideo(provider, input), {
      user_id: GUEST_USER_ID, model, prompt, aspect_ratio: input.aspectRatio ?? "auto", duration: input.duration,
      sound: input.sound, reference_image_urls: imageUrls,
    });
    return NextResponse.json({ taskId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Provider video generation failed." }, { status: 400 });
  }
}
