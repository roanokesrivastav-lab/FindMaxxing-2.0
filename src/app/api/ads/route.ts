import { NextResponse } from "next/server";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { discoveryQuerySchema } from "@/lib/validation/schemas";
import { clientIp } from "@/server/http/clientIp";
import { abuseHash, consumeAbuse } from "@/server/limiters";
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
 * nothing past a durable per-IP cap shared by every server instance (so
 * reloading can't burn a budget). Over the cap, or if the limiter can't be
 * reached, the slot is empty: never an error, never billed.
 */
export async function GET(req: Request) {
  if (!featureEnabled("ads")) return new NextResponse(null, { status: 404 });
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400, headers: HEADERS });
  const [viewer, repo] = await Promise.all([getViewer(), getRepository()]);
  if (viewer && (await repo.payments.isPlus(viewer.id))) return NextResponse.json({ card: null }, { headers: HEADERS });
  if (!(await adAllowed(await clientIp()))) return NextResponse.json({ card: null }, { headers: HEADERS });
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

/** 120 cards per IP per hour (ABUSE_LIMITS.ads). Requests with no trusted IP share one "unknown" key. */
async function adAllowed(ip: string): Promise<boolean> {
  try {
    return (await consumeAbuse([{ action: "ads", key: abuseHash("ip", ip) }])) === 0;
  } catch {
    return false; // limiter unavailable: suppress the card rather than serve unbounded
  }
}
