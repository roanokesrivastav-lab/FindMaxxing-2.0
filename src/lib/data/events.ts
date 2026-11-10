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
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type EventsErrorKey = keyof typeof ERRORS;

export function eventsError(key: EventsErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

export function parseEventsMessage(message: string): DataError | null {
  const m = /events:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? eventsError(m[1] as EventsErrorKey) : null;
}
