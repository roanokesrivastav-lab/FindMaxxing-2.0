/**
 * Event rules shared by both repositories. The database raises "events:<key>"
 * (0050 onwards); the demo repository throws the same.
 */
import { DataError } from "./types";

const ERRORS = {
  bad_time_zone: ["Unknown time zone", "invalid"],
  bad_activity: ["Check the activity details", "invalid"],
  not_found: ["That event isn't available", "not_found"],
  closed: ["This event can no longer be changed", "invalid"],
  bad_session_rules: ["Check the minimum and the decision time", "invalid"],
  min_above_capacity: ["The minimum can't be more than the capacity", "invalid"],
  bad_deadline: ["The decision time must be before the start, and still ahead", "invalid"],
  already_going: ["You're already going", "conflict"],
  no_offer: ["There's no spot being held for you", "invalid"],
  cannot_remove_host: ["The host can't be removed", "invalid"],
  paid_attendee: ["Someone who paid can't be removed here. Cancel the event to refund everyone", "conflict"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type EventsErrorKey = keyof typeof ERRORS;

export function eventsError(key: EventsErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

/** The messages the join rule raises as plain text (check_event_join, join_event). */
export const NOT_OPEN = "Event is not open for joining";
export const ENDED = "This event has already ended";
export const FULL = "This event is full";

export function parseEventsMessage(message: string): DataError | null {
  const m = /events:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? eventsError(m[1] as EventsErrorKey) : null;
}
