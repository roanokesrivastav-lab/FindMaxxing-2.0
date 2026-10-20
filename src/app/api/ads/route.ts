import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { discoveryQuerySchema } from "@/lib/validation/schemas";
import { clientIp } from "@/server/http/clientIp";
import { limiters } from "@/server/limiters";
import { serviceRepository } from "@/server/serviceRepository";
import { formatEventDate } from "@/lib/utils/format";
import { DEFAULT_TIME_ZONE } from "@/lib/utils/timezone";

const HEADERS = { "Cache-Control": "private, no-store" };
const querySchema = z.object({ slot: z.enum(["places", "events"]), bbox: discoveryQuerySchema.shape.bbox, category: discoveryQuerySchema.shape.category });

/**
 * GET /api/ads?slot=places|events&bbox=&category= — at most one sponsored
 * card for a list, chosen from the context in the query alone (no cookies,
 * no history). Served apart from the organic results, which it never
 * touches. Nothing for Plus members, nothing while the ads flag is off, and
 * nothing past a per-IP cap (so reloading can't burn a budget).
 */
export async function GET(req: Request) {
  if (!featureEnabled("ads")) return new NextResponse(null, { status: 404 });
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400, headers: HEADERS });
  const [viewer, repo] = await Promise.all([getViewer(), getRepository()]);
  if (viewer && (await repo.payments.isPlus(viewer.id))) return NextResponse.json({ card: null }, { headers: HEADERS });
  if (limiters().adServe!.consume(await clientIp()) !== null) return NextResponse.json({ card: null }, { headers: HEADERS });
  const { slot, bbox, category } = parsed.data;
  const card = await (await serviceRepository()).ads.serve(slot, { bounds: bbox, categorySlug: category ?? null });
  if (!card) return NextResponse.json({ card: null }, { headers: HEADERS });
  // The target as this viewer may see it (it is public, but stay on the safe side).
  const target = card.kind === "place" ? await repo.places.get(card.targetId, viewer?.id ?? null) : await repo.events.get(card.targetId, viewer?.id ?? null);
  if (!target) return NextResponse.json({ card: null }, { headers: HEADERS });
  const detail = "name" in target
    ? { title: target.name, subtitle: [target.neighborhood, target.city].filter(Boolean).join(", "), href: `/places/${target.id}` }
    : { title: target.title, subtitle: `${formatEventDate(target.startsAt, { timeZone: DEFAULT_TIME_ZONE })} · ${target.locationName}`, href: `/events/${target.id}` };
  return NextResponse.json({ card: { ...card, ...detail } }, { headers: HEADERS });
}
