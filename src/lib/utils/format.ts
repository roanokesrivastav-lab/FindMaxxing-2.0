import { calendarDayDiff, zonedFormatter, zonedParts } from "./timezone";

/** Every date/time formatter needs an explicit zone so server and browser agree. */
export type TimeZoneOption = { timeZone: string };

const DATE_LONG: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
const DATE_FULL: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const ZONE_NAME: Intl.DateTimeFormatOptions = { hour: "numeric", timeZoneName: "short" };

/** Format any instant in the given zone, e.g. `formatInZone(iso, tz, { month: "short" })`. */
export function formatInZone(value: string | number | Date, { timeZone }: TimeZoneOption, options: Intl.DateTimeFormatOptions): string {
  return zonedFormatter(timeZone, options).format(typeof value === "string" ? new Date(value) : value);
}

export function formatEventDate(iso: string, tz: TimeZoneOption): string {
  return formatInZone(iso, tz, DATE_LONG);
}
export function formatEventDateLong(iso: string, tz: TimeZoneOption): string {
  return formatInZone(iso, tz, DATE_FULL);
}
export function formatTime(iso: string, tz: TimeZoneOption): string {
  return formatInZone(iso, tz, TIME);
}
/** Short zone label at that instant: "EDT", "EST", "GMT+1". */
export function timeZoneLabel(iso: string, { timeZone }: TimeZoneOption): string {
  return zonedFormatter(timeZone, ZONE_NAME).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
/** "3:00 PM – 5:00 PM EDT"; labels both ends when a DST change falls between them. */
export function formatTimeRange(startsAt: string, endsAt: string | null, tz: TimeZoneOption): string {
  const start = formatTime(startsAt, tz);
  const startZone = timeZoneLabel(startsAt, tz);
  if (!endsAt) return `${start} ${startZone}`;
  const endZone = timeZoneLabel(endsAt, tz);
  return startZone === endZone
    ? `${start} – ${formatTime(endsAt, tz)} ${endZone}`
    : `${start} ${startZone} – ${formatTime(endsAt, tz)} ${endZone}`;
}

/** "Sat, Sep 12 · 3:00 PM EDT" */
export function formatEventWhen(startsAt: string, endsAt: string | null, tz: TimeZoneOption): string {
  return `${formatEventDate(startsAt, tz)} · ${formatTimeRange(startsAt, endsAt, tz)}`;
}

/**
 * Friendly relative label: "Today", "Tomorrow", a weekday, "In 9 days", "Past".
 * Days are calendar days in the given zone; `now` must be the render's shared
 * snapshot (never a fresh clock read) so server and browser agree.
 */
export function relativeDayLabel(iso: string, { timeZone, now }: TimeZoneOption & { now: number }): string {
  const d = new Date(iso);
  const diffDays = calendarDayDiff(now, d, timeZone);
  if (diffDays < 0) return "Past";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return formatInZone(d, { timeZone }, { weekday: "short" });
  return `In ${diffDays} days`;
}

export function formatRating(avg: number): string {
  return avg > 0 ? avg.toFixed(1) : "–";
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** The value format used by <input type="date"> ("YYYY-MM-DD") for `d` in `timeZone`. */
export function toDateInputValue(d: Date | number, { timeZone }: TimeZoneOption): string {
  const p = zonedParts(d, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}
/** The value format used by <input type="time"> ("HH:MM") for `d` in `timeZone`. */
export function toTimeInputValue(d: Date | number, { timeZone }: TimeZoneOption): string {
  const p = zonedParts(d, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** True once the event's end (or start, if no end) is in the past. */
export function eventHasEnded(startsAt: string, endsAt: string | null, now: number): boolean {
  return new Date(endsAt ?? startsAt).getTime() < now;
}
