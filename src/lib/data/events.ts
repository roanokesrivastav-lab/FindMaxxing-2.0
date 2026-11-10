/**
 * Event rules shared by both repositories. The database raises "events:<key>"
 * (0050 onwards); the demo repository throws the same.
 */
import { DataError } from "./types";

const ERRORS = {
  bad_time_zone: ["Unknown time zone", "invalid"],
  bad_activity: ["Check the activity details", "invalid"],
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
