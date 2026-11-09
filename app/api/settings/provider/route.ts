import { NextRequest, NextResponse } from "next/server";
import { validateProviderConfig } from "@/lib/providerConfig";
import { publicProviderSettings, saveProviderSettings, deleteProviderSettings, activateProvider } from "@/lib/providerSettings";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(publicProviderSettings(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config = validateProviderConfig(body.config);
    if (!config.baseUrl) throw new Error("Base URL is required.");
    if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || /[\r\n]/.test(body.apiKey))) {
      throw new Error("API key must be a single-line string.");
    }
    saveProviderSettings(config, body.apiKey);
    return NextResponse.json({ ok: true, ...publicProviderSettings() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid provider configuration." }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (typeof body.activeId !== "string") throw new Error("Provider ID is required.");
    if (body.kind !== undefined && !["image", "video", "text"].includes(body.kind)) throw new Error("模型类型无效。");
    activateProvider(body.activeId, body.kind);
    return NextResponse.json({ ok: true, ...publicProviderSettings() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not switch provider." }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  deleteProviderSettings(req.nextUrl.searchParams.get("id") ?? undefined);
  return NextResponse.json({ ok: true, ...publicProviderSettings() });
}
