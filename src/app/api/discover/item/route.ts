import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { uuidSchema } from "@/lib/validation/schemas";

const HEADERS = { "Cache-Control": "private, no-store" };

/**
 * GET /api/discover/item?kind=place|event&id= — one full record for a map pin
 * whose details are not already loaded. Visibility applies as on the detail
 * pages; anything the viewer cannot see is a 404.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const kind = params.get("kind");
  const id = uuidSchema.safeParse(params.get("id"));
  if ((kind !== "place" && kind !== "event") || !id.success) {
    return NextResponse.json({ error: "Invalid item" }, { status: 400, headers: HEADERS });
  }
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const viewerId = viewer?.id ?? null;
  const item = kind === "place" ? await repo.places.get(id.data, viewerId) : await repo.events.get(id.data, viewerId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
  return NextResponse.json(item, { headers: HEADERS });
}
