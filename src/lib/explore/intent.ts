/**
 * Intent filter tabs (roadmap 2.4a): When and Area as a travel limit, both backed by data that exists
 * today. Pure and clock-injected so the windows can be tested across DST.
 *
 * When: an event is in a window when it overlaps it, the same rule the discovery queries already use
 * (`coalesce(ends_at, starts_at) >= endsAfter` and `starts_at < startsBefore`). Places carry no opening
 * hours yet, so a When window shows events only, and the tab says so.
 */
import type { GeoBounds } from "@/lib/data/types";
import { zonedParts, zonedTimeToUtc } from "@/lib/utils/timezone";

export type WhenTab = "any" | "now" | "tonight" | "weekend";
export const WHEN_TABS: readonly WhenTab[] = ["any", "now", "tonight", "weekend"];
export const WHEN_LABEL: Record<WhenTab, string> = { any: "Any time", now: "Now", tonight: "Tonight", weekend: "This weekend" };

/** "Now" covers what is on, or starts within this long. */
export const NOW_WINDOW_MS = 60 * 60_000;
/** "Tonight" runs from 5 pm to 4 am local time. */
const TONIGHT_FROM = "17:00";
const TONIGHT_UNTIL = "04:00";

export interface TimeWindow {
  /** ISO instant: the event must not have ended before this. */
  endsAfter: string;
  /** ISO instant: the event must start before this. */
  startsBefore: string;
}

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

export function whenWindow(tab: WhenTab, now: number, timeZone: string): TimeWindow | null {
  if (tab === "any") return null;
  const nowDate = new Date(now);
  if (tab === "now") return { endsAfter: nowDate.toISOString(), startsBefore: new Date(now + NOW_WINDOW_MS).toISOString() };
  const p = zonedParts(now, timeZone);
  if (tab === "tonight") {
    // Before 4 am it is still last night.
    const early = p.hour < 4;
    const evening = early ? ymd(p.year, p.month, p.day - 1) : ymd(p.year, p.month, p.day);
    const morning = early ? ymd(p.year, p.month, p.day) : ymd(p.year, p.month, p.day + 1);
    const from = zonedTimeToUtc(evening, TONIGHT_FROM, timeZone);
    const until = zonedTimeToUtc(morning, TONIGHT_UNTIL, timeZone);
    return { endsAfter: later(from, nowDate).toISOString(), startsBefore: until.toISOString() };
  }
  // This weekend: Friday 5 pm to Monday 00:00 local; on the weekend itself, from now.
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 Sun … 6 Sat
  const toMonday = weekday === 0 ? 1 : 8 - weekday;
  const toFriday = weekday === 0 ? -2 : 5 - weekday; // Saturday: -1, Sunday: -2
  const from = zonedTimeToUtc(ymd(p.year, p.month, p.day + toFriday), TONIGHT_FROM, timeZone);
  const until = zonedTimeToUtc(ymd(p.year, p.month, p.day + toMonday), "00:00", timeZone);
  return { endsAfter: later(from, nowDate).toISOString(), startsBefore: until.toISOString() };
}

/** Does an event overlap a window (same rule as the queries)? */
export function inWindow(e: { startsAt: string; endsAt?: string | null }, w: TimeWindow | null): boolean {
  if (!w) return true;
  const end = Date.parse(e.endsAt ?? e.startsAt);
  return Date.parse(e.startsAt) < Date.parse(w.startsBefore) && end >= Date.parse(w.endsAfter);
}

/** Walking pace for "15 min away": a straight-line estimate, not a route (no routing provider is live). */
export const WALK_METERS_PER_MIN = 80;
export const AREA_MINUTES = 15;
export const AREA_METERS = WALK_METERS_PER_MIN * AREA_MINUTES;

/** The box around a point that holds everything within `meters` (the circle is checked separately). */
export function boundsAround(center: { lat: number; lng: number }, meters: number): GeoBounds {
  // 111 km per degree is slightly under the true figure, so the box always holds the circle.
  const dLat = meters / 111_000;
  const dLng = meters / (111_000 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return { north: center.lat + dLat, south: center.lat - dLat, east: center.lng + dLng, west: center.lng - dLng };
}

/** The one widening offered when the intent tabs leave the map empty: the next wider When, then the area, then the activity. */
export function intentWidening(when: WhenTab, area: boolean, category: string | null): { label: string; action: "when" | "area" | "activity" } | null {
  if (when !== "any") {
    const next: Record<Exclude<WhenTab, "any">, WhenTab> = { now: "tonight", tonight: "weekend", weekend: "any" };
    const to = next[when];
    return { label: to === "any" ? "Show any time" : `Try ${WHEN_LABEL[to].toLowerCase()}`, action: "when" };
  }
  if (area) return { label: "Show the whole map", action: "area" };
  if (category) return { label: "Any activity", action: "activity" };
  return null;
}
