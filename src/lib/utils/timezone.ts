/**
 * Time-zone primitives shared by server and client rendering.
 *
 * Never format a user-visible date with the runtime's local zone: the server
 * runs in UTC and the browser in the viewer's zone, so the same render would
 * produce different text (React hydration error 418). Every formatter takes
 * an explicit IANA zone instead.
 */

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

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached en-US formatter pinned to `timeZone`. */
export function zonedFormatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Wall-clock calendar fields of `date` as seen in `timeZone`. */
export function zonedParts(date: Date | number, timeZone: string): ZonedParts {
  const parts = zonedFormatter(timeZone, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** Whole calendar days from `from` to `to`, each taken in `timeZone` (DST-safe). */
export function calendarDayDiff(from: Date | number, to: Date | number, timeZone: string): number {
  const a = zonedParts(from, timeZone);
  const b = zonedParts(to, timeZone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/**
 * Minutes to add to a wall-clock time in `timeZone` to reach UTC at `instant`
 * (same sign convention as Date#getTimezoneOffset: New York in winter is 300).
 */
export function zoneOffsetMinutes(instant: Date | number, timeZone: string): number {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  const p = zonedParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((Math.floor(ms / 60_000) * 60_000 - wall) / 60_000);
}

/**
 * The UTC instant for a wall-clock `date` ("YYYY-MM-DD") and `time` ("HH:MM")
 * in `timeZone`. A time skipped by a spring-forward gap resolves to the same
 * clock reading in the earlier offset (e.g. 2:30 AM becomes 3:30 AM EDT); a
 * repeated fall-back hour resolves to its first occurrence.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const wall = Date.parse(`${date}T${time}:00Z`);
  // Probe offsets just before and after the guess; the earlier one wins ties.
  const first = zoneOffsetMinutes(wall - 12 * 3_600_000, timeZone);
  const second = zoneOffsetMinutes(wall + 12 * 3_600_000, timeZone);
  for (const offset of [first, second]) {
    const candidate = wall + offset * 60_000;
    if (zoneOffsetMinutes(candidate, timeZone) === offset) return new Date(candidate);
  }
  return new Date(wall + first * 60_000);
}

/** UTC instant of the next local midnight after `now` in `timeZone`. */
export function startOfNextDay(now: Date | number, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(next.toISOString().slice(0, 10), "00:00", timeZone);
}
