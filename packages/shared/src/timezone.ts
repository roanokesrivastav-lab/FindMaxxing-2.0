/**
 * Pure time-zone arithmetic shared by the web app, the mobile app and the
 * feasibility validator: wall-clock fields of an instant in a zone, the zone's
 * offset at an instant, and the instant for a wall-clock time. Only Intl; no
 * Node or browser APIs. The app re-exports these from src/lib/utils/timezone.ts.
 */

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
