/**
 * Time-zone primitives shared by server and client rendering.
 *
 * Never format a user-visible date with the runtime's local zone: the server
 * runs in UTC and the browser in the viewer's zone, so the same render would
 * produce different text (React hydration error 418). Every formatter takes
 * an explicit IANA zone instead.
 */

// The arithmetic lives in the shared package (also used by the feasibility validator and mobile).
import { zonedParts, zonedTimeToUtc } from "@findmaxxing/shared/timezone";
export { zonedFormatter, zonedParts, zoneOffsetMinutes, zonedTimeToUtc, type ZonedParts } from "@findmaxxing/shared/timezone";

/** The launch city's zone; used until the browser reports the viewer's own. */
export const DEFAULT_TIME_ZONE = "America/New_York";
/** Cookie the browser writes so later server renders use the viewer's zone. */
export const TIME_ZONE_COOKIE = "fm_tz";

const valid = new Map<string, boolean>();

/** Returns the zone if it is a real IANA zone this runtime supports, else null. */
export function normalizeTimeZone(input: string | null | undefined): string | null {
  if (!input || input.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(input)) return null;
  let ok = valid.get(input);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input });
      ok = true;
    } catch {
      ok = false;
    }
    valid.set(input, ok);
  }
  return ok ? input : null;
}

/**
 * A zone the database accepts for events.time_zone (valid_time_zone(), 0050):
 * "UTC" or an "Area/Location" name. Legacy names a browser may report ("GMT",
 * "EST5EDT") are real zones but not accepted there, so they return null.
 */
export function eventTimeZone(input: string | null | undefined): string | null {
  const zone = normalizeTimeZone(input);
  return zone && (zone === "UTC" || /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(zone)) ? zone : null;
}

/** Whole calendar days from `from` to `to`, each taken in `timeZone` (DST-safe). */
export function calendarDayDiff(from: Date | number, to: Date | number, timeZone: string): number {
  const a = zonedParts(from, timeZone);
  const b = zonedParts(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** UTC instant of the next local midnight after `now` in `timeZone`. */
export function startOfNextDay(now: Date | number, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(next.toISOString().slice(0, 10), "00:00", timeZone);
}
