import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";

/**
 * Authorized delivery for place photos. Objects are private, so every request
 * re-checks that the viewer may see the photo's place (RLS in Supabase mode,
 * canViewPlace in demo mode) before handing over bytes. Bytes go through this
 * route in both modes — no reusable signed URLs that could outlive a
 * visibility change. Hidden and missing photos are indistinguishable: both 404.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Responses depend on who is asking, so shared caches must never keep them.
// `no-cache` (not max-age) makes the browser come back before every reuse, so
// the visibility check runs on the very next request after access is lost. A
// still-authorized viewer with a cached copy gets a 304 and no Storage download.
const PRIVATE_CACHE = "private, no-cache";

// Object names are random and never overwritten, so the path identifies the bytes.
function etagFor(storagePath: string) {
  return `"${createHash("sha256").update(storagePath).digest("base64url").slice(0, 22)}"`;
}

function notFound() {
  return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request, ctx: RouteContext<"/api/photos/[id]">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();

  const viewer = await getViewer();
  const repo = await getRepository();
  const object = await repo.places.getPhotoObject(id, viewer?.id ?? null);
  if (!object) return notFound();

  // Only after authorization: a revoked viewer must get the 404, not a 304.
  const etag = etagFor(object.storagePath);
  if (req.headers.get("if-none-match")?.split(",").some((t) => t.trim() === etag)) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": PRIVATE_CACHE } });
  }

  const delivery = await repo.storage.deliverPlacePhoto(object.storagePath);
  if (!delivery) return notFound();

  return new NextResponse(delivery.body, {
    headers: { "Content-Type": delivery.contentType, "Cache-Control": PRIVATE_CACHE, ETag: etag },
  });
}
