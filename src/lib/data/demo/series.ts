/**
 * Demo-mode recurring series. Mirrors 0054_event_series.sql function for
 * function: generation four weeks ahead in the series' zone with the
 * first-instant DST rule, owner and backup hosts acting only through these
 * methods, edit-this with overrides, edit-future with the two-phase schedule
 * change (A1.4), cancel-one, end-series, following as its own state, and
 * host-recorded attendance. Single-process, so the locks the database takes
 * have no twin here; everything else does.
 */
import type { DataRepository } from "../repository";
import { DataError, type Event, type EventSeries, type EventSeriesSummary, type OccurrencePatch, type ProfileSummary, type SeriesChangeResult, type SeriesRuleShape } from "../types";
import { eventsError } from "../events";
import { activityDetailsSchema } from "@findmaxxing/shared/activity";
import { addDays, dateDiffDays, localDateOf, occurrenceWindow, seriesDates, seriesRuleSchema, SERIES_HORIZON_DAYS } from "@findmaxxing/shared/series";
import { eventTimeZone } from "@/lib/utils/timezone";
import { newId } from "@/lib/utils/ids";
import type { RateLimitAction } from "@/lib/rateLimits";
import type { DemoState, EventRow, EventSeriesRow } from "./store";
import { canViewPlace } from "./repository";
import { dropEventChats, joinEventChat } from "./messaging";
import { notifyOn } from "./notifications";
import { checkSessionRules, seatsTaken } from "./sessions";

export interface SeriesHelpers {
  persist(): void;
  assertActive(userId: string): void;
  requireProfile(userId: string): unknown;
  rateLimit(userId: string, action: RateLimitAction, amount?: number): () => void;
  toEvent(row: EventRow): Event;
  profileOf(id: string | null): ProfileSummary | null;
  canViewEvent(row: EventRow, viewerId: string | null): boolean;
  refundOnCancel(eventId: string): void;
}

/** Mirrors can_view_series(): the owner unless removed; everyone when the usual place is visible. */
export function canViewSeries(state: DemoState, s: EventSeriesRow, viewerId: string | null): boolean {
  if (viewerId && s.ownerId === viewerId && s.status !== "removed") return true;
  if (s.status === "removed") return false;
  if (!s.placeId) return true;
  const place = state.places.find((p) => p.id === s.placeId);
  return !!place && canViewPlace(state, place, viewerId);
}

/** Mirrors is_series_host(). */
export function isSeriesHost(state: DemoState, seriesId: string, userId: string | null): boolean {
  return !!userId && state.eventSeriesHosts.some((h) => h.seriesId === seriesId && h.userId === userId);
}

/** Mirrors findmaxxing_private.can_host_event() after 0054: the creator, or a current host of the series. */
export function canHostEvent(state: DemoState, e: EventRow, userId: string | null): boolean {
  return !!userId && (e.creatorId === userId || (!!e.seriesId && isSeriesHost(state, e.seriesId, userId)));
}

/** The series as the event page needs it. */
export function seriesSummary(state: DemoState, seriesId: string, viewerId: string | null, profileOf: SeriesHelpers["profileOf"]): EventSeriesSummary | null {
  const s = state.eventSeries.find((x) => x.id === seriesId);
  if (!s || !canViewSeries(state, s, viewerId)) return null;
  return {
    id: s.id, status: s.status, rule: s.rule, timeZone: s.timeZone,
    hosts: hostsOf(state, s.id, profileOf),
    viewerFollows: !!viewerId && state.eventSeriesFollowers.some((f) => f.seriesId === s.id && f.userId === viewerId),
    viewerIsHost: isSeriesHost(state, s.id, viewerId),
  };
}

function hostsOf(state: DemoState, seriesId: string, profileOf: SeriesHelpers["profileOf"]) {
  return state.eventSeriesHosts
    .filter((h) => h.seriesId === seriesId)
    .sort((a, b) => (a.role === b.role ? a.addedAt.localeCompare(b.addedAt) : a.role === "owner" ? -1 : 1))
    .map((h) => ({ user: profileOf(h.userId), role: h.role }))
    .filter((h): h is { user: ProfileSummary; role: "owner" | "backup" } => !!h.user);
}

/** Mirrors findmaxxing_private.occurrence_committed() (A1.4 rules a–g). */
export function occurrenceCommitted(state: DemoState, e: EventRow, now: number): boolean {
  const conversation = state.conversations.find((c) => c.eventId === e.id);
  return state.eventAttendees.some((a) => a.eventId === e.id && a.userId !== e.creatorId)            // a
    || state.tickets.some((t) => t.eventId === e.id)                                                 // b
    || (!!conversation && state.messages.some((m) => m.conversationId === conversation.id))          // c
    || occurrenceAnchors(e.id) > 0                                                                  // d
    || e.status !== "published" || Date.parse(e.startsAt) <= now                                     // e
    || (e.overridden ?? []).length > 0 || (e.decision ?? "open") !== "open" || e.priceCents != null   // f
    || state.eventAttendees.some((a) => a.eventId === e.id && a.attended != null)                    // f
    || state.adCampaigns.some((c) => c.eventId === e.id);                                            // g
}

/** The Outings hook (A1.4 rule d): nothing anchors to an occurrence at this head; 5.x replaces this. */
export function occurrenceAnchors(eventId: string): number {
  return eventId ? 0 : 0;
}

const OVERRIDE_KEYS: [keyof OccurrencePatch, string][] = [
  ["startsAt", "schedule"], ["endsAt", "schedule"], ["title", "details"], ["description", "details"],
  ["placeId", "venue"], ["locationName", "venue"], ["address", "venue"], ["lat", "venue"], ["lng", "venue"],
  ["categorySlug", "category"], ["capacity", "capacity"], ["minAttendance", "session_rules"], ["decisionDeadline", "session_rules"], ["venueStatus", "session_rules"],
  ["activityDetails", "activity"], ["tags", "tags"],
];

export function createDemoSeries(state: DemoState, h: SeriesHelpers): DataRepository["series"] {
  const seriesRow = (id: string) => state.eventSeries.find((s) => s.id === id);
  const occurrenceRows = (seriesId: string) => state.events.filter((e) => e.seriesId === seriesId).sort((a, b) => (a.seriesLocalDate! < b.seriesLocalDate! ? -1 : 1));
  const toSeries = (s: EventSeriesRow): EventSeries => ({
    id: s.id, ownerId: s.ownerId, owner: h.profileOf(s.ownerId), title: s.title, description: s.description, categorySlug: s.categorySlug,
    placeId: s.placeId, locationName: s.locationName, address: s.address, lat: s.lat, lng: s.lng, timeZone: s.timeZone, rule: s.rule,
    startsOn: s.startsOn, endsOn: s.endsOn, capacity: s.capacity, minAttendance: s.minAttendance, decisionLeadMinutes: s.decisionLeadMinutes,
    activityDetails: s.activityDetails, status: s.status, ruleVersion: s.ruleVersion,
    tags: state.eventSeriesTags.filter((t) => t.seriesId === s.id).map((t) => t.interestSlug),
    hosts: hostsOf(state, s.id, h.profileOf), createdAt: s.createdAt,
  });

  /** Mirrors series_patch_check(). */
  const checkPatch = (p: Record<string, unknown>, viewerId: string) => {
    if ("rule" in p && !seriesRuleSchema.safeParse(p.rule).success) throw eventsError("bad_series_rule");
    if ("activityDetails" in p && p.activityDetails != null && !activityDetailsSchema.safeParse(p.activityDetails).success) throw eventsError("bad_activity");
    if ("tags" in p && !Array.isArray(p.tags)) throw eventsError("bad_series");
    if ("placeId" in p && p.placeId && !state.places.some((pl) => pl.id === p.placeId && canViewPlace(state, pl, viewerId))) throw new DataError("Linked place is not visible to you", "forbidden");
  };

  /** Mirrors generate_for_series(): the next four weeks of an active series, each written like a one-off event. */
  const generateFor = (s: EventSeriesRow, now: number, from?: string): number => {
    if (s.status !== "active") return 0;
    const today = localDateOf(now, s.timeZone);
    const first = from && dateDiffDays(today, from) > 0 ? from : today;
    let n = 0;
    for (const d of seriesDates(s.rule, s.startsOn, first, addDays(today, SERIES_HORIZON_DAYS))) {
      if (s.endsOn && d > s.endsOn) continue;
      if (state.events.some((e) => e.seriesId === s.id && e.seriesLocalDate === d)) continue;
      const { startsAt, endsAt } = occurrenceWindow(d, s.rule, s.timeZone);
      if (startsAt.getTime() <= now) continue;
      let deadline: string | null = s.decisionLeadMinutes == null || s.minAttendance == null ? null : new Date(startsAt.getTime() - s.decisionLeadMinutes * 60_000).toISOString();
      // A deadline that would already have passed is not set: a new occurrence is never born cancelled.
      if (deadline && Date.parse(deadline) <= now) deadline = null;
      const at = new Date().toISOString();
      const row: EventRow = {
        id: newId(), title: s.title, description: s.description, placeId: s.placeId, locationName: s.locationName, address: s.address, lat: s.lat, lng: s.lng,
        startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), creatorId: s.ownerId, categorySlug: s.categorySlug, capacity: s.capacity, status: "published",
        createdAt: at, updatedAt: at, timeZone: s.timeZone, activityDetails: s.activityDetails, minAttendance: s.minAttendance, decisionDeadline: deadline,
        venueStatus: "confirmed", decision: "open", cancelReason: null, seriesId: s.id, seriesLocalDate: d, overridden: [], removedWithSeries: false,
      };
      state.events.push(row);
      for (const t of state.eventSeriesTags.filter((x) => x.seriesId === s.id)) state.eventTags.push({ eventId: row.id, interestSlug: t.interestSlug });
      state.eventAttendees.push({ eventId: row.id, userId: s.ownerId, createdAt: at });
      joinEventChat(state, row.id, s.ownerId, at);
      n++;
    }
    return n;
  };

  /** Mirrors lock_occurrence_for_host(): a host, on an open future occurrence. */
  const hostOccurrence = (userId: string, eventId: string, now: number): EventRow => {
    h.assertActive(userId);
    h.requireProfile(userId);
    const e = state.events.find((x) => x.id === eventId);
    if (!e || !e.seriesId || !canHostEvent(state, e, userId)) throw eventsError("not_found");
    if (e.status !== "published" || Date.parse(e.endsAt ?? e.startsAt) <= now) throw eventsError("closed");
    return e;
  };
  /** Mirrors lock_series_for_owner(). */
  const ownerSeries = (userId: string, seriesId: string): EventSeriesRow => {
    h.assertActive(userId);
    h.requireProfile(userId);
    const s = seriesRow(seriesId);
    if (!s || s.ownerId !== userId) throw eventsError("not_found");
    if (s.status === "removed") throw eventsError("closed");
    return s;
  };
  const cancelRow = (e: EventRow, reason: "host" | "series_ended", actorId: string) => {
    e.status = "cancelled";
    e.cancelReason = reason;
    e.decision = "not_happening";
    e.updatedAt = new Date().toISOString();
    h.refundOnCancel(e.id);
    notifyOn.eventCancelled(state, e.id, actorId);
  };
  const whereWhen = (e: EventRow) => JSON.stringify([Date.parse(e.startsAt), e.endsAt ? Date.parse(e.endsAt) : null, e.locationName, e.address, e.lat, e.lng, e.placeId]);

  return {
    async create(input, ownerId) {
      h.assertActive(ownerId);
      h.requireProfile(ownerId);
      const zone = eventTimeZone(input.timeZone);
      if (!zone) throw eventsError("bad_time_zone");
      if (!seriesRuleSchema.safeParse(input.rule).success) throw eventsError("bad_series_rule");
      checkPatch(input as unknown as Record<string, unknown>, ownerId);
      const today = localDateOf(Date.now(), zone);
      const startsOn = input.startsOn ?? today;
      if (startsOn < today) throw eventsError("bad_series_rule");
      if (input.endsOn && input.endsOn < startsOn) throw eventsError("bad_series");
      if (input.capacity != null && (input.capacity < 2 || input.capacity > 5000)) throw eventsError("bad_series");
      checkSessionRules({ capacity: input.capacity ?? null, startsAt: new Date(Date.now() + 86_400_000).toISOString(), minAttendance: input.minAttendance ?? null, decisionDeadline: null }, false);
      if (input.decisionLeadMinutes != null && (input.minAttendance == null || input.decisionLeadMinutes < 15 || input.decisionLeadMinutes > 10080)) throw eventsError("bad_series");
      const counted = h.rateLimit(ownerId, "events");
      const now = new Date().toISOString();
      const s: EventSeriesRow = {
        id: newId(), ownerId, title: input.title, description: input.description, categorySlug: input.categorySlug, placeId: input.placeId ?? null,
        locationName: input.locationName, address: input.address ?? null, lat: input.lat, lng: input.lng, timeZone: zone, rule: input.rule, startsOn, endsOn: input.endsOn ?? null,
        capacity: input.capacity ?? null, minAttendance: input.minAttendance ?? null, decisionLeadMinutes: input.decisionLeadMinutes ?? null,
        activityDetails: input.activityDetails ?? null, status: "active", ruleVersion: 1, createdAt: now, updatedAt: now,
      };
      state.eventSeries.push(s);
      state.eventSeriesHosts.push({ seriesId: s.id, userId: ownerId, role: "owner", addedAt: now });
      for (const t of new Set(input.tags)) state.eventSeriesTags.push({ seriesId: s.id, interestSlug: t });
      generateFor(s, Date.now());
      counted();
      h.persist();
      return toSeries(s);
    },
    async get(id, viewerId = null) {
      const s = seriesRow(id);
      return s && canViewSeries(state, s, viewerId) ? toSeries(s) : null;
    },
    async occurrences(id, viewerId = null) {
      const s = seriesRow(id);
      if (!s || !canViewSeries(state, s, viewerId)) return [];
      return occurrenceRows(id).filter((e) => h.canViewEvent(e, viewerId)).map((e) => h.toEvent(e));
    },
    async updateOccurrence(userId, eventId, patch) {
      const now = Date.now();
      const e = hostOccurrence(userId, eventId, now);
      checkPatch(patch as Record<string, unknown>, userId);
      if ("rule" in patch || "timeZone" in patch) throw eventsError("bad_series");
      const before = whereWhen(e);
      const over = [...(e.overridden ?? [])];
      for (const [k, tag] of OVERRIDE_KEYS) if (k in patch && !over.includes(tag)) over.push(tag);
      const explicit = "minAttendance" in patch || "decisionDeadline" in patch || "venueStatus" in patch;
      const startsAt = patch.startsAt ?? e.startsAt;
      const oldDeadline = e.decisionDeadline ?? null;
      const shifted = !explicit && oldDeadline !== null && Date.parse(startsAt) !== Date.parse(e.startsAt);
      const decisionDeadline = "decisionDeadline" in patch ? (patch.decisionDeadline ?? null)
        : shifted ? new Date(Date.parse(oldDeadline!) + Date.parse(startsAt) - Date.parse(e.startsAt)).toISOString() : oldDeadline;
      const minAttendance = "minAttendance" in patch ? (patch.minAttendance ?? null) : (e.minAttendance ?? null);
      const capacity = "capacity" in patch ? (patch.capacity ?? null) : e.capacity;
      const deadlineSet = explicit && (decisionDeadline === null ? oldDeadline !== null : oldDeadline === null || Date.parse(decisionDeadline) !== Date.parse(oldDeadline));
      checkSessionRules({ capacity, startsAt, minAttendance, decisionDeadline }, deadlineSet, now);
      if (patch.startsAt && Date.parse(patch.endsAt ?? e.endsAt ?? patch.startsAt) <= now) throw new DataError("Events must remain in the future when edited", "invalid");
      if ("capacity" in patch && capacity !== null && (e.capacity === null || capacity < e.capacity) && capacity < seatsTaken(state, e.id, now)) {
        throw new DataError("capacity cannot be below the existing attendee count", "invalid");
      }
      Object.assign(e, {
        title: patch.title ?? e.title, description: patch.description ?? e.description,
        placeId: "placeId" in patch ? (patch.placeId ?? null) : e.placeId, locationName: patch.locationName ?? e.locationName,
        address: "address" in patch ? (patch.address ?? null) : e.address, lat: patch.lat ?? e.lat, lng: patch.lng ?? e.lng,
        categorySlug: patch.categorySlug ?? e.categorySlug, capacity, minAttendance, decisionDeadline, venueStatus: patch.venueStatus ?? e.venueStatus ?? "confirmed",
        activityDetails: "activityDetails" in patch ? (patch.activityDetails ?? null) : (e.activityDetails ?? null),
        startsAt, endsAt: "endsAt" in patch ? (patch.endsAt ?? null) : e.endsAt, overridden: over, updatedAt: new Date().toISOString(),
      });
      if (patch.tags) {
        state.eventTags = state.eventTags.filter((t) => t.eventId !== e.id);
        for (const t of new Set(patch.tags)) state.eventTags.push({ eventId: e.id, interestSlug: t });
      }
      if (whereWhen(e) !== before) notifyOn.eventChanged(state, e.id, userId);
      h.persist();
    },
    async updateFrom(userId, eventId, patch) {
      h.assertActive(userId);
      h.requireProfile(userId);
      const e = state.events.find((x) => x.id === eventId);
      const s = e?.seriesId ? seriesRow(e.seriesId) : undefined;
      if (!e || !s || !isSeriesHost(state, s.id, userId)) throw eventsError("not_found");
      if (s.status !== "active" && s.status !== "paused") throw eventsError("closed");
      checkPatch(patch as Record<string, unknown>, userId);
      if ("timeZone" in patch || "startsAt" in patch || "endsAt" in patch || "decisionDeadline" in patch) throw eventsError("bad_series");
      const now = Date.now();
      const from = e.seriesLocalDate!;
      const today = localDateOf(now, s.timeZone);
      const horizon = addDays(today, SERIES_HORIZON_DAYS);
      const schedule = !!patch.rule && JSON.stringify(patch.rule) !== JSON.stringify(s.rule);
      // 1. The template.
      Object.assign(s, {
        title: patch.title ?? s.title, description: patch.description ?? s.description, categorySlug: patch.categorySlug ?? s.categorySlug,
        placeId: "placeId" in patch ? (patch.placeId ?? null) : s.placeId, locationName: patch.locationName ?? s.locationName,
        address: "address" in patch ? (patch.address ?? null) : s.address, lat: patch.lat ?? s.lat, lng: patch.lng ?? s.lng,
        capacity: "capacity" in patch ? (patch.capacity ?? null) : s.capacity, minAttendance: "minAttendance" in patch ? (patch.minAttendance ?? null) : s.minAttendance,
        decisionLeadMinutes: "decisionLeadMinutes" in patch ? (patch.decisionLeadMinutes ?? null) : s.decisionLeadMinutes,
        activityDetails: "activityDetails" in patch ? (patch.activityDetails ?? null) : s.activityDetails,
        rule: patch.rule ?? s.rule, ruleVersion: s.ruleVersion + (schedule ? 1 : 0), updatedAt: new Date().toISOString(),
      });
      if (patch.tags) {
        state.eventSeriesTags = state.eventSeriesTags.filter((t) => t.seriesId !== s.id);
        for (const t of new Set(patch.tags)) state.eventSeriesTags.push({ seriesId: s.id, interestSlug: t });
      }
      const future = occurrenceRows(s.id).filter((o) => Date.parse(o.startsAt) > now);
      const capacityKept: string[] = [];
      // 2. Template fields on future occurrences from the effective date, skipping overrides.
      for (const r of future.filter((o) => o.seriesLocalDate! >= from && o.status === "published")) {
        const over = r.overridden ?? [];
        const before = whereWhen(r);
        if (!over.includes("details")) { r.title = s.title; r.description = s.description; }
        if (!over.includes("category")) r.categorySlug = s.categorySlug;
        if (!over.includes("venue")) { r.placeId = s.placeId; r.locationName = s.locationName; r.address = s.address; r.lat = s.lat; r.lng = s.lng; }
        if (!over.includes("activity")) r.activityDetails = s.activityDetails;
        if (!over.includes("session_rules")) {
          r.minAttendance = s.minAttendance;
          const lead = s.decisionLeadMinutes == null || s.minAttendance == null ? null : new Date(Date.parse(r.startsAt) - s.decisionLeadMinutes * 60_000).toISOString();
          r.decisionDeadline = lead && Date.parse(lead) > now ? lead : null;
        }
        if (!over.includes("capacity") && r.capacity !== s.capacity) {
          const lowering = s.capacity !== null && (r.capacity === null || s.capacity < r.capacity);
          if (lowering && s.capacity! < seatsTaken(state, r.id, now)) capacityKept.push(r.id);
          else r.capacity = s.capacity;
        }
        if (patch.tags && !over.includes("tags")) {
          state.eventTags = state.eventTags.filter((t) => t.eventId !== r.id);
          for (const t of state.eventSeriesTags.filter((x) => x.seriesId === s.id)) state.eventTags.push({ eventId: r.id, interestSlug: t.interestSlug });
        }
        r.updatedAt = new Date().toISOString();
        if (whereWhen(r) !== before) notifyOn.eventChanged(state, r.id, userId);
      }
      const result: SeriesChangeResult = { ruleVersion: s.ruleVersion, moved: [], kept: [], deleted: 0, created: 0, capacityKept };
      // 3. The schedule: plan, then apply (A1.4).
      if (schedule) {
        const futureIds = new Set(future.map((o) => o.id));
        let retained: string[] = [];
        const del: EventRow[] = [];
        let movable: EventRow[] = [];
        for (const r of occurrenceRows(s.id)) {
          if (!futureIds.has(r.id) || r.seriesLocalDate! < from || r.status !== "published" || (r.overridden ?? []).includes("schedule")) { retained.push(r.seriesLocalDate!); continue; }
          if (occurrenceCommitted(state, r, now)) movable.push(r); else del.push(r);
        }
        const kept: EventRow[] = [];
        let final: Map<string, string>;
        for (;;) {
          const cands = seriesDates(s.rule, s.startsOn, from, horizon)
            .filter((d) => (!s.endsOn || d <= s.endsOn) && !retained.includes(d) && occurrenceWindow(d, s.rule, s.timeZone).startsAt.getTime() > now);
          const claimed = new Set<string>();
          final = new Map();
          for (const m of movable) if (cands.includes(m.seriesLocalDate!)) { final.set(m.id, m.seriesLocalDate!); claimed.add(m.seriesLocalDate!); }
          let keptNow: EventRow | null = null;
          for (const m of [...movable].sort((a, b) => (a.seriesLocalDate! < b.seriesLocalDate! ? -1 : 1))) {
            if (final.has(m.id)) continue;
            let best: string | null = null;
            for (const c of cands) {
              if (claimed.has(c)) continue;
              const dist = Math.abs(dateDiffDays(m.seriesLocalDate!, c));
              if (dist > 6) continue;
              if (best === null || dist < Math.abs(dateDiffDays(m.seriesLocalDate!, best)) || (dist === Math.abs(dateDiffDays(m.seriesLocalDate!, best)) && c > best)) best = c;
            }
            if (best === null) { keptNow = m; break; }
            final.set(m.id, best); claimed.add(best);
          }
          if (!keptNow) break;
          kept.push(keptNow);
          retained = [...retained, keptNow.seriesLocalDate!];
          movable = movable.filter((m) => m.id !== keptNow!.id);
        }
        const all = [...retained, ...final.values()];
        if (new Set(all).size !== all.length) throw eventsError("schedule_conflict");
        // Apply.
        const gone = new Set(del.map((d) => d.id));
        state.events = state.events.filter((x) => !gone.has(x.id));
        state.eventTags = state.eventTags.filter((t) => !gone.has(t.eventId));
        state.eventAttendees = state.eventAttendees.filter((a) => !gone.has(a.eventId));
        dropEventChats(state, gone);
        for (const t of state.tickets) if (t.eventId && gone.has(t.eventId)) t.eventId = null;
        for (const m of movable) {
          const d = final.get(m.id)!;
          const { startsAt, endsAt } = occurrenceWindow(d, s.rule, s.timeZone);
          const before = whereWhen(m);
          if (d !== m.seriesLocalDate || startsAt.toISOString() !== m.startsAt) result.moved.push(m.id);
          if (!(m.overridden ?? []).includes("session_rules") && m.decisionDeadline) {
            m.decisionDeadline = new Date(Date.parse(m.decisionDeadline) + startsAt.getTime() - Date.parse(m.startsAt)).toISOString();
          }
          m.seriesLocalDate = d; m.startsAt = startsAt.toISOString(); m.endsAt = endsAt.toISOString(); m.updatedAt = new Date().toISOString();
          if (whereWhen(m) !== before) notifyOn.eventChanged(state, m.id, userId);
        }
        for (const k of kept) { k.overridden = [...(k.overridden ?? []), "schedule"]; result.kept.push(k.id); }
        result.deleted = del.length;
        result.created = generateFor(s, now, from);
      } else {
        result.created = generateFor(s, now);
      }
      h.persist();
      return result;
    },
    async cancelOccurrence(userId, eventId) {
      const e = hostOccurrence(userId, eventId, Date.now());
      cancelRow(e, "host", userId);
      h.persist();
    },
    async end(userId, seriesId, endsOn = null) {
      const s = ownerSeries(userId, seriesId);
      if (s.status === "ended") return 0;
      let on = endsOn ?? localDateOf(Date.now(), s.timeZone);
      if (on < s.startsOn) on = s.startsOn;
      s.status = "ended"; s.endsOn = on; s.updatedAt = new Date().toISOString();
      const later = occurrenceRows(s.id).filter((o) => o.seriesLocalDate! > on && o.status === "published" && Date.parse(o.startsAt) > Date.now());
      for (const o of later) cancelRow(o, "series_ended", userId);
      h.persist();
      return later.length;
    },
    async setStatus(userId, seriesId, status) {
      const s = ownerSeries(userId, seriesId);
      if (s.status === "ended") throw eventsError("closed");
      s.status = status; s.updatedAt = new Date().toISOString();
      if (status === "active") generateFor(s, Date.now());
      h.persist();
    },
    async addHost(userId, seriesId, hostId) {
      const s = ownerSeries(userId, seriesId);
      if (!hostId || hostId === s.ownerId || !state.profiles.some((p) => p.id === hostId) || state.suspensions.some((x) => x.userId === hostId)) throw eventsError("bad_series");
      if (!state.eventSeriesHosts.some((x) => x.seriesId === s.id && x.userId === hostId)) state.eventSeriesHosts.push({ seriesId: s.id, userId: hostId, role: "backup", addedAt: new Date().toISOString() });
      h.persist();
    },
    async removeHost(userId, seriesId, hostId) {
      const s = ownerSeries(userId, seriesId);
      state.eventSeriesHosts = state.eventSeriesHosts.filter((x) => !(x.seriesId === s.id && x.userId === hostId && x.role === "backup"));
      h.persist();
    },
    async follow(userId, seriesId) {
      h.assertActive(userId);
      h.requireProfile(userId);
      const s = seriesRow(seriesId);
      if (!s || !canViewSeries(state, s, userId)) throw eventsError("not_found");
      if (!state.eventSeriesFollowers.some((f) => f.seriesId === s.id && f.userId === userId)) state.eventSeriesFollowers.push({ seriesId: s.id, userId, createdAt: new Date().toISOString() });
      h.persist();
    },
    async unfollow(userId, seriesId) {
      h.assertActive(userId);
      state.eventSeriesFollowers = state.eventSeriesFollowers.filter((f) => !(f.seriesId === seriesId && f.userId === userId));
      h.persist();
    },
    async recordAttendance(userId, eventId, attendeeId, attended) {
      h.assertActive(userId);
      h.requireProfile(userId);
      const e = state.events.find((x) => x.id === eventId);
      if (!e || !canHostEvent(state, e, userId)) throw eventsError("not_found");
      if (e.status !== "published" || Date.parse(e.endsAt ?? e.startsAt) > Date.now()) throw eventsError("not_ended");
      const a = state.eventAttendees.find((x) => x.eventId === eventId && x.userId === attendeeId);
      if (!a) throw eventsError("not_attending");
      a.attended = attended;
      h.persist();
    },
    async generate(now) {
      const at = Date.parse(now);
      let n = 0;
      for (const s of [...state.eventSeries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (s.status !== "active" || state.suspensions.some((x) => x.userId === s.ownerId)) continue;
        n += generateFor(s, at);
      }
      if (n) h.persist();
      return n;
    },
  };
}

/** Mirrors moderate_target('series', …): removing a series removes its future occurrences; restoring brings exactly those back. */
export function moderateDemoSeries(state: DemoState, seriesId: string, action: "remove" | "restore", refundOnCancel: (eventId: string) => void): { before: string; after: string } | null {
  const s = state.eventSeries.find((x) => x.id === seriesId);
  if (!s) return null;
  const before = s.status === "removed" ? "removed" : "published";
  const now = Date.now();
  if (action === "remove") {
    s.status = "removed";
    for (const e of state.events.filter((x) => x.seriesId === s.id && x.status === "published" && Date.parse(x.startsAt) > now)) {
      e.status = "removed"; e.removedWithSeries = true; e.updatedAt = new Date().toISOString();
      refundOnCancel(e.id);
    }
    return { before, after: "removed" };
  }
  s.status = s.endsOn && s.endsOn < localDateOf(now, s.timeZone) ? "ended" : "active";
  for (const e of state.events.filter((x) => x.seriesId === s.id && x.removedWithSeries)) {
    if (e.status === "removed" && Date.parse(e.startsAt) > now) e.status = "published";
    e.removedWithSeries = false;
    e.updatedAt = new Date().toISOString();
  }
  return { before, after: "published" };
}

export type { SeriesRuleShape };
