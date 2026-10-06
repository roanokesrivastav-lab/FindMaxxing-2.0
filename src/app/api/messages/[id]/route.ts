import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { uuidSchema } from "@/lib/validation/schemas";

const HEADERS = { "Cache-Control": "private, no-store" };

/**
 * GET /api/messages/[id]?cursor= — the newest page of a conversation (or an
 * older one), plus its members' read receipts. Members only: anyone else gets
 * a 404, as does everyone while the messaging flag is off. Chat views poll
 * this in demo mode; with Supabase they refetch it when Realtime says a
 * message arrived.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/messages/[id]">) {
  if (!featureEnabled("messaging")) return new NextResponse(null, { status: 404 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in first" }, { status: 401, headers: HEADERS });
  const id = uuidSchema.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
  const repo = await getRepository();
  const conversation = await repo.messaging.get(viewer.id, id.data);
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
  const cursor = new URL(req.url).searchParams.get("cursor");
  const page = await repo.messaging.messages(viewer.id, id.data, { cursor });
  return NextResponse.json({ members: conversation.members, canSend: conversation.canSend, page }, { headers: HEADERS });
}
