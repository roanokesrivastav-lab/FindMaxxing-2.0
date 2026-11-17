/**
 * Recurring series rules (roadmap 4.5a; 0054_event_series.sql). Pure: the same
 * arithmetic the database runs, so the demo repository and the tests can say
 * which local dates a rule produces and when each occurrence starts.
 *
 *   rule = { freq: "weekly", interval: 1–4, weekdays: ISO 1–7, start_local: "HH:MM", duration_minutes: 15–720 }
 *
 * "Every N weeks" counts ISO weeks (Monday start) from the week of starts_on.
 * An occurrence starts at series_local_date + start_local in the series' zone,
 * resolved to the FIRST instant on a fall-back repeat (D-G), which is what
 * zonedTimeToUtc does.
 */
import { z } from "zod";
import { zonedParts, zonedTimeToUtc } from "./timezone";

export const SERIES_HORIZON_DAYS = 28;

export const seriesRuleSchema = z
  .object({
    freq: z.literal("weekly"),
    interval: z.number().int().min(1).max(4),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((w) => new Set(w).size === w.length, "Weekdays must be distinct"),
    start_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a start time"),
    duration_minutes: z.number().int().min(15).max(720),
  })
  .strict();
export type SeriesRule = z.infer<typeof seriesRuleSchema>;

/** "YYYY-MM-DD" for a UTC-midnight Date, or the local calendar date of an instant in a zone. */
export function localDateOf(instant: Date | number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Days between two "YYYY-MM-DD" dates (b − a). */
export function dateDiffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "YYYY-MM-DD" plus n days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** ISO weekday (Monday 1 … Sunday 7) of a "YYYY-MM-DD" date. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday that starts the ISO week of a date. */
function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Local dates the rule produces from `from` to `to` inclusive (never before starts_on). Mirrors findmaxxing_private.series_dates(). */
export function seriesDates(rule: SeriesRule, startsOn: string, from: string, to: string): string[] {
  const out: string[] = [];
  const first = dateDiffDays(startsOn, from) > 0 ? from : startsOn;
  const anchor = weekStart(startsOn);
  const n = dateDiffDays(first, to);
  for (let i = 0; i <= n; i++) {
    const d = addDays(first, i);
    if (!rule.weekdays.includes(isoWeekday(d))) continue;
    if ((dateDiffDays(anchor, weekStart(d)) / 7) % rule.interval !== 0) continue;
    out.push(d);
  }
  return out;
}

/** The instant an occurrence on `date` starts, and when it ends. Mirrors findmaxxing_private.local_to_instant(). */
export function occurrenceWindow(date: string, rule: SeriesRule, timeZone: string): { startsAt: Date; endsAt: Date } {
  const startsAt = zonedTimeToUtc(date, rule.start_local, timeZone);
  return { startsAt, endsAt: new Date(startsAt.getTime() + rule.duration_minutes * 60_000) };
}
