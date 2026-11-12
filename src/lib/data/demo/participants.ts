/**
 * Demo-mode waitlist, offers and the atomic join. Mirrors
 * 0052_waitlist_and_offers.sql function by function, so demo mode decides
 * exactly what the database would:
 *
 *   - eventAttendees still means exactly "going"; every other state is a row
 *     in eventParticipants, and nobody has both for one event;
 *   - one capacity definition, seatsTaken() in ./sessions;
 *   - waitlists and offers are for free events; paid events keep their flow.
 *
 * The demo store is single-threaded, so the event row lock has no twin here.
 */
import { DataError, type JoinResult, type OfferResult, type ViewerEventStatus } from "../types";
import { ENDED, FULL, NOT_OPEN, eventsError } from "../events";
import { paymentsError } from "../payments";
import { recordOwnInteraction } from "./interactions";
import { joinEventChat, leaveEventChat } from "./messaging";
import { notifyDemo, notifyOn } from "./notifications";
import { seatsTaken } from "./sessions";
import type { DemoState, EventRow, ParticipantRow } from "./store";

export const OFFER_WINDOW_MS = 2 * 3_600_000;
export const OFFER_CUTOFF_MS = 30 * 60_000;

export interface ParticipantDeps {
  /** Mirrors can_view_event() for that viewer. */
  canViewEvent(event: EventRow, viewerId: string | null): boolean;
}

const ended = (e: EventRow, now: number) => Date.parse(e.endsAt ?? e.startsAt) < now;
const isGoing = (state: DemoState, eventId: string, userId: string) => state.eventAttendees.some((a) => a.eventId === eventId && a.userId === userId);
const rowOf = (state: DemoState, eventId: string, userId: string) => state.eventParticipants.find((p) => p.eventId === eventId && p.userId === userId);
const liveOffer = (p: ParticipantRow | undefined, now: number) => !!p && p.status === "offered" && !!p.offerExpiresAt && Date.parse(p.offerExpiresAt) > now;
const stamp = () => new Date().toISOString();

/** Mirrors check_event_join()'s ticket rule (0022, kept by 0052). */
export function needsTicket(state: DemoState, event: EventRow, userId: string): boolean {
  return event.priceCents != null && event.creatorId !== userId
    && !state.tickets.some((t) => t.eventId === event.id && t.userId === userId && t.status === "paid");
}

function setStatus(p: ParticipantRow, status: ParticipantRow["status"], reason: ParticipantRow["reason"] = null) {
  Object.assign(p, { status, reason, queuePosition: null, offeredAt: null, offerExpiresAt: null, updatedAt: stamp() });
}

/** Mirrors findmaxxing_private.offer_next(). */
export function offerNext(state: DemoState, eventId: string, deps: ParticipantDeps, now = Date.now()): number {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || e.status !== "published" || e.priceCents != null || ended(e, now) || now >= Date.parse(e.startsAt) - OFFER_CUTOFF_MS) return 0;
  const skipped = new Set<string>();
  let offered = 0;
  for (;;) {
    if (e.capacity !== null && seatsTaken(state, eventId, now) >= e.capacity) break;
    const next = state.eventParticipants
      .filter((p) => p.eventId === eventId && p.status === "waitlisted" && !skipped.has(p.userId))
      .sort((a, b) => a.queuePosition! - b.queuePosition!)[0];
    if (!next) break;
    // D-M: suspended, closing, or no longer able to see it: skipped, place kept.
    if (state.suspensions.some((s) => s.userId === next.userId) || !state.profiles.some((p) => p.id === next.userId) || !deps.canViewEvent(e, next.userId)) {
      skipped.add(next.userId);
      continue;
    }
    const offeredAt = new Date(now).toISOString();
    Object.assign(next, {
      status: "offered", queuePosition: null, reason: null, offeredAt, updatedAt: offeredAt,
      offerExpiresAt: new Date(Math.min(now + OFFER_WINDOW_MS, Date.parse(e.startsAt) - OFFER_CUTOFF_MS)).toISOString(),
    });
    notifyDemo(state, next.userId, { type: "event_offer", actorId: null, subjectType: "event", subjectId: e.id, label: e.title, dedupeKey: `event_offer:${e.id}:${next.userId}:${now}` });
    offered += 1;
  }
  return offered;
}

/** Mirrors findmaxxing_private.settle_offers(): returns how many offers expired. */
export function settleOffers(state: DemoState, eventId: string, deps: ParticipantDeps, now = Date.now()): number {
  const e = state.events.find((x) => x.id === eventId);
  let expired = 0;
  const due = state.eventParticipants
    .filter((p) => p.eventId === eventId && p.status === "offered" && Date.parse(p.offerExpiresAt!) <= now)
    .sort((a, b) => a.offeredAt!.localeCompare(b.offeredAt!));
  for (const p of due) {
    const offeredAt = Date.parse(p.offeredAt!);
    setStatus(p, "declined", "expired");
    notifyDemo(state, p.userId, { type: "event_offer_expired", actorId: null, subjectType: "event", subjectId: eventId, label: e?.title ?? null, dedupeKey: `event_offer_expired:${eventId}:${p.userId}:${offeredAt}` });
    expired += 1;
  }
  offerNext(state, eventId, deps, now);
  return expired;
}

/**
 * Adds a going row under the join rule (mirrors check_event_join() and the
 * insert triggers). `actorId` is who is signed in, as auth.uid() is for the
 * triggers: null for service work (a confirmed payment), which notifies nobody.
 */
export function addGoing(state: DemoState, eventId: string, userId: string, actorId: string | null, deps: ParticipantDeps, now = Date.now()): void {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || e.status !== "published") throw new DataError(NOT_OPEN, "invalid");
  if (ended(e, now)) throw new DataError(ENDED, "invalid");
  if (needsTicket(state, e, userId)) throw paymentsError("ticket_required");
  settleOffers(state, eventId, deps, now);
  if (e.capacity !== null && !liveOffer(rowOf(state, eventId, userId), now) && seatsTaken(state, eventId, now) >= e.capacity) throw new DataError(FULL, "full");
  state.eventParticipants = state.eventParticipants.filter((p) => !(p.eventId === eventId && p.userId === userId));
  state.eventAttendees.push({ eventId, userId, createdAt: stamp() });
  joinEventChat(state, eventId, userId);
  if (actorId !== null) notifyOn.join(state, eventId, userId);
  if (actorId === userId) recordOwnInteraction(state, userId, { itemType: "event", itemId: eventId, action: "join" });
}

/** Removes a going row and hands the seat on (mirrors the delete triggers, including offer_seat_after_leave()). */
export function removeGoing(state: DemoState, eventId: string, userId: string, actorId: string | null, deps: ParticipantDeps, now = Date.now()): boolean {
  const idx = state.eventAttendees.findIndex((a) => a.eventId === eventId && a.userId === userId);
  if (idx < 0) return false;
  state.eventAttendees.splice(idx, 1);
  leaveEventChat(state, eventId, userId);
  if (actorId === userId) recordOwnInteraction(state, userId, { itemType: "event", itemId: eventId, action: "leave" });
  offerNext(state, eventId, deps, now);
  return true;
}

function addRow(state: DemoState, eventId: string, userId: string, status: ParticipantRow["status"], reason: ParticipantRow["reason"] = null): ParticipantRow {
  // Mirrors guard_event_participant(): going or a participant row, never both.
  if (isGoing(state, eventId, userId)) throw eventsError("already_going");
  const now = stamp();
  const row: ParticipantRow = { eventId, userId, status, queuePosition: null, offeredAt: null, offerExpiresAt: null, reason, createdAt: now, updatedAt: now };
  state.eventParticipants.push(row);
  return row;
}

/** Mirrors join_event(). The caller has already checked the account is active. */
export function joinEvent(state: DemoState, userId: string, eventId: string, deps: ParticipantDeps, now = Date.now()): JoinResult {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || !deps.canViewEvent(e, userId)) throw eventsError("not_found");
  if (e.status !== "published") throw new DataError(NOT_OPEN, "invalid");
  if (ended(e, now)) throw new DataError(ENDED, "invalid");
  if (isGoing(state, eventId, userId)) return "going";
  if (e.priceCents != null) {
    // Paid events have no waitlist (D-L).
    addGoing(state, eventId, userId, userId, deps, now);
    return "going";
  }
  settleOffers(state, eventId, deps, now);
  const p = rowOf(state, eventId, userId);
  if (liveOffer(p, now) || e.capacity === null || seatsTaken(state, eventId, now) < e.capacity) {
    addGoing(state, eventId, userId, userId, deps, now);
    return "going";
  }
  const row = p ?? addRow(state, eventId, userId, "waitlisted");
  const keep = p?.status === "waitlisted" ? p.queuePosition : null;
  Object.assign(row, { status: "waitlisted", reason: null, offeredAt: null, offerExpiresAt: null, queuePosition: keep ?? (state.waitlistSeq += 1), updatedAt: stamp() });
  return "waitlisted";
}

/** Mirrors leave_event(). */
export function leaveEvent(state: DemoState, userId: string, eventId: string, deps: ParticipantDeps, now = Date.now()): void {
  if (!state.events.some((x) => x.id === eventId)) return;
  if (removeGoing(state, eventId, userId, userId, deps, now)) {
    addRow(state, eventId, userId, "left");
    return;
  }
  const p = rowOf(state, eventId, userId);
  if (!p || p.status === "left") return;
  const wasOffered = p.status === "offered";
  setStatus(p, "left");
  if (wasOffered) settleOffers(state, eventId, deps, now);
}

/** Mirrors set_interest(). */
export function setInterest(state: DemoState, userId: string, eventId: string, on: boolean, deps: ParticipantDeps, now = Date.now()): ViewerEventStatus {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || !deps.canViewEvent(e, userId)) throw eventsError("not_found");
  if (isGoing(state, eventId, userId)) return "going";
  const p = rowOf(state, eventId, userId);
  if (on) {
    if (p && (p.status === "waitlisted" || p.status === "offered" || p.status === "interested")) return p.status;
    if (e.status !== "published" || ended(e, now)) throw new DataError(NOT_OPEN, "invalid");
    if (p) setStatus(p, "interested");
    else addRow(state, eventId, userId, "interested");
    return "interested";
  }
  if (p?.status === "interested") {
    state.eventParticipants = state.eventParticipants.filter((x) => x !== p);
    return null;
  }
  return p?.status ?? null;
}

/** Mirrors accept_offer(). */
export function acceptOffer(state: DemoState, userId: string, eventId: string, deps: ParticipantDeps, now = Date.now()): OfferResult {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || !deps.canViewEvent(e, userId)) throw eventsError("not_found");
  if (isGoing(state, eventId, userId)) return "going";
  const p = rowOf(state, eventId, userId);
  if (p?.status === "declined" && p.reason === "expired") return "offer_expired";
  if (!p || p.status !== "offered") throw eventsError("no_offer");
  if (Date.parse(p.offerExpiresAt!) <= now) {
    settleOffers(state, eventId, deps, now);
    return "offer_expired";
  }
  if (e.status !== "published") throw new DataError(NOT_OPEN, "invalid");
  if (ended(e, now)) throw new DataError(ENDED, "invalid");
  addGoing(state, eventId, userId, userId, deps, now);
  return "going";
}

/** Mirrors decline_offer(). */
export function declineOffer(state: DemoState, userId: string, eventId: string, deps: ParticipantDeps, now = Date.now()): void {
  if (!state.events.some((x) => x.id === eventId)) throw eventsError("not_found");
  const p = rowOf(state, eventId, userId);
  if (!p || p.status !== "offered") return;
  setStatus(p, "declined", "declined");
  settleOffers(state, eventId, deps, now);
}

/** Mirrors host_remove_participant(). `isHost` mirrors can_host_event(). */
export function hostRemoveParticipant(state: DemoState, hostId: string, eventId: string, userId: string, isHost: boolean, deps: ParticipantDeps, now = Date.now()): void {
  const e = state.events.find((x) => x.id === eventId);
  if (!e || !isHost) throw eventsError("not_found");
  if (userId === hostId || userId === e.creatorId) throw eventsError("cannot_remove_host");
  if (isGoing(state, eventId, userId)) {
    if (state.tickets.some((t) => t.eventId === eventId && t.userId === userId && (t.status === "paid" || t.status === "refund_pending"))) throw eventsError("paid_attendee");
    removeGoing(state, eventId, userId, hostId, deps, now);
    addRow(state, eventId, userId, "left", "removed");
    return;
  }
  const p = rowOf(state, eventId, userId);
  if (!p || (p.status !== "waitlisted" && p.status !== "offered" && p.status !== "interested")) return;
  const wasOffered = p.status === "offered";
  setStatus(p, "left", "removed");
  if (wasOffered) settleOffers(state, eventId, deps, now);
}

/** Mirrors expire_offers(): events in id order; returns how many offers expired. */
export function expireOffers(state: DemoState, deps: ParticipantDeps, now = Date.now()): number {
  const events = [...new Set(state.eventParticipants.filter((p) => p.status === "offered" && Date.parse(p.offerExpiresAt!) <= now).map((p) => p.eventId))].sort();
  return events.reduce((n, id) => n + settleOffers(state, id, deps, now), 0);
}

/** Mirrors offers_follow_event_change(): after an edit changed the capacity or the start. */
export function offersFollowEventChange(state: DemoState, e: EventRow, before: { capacity: number | null; startsAt: string }, deps: ParticipantDeps, now = Date.now()): void {
  const startMoved = Date.parse(before.startsAt) !== Date.parse(e.startsAt);
  if (startMoved) {
    for (const p of state.eventParticipants) {
      if (p.eventId !== e.id || p.status !== "offered") continue;
      const cap = Math.max(Date.parse(p.offeredAt!), Date.parse(e.startsAt) - OFFER_CUTOFF_MS);
      p.offerExpiresAt = new Date(Math.min(Date.parse(p.offerExpiresAt!), cap)).toISOString();
    }
  }
  if (e.status === "published" && (before.capacity !== e.capacity || startMoved)) offerNext(state, e.id, deps, now);
}

/** Live offers for the capacity-edit guard (guard_owner_event_change, 0052). */
export function liveOfferCount(state: DemoState, eventId: string, now = Date.now()): number {
  return state.eventParticipants.filter((p) => p.eventId === eventId && liveOffer(p, now)).length;
}

/** The viewer's own state for an event. */
export function viewerStatus(state: DemoState, eventId: string, userId: string | null): { status: ViewerEventStatus; offerExpiresAt: string | null } {
  if (!userId) return { status: null, offerExpiresAt: null };
  if (isGoing(state, eventId, userId)) return { status: "going", offerExpiresAt: null };
  const p = rowOf(state, eventId, userId);
  return { status: p?.status ?? null, offerExpiresAt: p?.status === "offered" ? p.offerExpiresAt : null };
}
