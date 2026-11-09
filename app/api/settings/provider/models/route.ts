import { NextRequest, NextResponse } from "next/server";
import { fetchProviderModels } from "@/lib/customProvider";
import { getProviderConfig } from "@/lib/providerSettings";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "A saved provider ID is required." }, { status: 400 });
    const config = getProviderConfig(id);
    if (!config.baseUrl) return NextResponse.json({ error: "Save this provider before fetching models." }, { status: 404 });
    return NextResponse.json(await fetchProviderModels(config), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not fetch models." }, { status: 400 });
  }
}
