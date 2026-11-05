/**
 * Roadmap 4.5a: the demo twin of 0055_event_series.sql (series, hosts, followers, generation). Stored in
 * optional collections created on first use, so the persisted demo file needs no version bump.
 * Local wall-clock → instant uses the app's zonedTimeToUtc, which resolves a fall-back repeat to the
 * first instant, exactly as the SQL generator does (D-G); tests hold both to the same vectors.
 */
import type { ActivityDetails, CardStyle, EventNewcomer, SeriesRule, SeriesStatus } from "@findmaxxing/shared/events";
import { SERIES_HORIZON_DAYS } from "@findmaxxing/shared/events";
import { zonedParts, zonedTimeToUtc } from "@/lib/utils/timezone";
import type { DemoState, EventRow } from "./store";

export interface DemoSeries {
  id: string;
  ownerId: string;
  createdAt: string;
  title: string;
  description: string;
  categorySlug: string;
  placeId: string | null;
  locationName: string;
  address: string | null;
  lat: number;
  lng: number;
  timeZone: string;
  rule: SeriesRule;
  capacity: number | null;
  minAttendance: number | null;
  decisionLeadMinutes: number | null;
  activityDetails: ActivityDetails | null;
  newcomer: EventNewcomer | null;
  cardStyle: CardStyle;
  status: SeriesStatus;
  ruleVersion: number;
  tags: string[];
}
export interface DemoSeriesHost { seriesId: string; userId: string; role: "owner" | "backup"; addedAt: string }
export interface DemoSeriesFollower { seriesId: string; userId: string; createdAt: string }

type WithSeries = DemoState & { eventSeries?: DemoSeries[]; eventSeriesHosts?: DemoSeriesHost[]; eventSeriesFollowers?: DemoSeriesFollower[]; eventAttendance?: Record<string, boolean> };

export function seriesList(state: DemoState): DemoSeries[] { const s = state as WithSeries; s.eventSeries ??= []; return s.eventSeries; }
export function seriesHosts(state: DemoState): DemoSeriesHost[] { const s = state as WithSeries; s.eventSeriesHosts ??= []; return s.eventSeriesHosts; }
export function seriesFollowers(state: DemoState): DemoSeriesFollower[] { const s = state as WithSeries; s.eventSeriesFollowers ??= []; return s.eventSeriesFollowers; }
/** event_attendees.attended, keyed "<event>:<user>" (absent = not recorded). */
export function attendanceMap(state: DemoState): Record<string, boolean> { const s = state as WithSeries; s.eventAttendance ??= {}; return s.eventAttendance; }

export const isSeriesHost = (state: DemoState, seriesId: string | null | undefined, userId: string | null | undefined) =>
  !!seriesId && !!userId && seriesHosts(state).some((h) => h.seriesId === seriesId && h.userId === userId);
export const isEventHost = (state: DemoState, ev: EventRow, userId: string | null | undefined) =>
  !!userId && (ev.creatorId === userId || isSeriesHost(state, ev.seriesId, userId));

const DAY = 86_400_000;
const isoDow = (date: string) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const localDate = (now: number, zone: string) => { const p = zonedParts(now, zone); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; };

/** Mirrors public.series_dates(): weekday in the rule and every interval_weeks-th week from starts_on's week. */
export function seriesDates(rule: SeriesRule, from: string, to: string): string[] {
  const monday = addDays(rule.startsOn, -(isoDow(rule.startsOn) - 1));
  const start = from > rule.startsOn ? from : rule.startsOn;
  const end = rule.endsOn && rule.endsOn < to ? rule.endsOn : to;
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const weeks = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * DAY));
    if (rule.weekdays.includes(isoDow(d)) && weeks % rule.intervalWeeks === 0) out.push(d);
  }
  return out;
}

/** Mirrors public.local_to_instant() (spring gap → later clock; fall-back → first instant). */
export const localToInstant = (date: string, time: string, zone: string) => zonedTimeToUtc(date, time, zone);

/** Mirrors generate_series_occurrences(): idempotent per (series, local date); never recreates a date. */
export function generate(state: DemoState, now: number, newId: () => string, seriesId?: string): number {
  let n = 0;
  for (const s of seriesList(state)) {
    if (s.status !== "active" || (seriesId && s.id !== seriesId)) continue;
    const today = localDate(now, s.timeZone);
    for (const d of seriesDates(s.rule, today, addDays(today, SERIES_HORIZON_DAYS))) {
      const start = localToInstant(d, s.rule.startLocal, s.timeZone).getTime();
      if (start <= now) continue;
      if (state.events.some((e) => e.seriesId === s.id && e.seriesLocalDate === d)) continue;
      const iso = new Date(now).toISOString();
      const row: EventRow = {
        id: newId(), title: s.title, description: s.description, placeId: s.placeId, locationName: s.locationName, address: s.address,
        lat: s.lat, lng: s.lng, startsAt: new Date(start).toISOString(), endsAt: new Date(start + s.rule.durationMinutes * 60_000).toISOString(),
        creatorId: s.ownerId, categorySlug: s.categorySlug, capacity: s.capacity, status: "published", createdAt: iso, updatedAt: iso,
        timeZone: s.timeZone, activityDetails: s.activityDetails, newcomer: s.newcomer, cardStyle: s.cardStyle, minAttendance: s.minAttendance,
        decisionDeadline: s.minAttendance !== null && s.decisionLeadMinutes !== null ? new Date(start - s.decisionLeadMinutes * 60_000).toISOString() : null,
        seriesId: s.id, seriesLocalDate: d, overridden: [],
      };
      state.events.push(row);
      for (const t of s.tags) state.eventTags.push({ eventId: row.id, interestSlug: t });
      n++;
    }
  }
  return n;
}
