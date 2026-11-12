/**
 * Demo-mode session rules, capacity accounting and readiness. Mirrors
 * 0051_session_rules_and_readiness.sql (and what later migrations add to the
 * same functions), so demo mode decides exactly what the database would.
 */
import type { EventReadiness } from "../types";
import { DEFAULT_TIME_ZONE } from "@/lib/utils/timezone";
import { eventsError } from "../events";
import { notifyDemo } from "./notifications";
import type { DemoState, EventRow } from "./store";

/**
 * Mirrors findmaxxing_private.seats_taken(): the one definition of how many
 * seats are spoken for. "Live" is decided against `now`, not by a sweep.
 */
export function seatsTaken(state: DemoState, eventId: string, now = Date.now()): number {
  return state.eventAttendees.filter((a) => a.eventId === eventId).length
    + state.eventParticipants.filter((p) => p.eventId === eventId && p.status === "offered" && !!p.offerExpiresAt && Date.parse(p.offerExpiresAt) > now).length
    + state.tickets.filter((t) => t.eventId === eventId && t.status === "pending" && Date.parse(t.expiresAt) > now).length;
}

/** Mirrors events_readiness() for one event (visibility is the caller's job). */
export function readinessOf(state: DemoState, e: EventRow, now = Date.now()): EventReadiness {
  const going = state.eventAttendees.filter((a) => a.eventId === e.id).length;
  const min = e.minAttendance ?? null;
  return {
    going,
    capacity: e.capacity,
    spotsOpen: e.capacity === null ? null : Math.max(0, e.capacity - seatsTaken(state, e.id, now)),
    minAttendance: min,
    moreNeeded: min === null ? null : Math.max(0, min - going),
    decisionDeadline: e.decisionDeadline ?? null,
    timeZone: e.timeZone ?? DEFAULT_TIME_ZONE,
    venueStatus: e.venueStatus ?? "confirmed",
    decision: e.decision ?? "open",
    waitlist: state.eventParticipants.filter((p) => p.eventId === e.id && p.status === "waitlisted").length,
  };
}

/**
 * Mirrors the shape checks in guard_event_session_rules(). `setByPerson` is the
 * trigger's "a signed-in person changed the deadline" case, which also refuses
 * a deadline that has already passed.
 */
export function checkSessionRules(e: Pick<EventRow, "capacity" | "startsAt" | "minAttendance" | "decisionDeadline">, setByPerson: boolean, now = Date.now()) {
  const min = e.minAttendance ?? null;
  const deadline = e.decisionDeadline ?? null;
  if (min !== null && (!Number.isInteger(min) || min < 2)) throw eventsError("bad_session_rules");
  if (min !== null && e.capacity !== null && min > e.capacity) throw eventsError("min_above_capacity");
  if (deadline !== null && min === null) throw eventsError("bad_session_rules");
  if (deadline !== null && Date.parse(deadline) > Date.parse(e.startsAt)) throw eventsError("bad_deadline");
  if (setByPerson && deadline !== null && Date.parse(deadline) <= now) throw eventsError("bad_deadline");
}

/** Mirrors decide_sessions(): returns how many sessions were decided. */
export function decideDemoSessions(state: DemoState, now: string, onCancel: (eventId: string) => void): number {
  const at = Date.parse(now);
  let decided = 0;
  const due = state.events
    .filter((e) => e.status === "published" && (e.decision ?? "open") === "open" && e.minAttendance != null && e.decisionDeadline != null
      && Date.parse(e.decisionDeadline) <= at && Date.parse(e.endsAt ?? e.startsAt) > Date.now())
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of due) {
    const going = state.eventAttendees.filter((a) => a.eventId === e.id);
    if (going.length >= e.minAttendance!) {
      e.decision = "happening";
    } else {
      e.status = "cancelled";
      e.cancelReason = "below_minimum";
      e.decision = "not_happening";
      onCancel(e.id);
      for (const a of going) {
        notifyDemo(state, a.userId, { type: "event_not_happening", actorId: null, subjectType: "event", subjectId: e.id, label: e.title, dedupeKey: `event_not_happening:${e.id}` });
      }
    }
    e.updatedAt = new Date().toISOString();
    decided += 1;
  }
  return decided;
}
