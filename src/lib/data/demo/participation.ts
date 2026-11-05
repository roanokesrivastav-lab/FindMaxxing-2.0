/**
 * Roadmap 4.4: the demo twin of 0054_event_waitlist_offers.sql. One process holds the whole store, so
 * the SQL row locks have no equivalent here; the rules (seats_taken, offers, expiry, queue order, paid
 * events excluded) are mirrored one for one and tested against the same cases.
 *
 * Participants live in an optional collection (`state.eventParticipants`), created on first use, so the
 * persisted store needs no version bump.
 */
import { DataError } from "@/lib/data/types";
import type { JoinOutcome, ParticipantStatus } from "@findmaxxing/shared/events";
import { OFFER_CUTOFF_MINUTES, OFFER_WINDOW_MINUTES } from "@findmaxxing/shared/events";
import type { DemoState, EventRow } from "./store";
import { notifyDemo } from "./notifications";

export interface DemoParticipant {
  eventId: string;
  userId: string;
  status: ParticipantStatus;
  queuePosition: number | null;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  reason: "declined" | "expired" | "removed" | "cancelled" | null;
  updatedAt: string;
}

type WithParticipants = DemoState & { eventParticipants?: DemoParticipant[]; eventQueueSeq?: number };

export function participants(state: DemoState): DemoParticipant[] {
  const s = state as WithParticipants;
  s.eventParticipants ??= [];
  return s.eventParticipants;
}
function nextQueue(state: DemoState): number {
  const s = state as WithParticipants;
  s.eventQueueSeq = (s.eventQueueSeq ?? 0) + 1;
  return s.eventQueueSeq;
}
export function participantOf(state: DemoState, eventId: string, userId: string): DemoParticipant | undefined {
  return participants(state).find((p) => p.eventId === eventId && p.userId === userId);
}
function removeParticipant(state: DemoState, eventId: string, userId: string) {
  const list = participants(state);
  const i = list.findIndex((p) => p.eventId === eventId && p.userId === userId);
  if (i >= 0) list.splice(i, 1);
}
function upsert(state: DemoState, eventId: string, userId: string, patch: Partial<DemoParticipant>, now: number) {
  if (state.eventAttendees.some((a) => a.eventId === eventId && a.userId === userId)) throw new DataError("Already going", "conflict");
  const existing = participantOf(state, eventId, userId);
  const row: DemoParticipant = existing ?? { eventId, userId, status: "interested", queuePosition: null, offeredAt: null, offerExpiresAt: null, reason: null, updatedAt: "" };
  Object.assign(row, patch, { updatedAt: new Date(now).toISOString() });
  if (!existing) participants(state).push(row);
  return row;
}

const isGoing = (state: DemoState, eventId: string, userId: string) => state.eventAttendees.some((a) => a.eventId === eventId && a.userId === userId);
const liveOffer = (p: DemoParticipant | undefined, now: number) => !!p && p.status === "offered" && !!p.offerExpiresAt && Date.parse(p.offerExpiresAt) > now;

/** Mirrors event_seats_held(): live offers + live pending paid holds. */
export function seatsHeld(state: DemoState, eventId: string, now: number): number {
  return participants(state).filter((p) => p.eventId === eventId && liveOffer(p, now)).length
    + state.tickets.filter((t) => t.eventId === eventId && t.status === "pending" && Date.parse(t.expiresAt) > now).length;
}
/** Mirrors seats_taken(). */
export function seatsTaken(state: DemoState, eventId: string, now: number): number {
  return state.eventAttendees.filter((a) => a.eventId === eventId).length + seatsHeld(state, eventId, now);
}
export function waitlistCount(state: DemoState, eventId: string): number {
  return participants(state).filter((p) => p.eventId === eventId && p.status === "waitlisted").length;
}

/** Mirrors offer_next(): free published events, before the cutoff, FIFO, skipping the ineligible (D-M). */
export function offerNext(state: DemoState, ev: EventRow, now: number, canView: (userId: string) => boolean): number {
  if (ev.status !== "published" || ev.priceCents != null) return 0;
  const cutoff = Date.parse(ev.startsAt) - OFFER_CUTOFF_MINUTES * 60_000;
  let n = 0;
  const skip = new Set<string>();
  for (;;) {
    if (now >= cutoff) break;
    if (ev.capacity !== null && seatsTaken(state, ev.id, now) >= ev.capacity) break;
    const cand = participants(state)
      .filter((p) => p.eventId === ev.id && p.status === "waitlisted" && !skip.has(p.userId))
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))[0];
    if (!cand) break;
    if (state.suspensions.some((s) => s.userId === cand.userId) || !canView(cand.userId)) {
      skip.add(cand.userId);
      continue;
    }
    cand.status = "offered";
    cand.offeredAt = new Date(now).toISOString();
    cand.offerExpiresAt = new Date(Math.min(now + OFFER_WINDOW_MINUTES * 60_000, cutoff)).toISOString();
    cand.reason = null;
    cand.updatedAt = cand.offeredAt;
    notifyDemo(state, cand.userId, { type: "event_offer", actorId: null, subjectType: "event", subjectId: ev.id, label: ev.title, dedupeKey: `event_offer:${ev.id}:${now}`, detail: "A spot opened up for you" });
    n++;
  }
  return n;
}

export interface JoinHooks {
  canView: (userId: string) => boolean;
  /** Inserts the going row with its side effects (chat, host notice, own interaction). */
  addAttendee: (userId: string) => void;
}

/** Mirrors join_event() after its visibility/price checks (the repository does those). */
export function joinEvent(state: DemoState, ev: EventRow, userId: string, now: number, h: JoinHooks): JoinOutcome {
  if (isGoing(state, ev.id, userId)) return "going";
  const own = participantOf(state, ev.id, userId);
  if (liveOffer(own, now)) {
    removeParticipant(state, ev.id, userId);
    h.addAttendee(userId);
    return "going";
  }
  if (ev.capacity !== null) offerNext(state, ev, now, h.canView);
  if (ev.capacity === null || seatsTaken(state, ev.id, now) < ev.capacity) {
    removeParticipant(state, ev.id, userId);
    h.addAttendee(userId);
    return "going";
  }
  if (own?.status === "waitlisted") return "waitlisted";
  upsert(state, ev.id, userId, { status: "waitlisted", queuePosition: nextQueue(state), offeredAt: null, offerExpiresAt: null, reason: null }, now);
  return "waitlisted";
}

/** Mirrors leave_event(). `removeAttendee` deletes the going row with its side effects. */
export function leaveEvent(state: DemoState, ev: EventRow | undefined, userId: string, now: number, removeAttendee: () => boolean, canView: (u: string) => boolean): "left" {
  if (removeAttendee()) {
    if (ev) offerNext(state, ev, now, canView);
    return "left";
  }
  const own = ev ? participantOf(state, ev.id, userId) : undefined;
  if (ev && own && (own.status === "offered" || own.status === "waitlisted" || own.status === "interested")) {
    const wasOffered = own.status === "offered";
    Object.assign(own, { status: "left", offeredAt: null, offerExpiresAt: null, reason: null, updatedAt: new Date(now).toISOString() });
    if (wasOffered) offerNext(state, ev, now, canView);
  }
  return "left";
}

export function setInterest(state: DemoState, ev: EventRow, userId: string, on: boolean, now: number): "going" | "interested" | "waitlisted" | "offered" | "none" {
  if (isGoing(state, ev.id, userId)) return "going";
  const own = participantOf(state, ev.id, userId);
  if (own && (own.status === "waitlisted" || own.status === "offered")) return own.status;
  if (on) {
    if (ev.status !== "published" || Date.parse(ev.endsAt ?? ev.startsAt) < now) throw new DataError("Event is not open", "invalid");
    upsert(state, ev.id, userId, { status: "interested", queuePosition: null, offeredAt: null, offerExpiresAt: null, reason: null }, now);
    return "interested";
  }
  if (own?.status === "interested") removeParticipant(state, ev.id, userId);
  return "none";
}

/** Mirrors accept_offer(): converts only a live offer; past it, the person stays off the list. */
export function acceptOffer(state: DemoState, ev: EventRow, userId: string, now: number, h: JoinHooks): "going" | "offer_expired" {
  if (isGoing(state, ev.id, userId)) return "going";
  const own = participantOf(state, ev.id, userId);
  if (liveOffer(own, now) && ev.status === "published" && Date.parse(ev.endsAt ?? ev.startsAt) >= now) {
    removeParticipant(state, ev.id, userId);
    h.addAttendee(userId);
    return "going";
  }
  if (own?.status === "offered") {
    own.status = "declined";
    own.reason = "expired";
    own.updatedAt = new Date(now).toISOString();
    notifyDemo(state, userId, { type: "event_offer_expired", actorId: null, subjectType: "event", subjectId: ev.id, label: ev.title, dedupeKey: `event_offer_expired:${ev.id}:${Date.parse(own.offeredAt ?? "0")}`, detail: "Your spot offer ran out" });
    offerNext(state, ev, now, h.canView);
  }
  return "offer_expired";
}

export function declineOffer(state: DemoState, ev: EventRow, userId: string, now: number, canView: (u: string) => boolean): string {
  const own = participantOf(state, ev.id, userId);
  if (!own || own.status !== "offered") return own?.status ?? "none";
  Object.assign(own, { status: "declined", reason: "declined", updatedAt: new Date(now).toISOString() });
  offerNext(state, ev, now, canView);
  return "declined";
}

/** Mirrors expire_offers(p_now). */
export function expireOffers(state: DemoState, now: number, eventOf: (id: string) => EventRow | undefined, canViewAs: (ev: EventRow) => (u: string) => boolean): number {
  const due = participants(state).filter((p) => p.status === "offered" && p.offerExpiresAt && Date.parse(p.offerExpiresAt) <= now);
  const events = new Set<string>();
  for (const p of due) {
    const ev = eventOf(p.eventId);
    p.status = "declined";
    p.reason = "expired";
    p.updatedAt = new Date(now).toISOString();
    notifyDemo(state, p.userId, { type: "event_offer_expired", actorId: null, subjectType: "event", subjectId: p.eventId, label: ev?.title ?? null, dedupeKey: `event_offer_expired:${p.eventId}:${Date.parse(p.offeredAt ?? "0")}`, detail: "Your spot offer ran out" });
    events.add(p.eventId);
  }
  for (const id of events) {
    const ev = eventOf(id);
    if (ev) offerNext(state, ev, now, canViewAs(ev));
  }
  return due.length;
}

/** Mirrors the events trigger: a cancellation ends every live offer. */
export function onEventUnpublished(state: DemoState, eventId: string, now: number) {
  for (const p of participants(state)) {
    if (p.eventId === eventId && p.status === "offered") Object.assign(p, { status: "declined", reason: "cancelled", updatedAt: new Date(now).toISOString() });
  }
}

/** Mirrors host_remove_participant() for waitlisted/offered rows (going rows: the caller removes them). */
export function hostRemoveWaiting(state: DemoState, ev: EventRow, userId: string, now: number, canView: (u: string) => boolean): boolean {
  const own = participantOf(state, ev.id, userId);
  if (!own || (own.status !== "waitlisted" && own.status !== "offered")) return false;
  const wasOffered = own.status === "offered";
  Object.assign(own, { status: "left", reason: "removed", offeredAt: null, offerExpiresAt: null, updatedAt: new Date(now).toISOString() });
  if (wasOffered) offerNext(state, ev, now, canView);
  return true;
}

/** Live offers, for the capacity guard (capacity >= going + live offers). */
export function liveOffers(state: DemoState, eventId: string, now: number): number {
  return participants(state).filter((p) => p.eventId === eventId && liveOffer(p, now)).length;
}
