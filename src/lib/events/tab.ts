/**
 * Roadmap 1.5: the Quiet-utility Events tab. Pure helpers shared by the server page and the client
 * tab: day buckets, the "events you usually go to" rule and the availability text. No clock reads:
 * every function takes the render's shared `now` so server and browser agree.
 */
import type { Event } from "@/lib/data/types";
import { calendarDayDiff, zonedFormatter } from "@/lib/utils/timezone";
import { eventHasEnded } from "@/lib/utils/format";
import { formatPrice } from "@/lib/data/payments";

export const DAY_BUCKETS = ["Today", "Tomorrow", "This weekend", "Later"] as const;
export type DayBucket = (typeof DAY_BUCKETS)[number];
type Time = { timeZone: string; now: number };

/** How far back a past event still counts toward "usually go to". */
export const USUAL_LOOKBACK_DAYS = 120;

function weekday(instant: number, timeZone: string): number {
  // 0 = Sunday … 6 = Saturday, in the zone.
  const name = zonedFormatter(timeZone, { weekday: "short" }).format(instant);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/**
 * Today / Tomorrow / This weekend / Later, by calendar day in the viewer's zone. "This weekend" is the
 * coming Saturday and Sunday (within the next 6 days) when they are not already Today or Tomorrow.
 * An event that started earlier today, or is still running from a past day, counts as Today.
 */
export function dayBucket(startsAt: string, { timeZone, now }: Time): DayBucket {
  const at = Date.parse(startsAt);
  const diff = calendarDayDiff(now, at, timeZone);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  // The weekend of the current week: the week ends on Sunday, so on a Sunday nothing is left of it.
  const daysToSunday = (7 - weekday(now, timeZone)) % 7;
  const wd = weekday(at, timeZone);
  if (diff <= daysToSunday && (wd === 6 || wd === 0)) return "This weekend";
  return "Later";
}

/** Groups in bucket order, each soonest first; empty buckets are left out. */
export function groupByBucket<T extends Pick<Event, "startsAt" | "id">>(events: T[], time: Time): { bucket: DayBucket; events: T[] }[] {
  const by = new Map<DayBucket, T[]>();
  for (const e of [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id))) {
    const b = dayBucket(e.startsAt, time);
    by.set(b, [...(by.get(b) ?? []), e]);
  }
  return DAY_BUCKETS.filter((b) => by.has(b)).map((bucket) => ({ bucket, events: by.get(bucket)! }));
}

export interface UsualEvent {
  event: Event;
  /** The past event it is like (or the followed series), for the plain "why" line. */
  like: { id: string; title: string };
  /** 4.5b: shown because the viewer follows its series. */
  followed?: boolean;
}

/**
 * "Events you usually go to" (1.5 rule, recorded in docs/features/1.5.md): an upcoming published event
 * the viewer has not joined, with the same category and the same venue or host as an event they went
 * to that ended within USUAL_LOOKBACK_DAYS (cancelled ones don't count). Only the viewer's own history
 * is used. `candidates` must already be filtered to what the viewer can see.
 */
export function usualEvents(joined: Event[], candidates: Event[], now: number, followedSeries: { id: string; title: string }[] = []): UsualEvent[] {
  const joinedIds = new Set(joined.map((e) => e.id));
  const since = now - USUAL_LOOKBACK_DAYS * 86_400_000;
  const history = joined
    .filter((e) => e.status === "published" && eventHasEnded(e.startsAt, e.endsAt, now) && Date.parse(e.endsAt ?? e.startsAt) >= since)
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const out: UsualEvent[] = [];
  for (const c of candidates) {
    if (joinedIds.has(c.id) || c.status !== "published" || eventHasEnded(c.startsAt, c.endsAt, now)) continue;
    // 4.5b: a series you follow, or a series you went to before, is a usual event too.
    const followed = c.seriesId ? followedSeries.find((f) => f.id === c.seriesId) : undefined;
    if (followed) { out.push({ event: c, like: { id: followed.id, title: followed.title }, followed: true }); continue; }
    const like = history.find(
      (h) => (!!c.seriesId && h.seriesId === c.seriesId)
        || (h.categorySlug === c.categorySlug && ((!!h.placeId && h.placeId === c.placeId) || (!!h.creatorId && h.creatorId === c.creatorId))),
    );
    if (like) out.push({ event: c, like: { id: like.id, title: like.title } });
  }
  return out;
}

export type Availability =
  | { kind: "cancelled"; text: "Cancelled" }
  | { kind: "full"; text: "Full" }
  | { kind: "spots"; text: string; spots: number }
  | { kind: "open"; text: "Open" };

/** What a row says about room, from capacity and the going count only. */
export function availability(e: Pick<Event, "status" | "capacity" | "attendeeCount">): Availability {
  if (e.status === "cancelled") return { kind: "cancelled", text: "Cancelled" };
  if (e.capacity === null) return { kind: "open", text: "Open" };
  const spots = Math.max(0, e.capacity - e.attendeeCount);
  if (spots === 0) return { kind: "full", text: "Full" };
  return { kind: "spots", text: `${spots} spot${spots === 1 ? "" : "s"}`, spots };
}

/** "$12" for a priced event, null when free (or payments are off and the caller passes null). */
export function priceText(priceCents: number | null | undefined): string | null {
  return priceCents ? formatPrice(priceCents) : null;
}
