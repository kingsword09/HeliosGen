import { NextRequest, NextResponse } from "next/server";
import { getOnlineModelCatalog } from "@/lib/onlineModelCatalog";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const catalog = await getOnlineModelCatalog(request.nextUrl.searchParams.get("refresh") === "1");
    return NextResponse.json(catalog, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法加载在线模型目录。" }, { status: 502 });
  }
}
