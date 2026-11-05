/**
 * Pilot event form fields (roadmap M4), parsed only when pilotEvents is on, so the flag-off form and
 * actions behave exactly as before. Returns the fields to pass to repo.events.create/update, or field
 * errors keyed by input name.
 */
import { eventNewcomerSchema, type EventNewcomer } from "@findmaxxing/shared/events";

export interface EventPilotFields {
  newcomer?: EventNewcomer | null;
}

type Read = (key: string) => string;

export function parseEventPilotFields(read: Read): { ok: true; data: EventPilotFields } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const data: EventPilotFields = {};
  const newcomer = eventNewcomerSchema.safeParse({
    meetingSpot: read("newcomerMeetingSpot"),
    welcomer: read("newcomerWelcomer"),
    bring: read("newcomerBring"),
    soloWelcome: read("newcomerSolo") === "on",
  });
  if (newcomer.success) data.newcomer = newcomer.data;
  else for (const issue of newcomer.error.issues) errors[`newcomer${String(issue.path[0] ?? "").replace(/^./, (c) => c.toUpperCase())}`] = issue.message;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}
