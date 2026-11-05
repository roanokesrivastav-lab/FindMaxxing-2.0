import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";

/**
 * Owner-only delivery of a personal photo (roadmap 2.8). There is no user in the
 * URL: it is always the signed-in viewer's own photo of this place. Anyone else,
 * signed out or not the owner, gets the same 404 as a missing photo. In Supabase
 * mode the response is a redirect to a short-lived signed URL minted with the
 * owner's session (the storage policy admits only the owner's folder); in demo mode
 * the bytes come straight back. Never cached by shared caches.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(_req: Request, ctx: RouteContext<"/api/personal-photos/[placeId]">) {
  const { placeId } = await ctx.params;
  const viewer = await getViewer();
  if (!viewer || !UUID.test(placeId)) return new NextResponse("Not found", { status: 404, headers: NO_STORE });
  const repo = await getRepository();
  const delivery = await repo.personalPhotos.deliver(viewer.id, placeId);
  if (!delivery) return new NextResponse("Not found", { status: 404, headers: NO_STORE });
  if (delivery.kind === "redirect") return new NextResponse(null, { status: 302, headers: { ...NO_STORE, Location: delivery.url } });
  return new NextResponse(delivery.body, { headers: { ...NO_STORE, "Content-Type": delivery.contentType } });
}
