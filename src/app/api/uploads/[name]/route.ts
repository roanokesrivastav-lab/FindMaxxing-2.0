import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDataMode } from "@/lib/config";

/**
 * Serves public demo-mode uploads (avatars) from .data/uploads.
 * Place photos are private and go through /api/photos/[id], which checks
 * place visibility. In Supabase mode uploads go to Storage and this route is unused.
 */
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function GET(_req: Request, ctx: RouteContext<"/api/uploads/[name]">) {
  if (getDataMode() !== "demo") return new NextResponse("Not found", { status: 404 });
  const { name } = await ctx.params;
  // Strict allowlist: generated names only (no path traversal possible).
  if (!/^avatars-[0-9a-f]{8}-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(name)) {
    return new NextResponse("Not found", { status: 404 });
  }
  try {
    const file = await readFile(path.join(process.cwd(), ".data", "uploads", name));
    const ext = name.split(".").pop() ?? "jpg";
    return new NextResponse(new Uint8Array(file), {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
