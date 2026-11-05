/**
 * Pilot event form fields (roadmap M4), parsed only when pilotEvents is on, so the flag-off form and
 * actions behave exactly as before. Returns the fields to pass to repo.events.create/update, or field
 * errors keyed by input name.
 */
import { activityDetailsSchema, eventNewcomerSchema, sessionRulesSchema, type ActivityDetails, type EventNewcomer, type VenueStatus } from "@findmaxxing/shared/events";
import { normalizeTimeZone } from "@/lib/utils/timezone";

export interface EventPilotFields {
  newcomer?: EventNewcomer | null;
  activityDetails?: ActivityDetails | null;
  timeZone?: string;
  minAttendance?: number | null;
  /** Minutes before the start; the action turns it into decisionDeadline. null = no deadline. */
  decisionLeadMinutes?: number | null;
  venueStatus?: VenueStatus;
}

/** Form input names for each activity-detail field (prefix + field). */
const ACTIVITY_INPUTS: Record<string, Record<string, string>> = {
  run: { distance: "runDistance", unit: "runUnit", paceFrom: "runPaceFrom", paceTo: "runPaceTo", regroup: "runRegroup", noDrop: "runNoDrop", noDropNote: "runNoDropNote" },
  volleyball: { format: "gameFormat", playerLimit: "gamePlayerLimit", beginnersWelcome: "gameBeginners" },
  basketball: { format: "gameFormat", playerLimit: "gamePlayerLimit", beginnersWelcome: "gameBeginners" },
  pickleball: { level: "pbLevel", play: "pbPlay", paddlesAvailable: "pbPaddles" },
  walk: { note: "walkNote" },
};
const BOOLEAN_FIELDS = new Set(["noDrop", "beginnersWelcome", "paddlesAvailable"]);

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

  const kind = read("activityKind");
  if (!kind) data.activityDetails = null;
  else if (!(kind in ACTIVITY_INPUTS)) errors.activityKind = "Pick an activity type";
  else {
    const raw: Record<string, unknown> = { kind };
    for (const [field, input] of Object.entries(ACTIVITY_INPUTS[kind])) {
      const v = read(input);
      if (BOOLEAN_FIELDS.has(field)) raw[field] = v === "on";
      else if (v.trim()) raw[field] = v;
    }
    const parsed = activityDetailsSchema.safeParse(raw);
    if (parsed.success) data.activityDetails = parsed.data;
    else for (const issue of parsed.error.issues) errors[ACTIVITY_INPUTS[kind][String(issue.path[0])] ?? "activityKind"] = issue.message;
  }

  const rules = sessionRulesSchema.safeParse({
    minAttendance: read("minAttendance").trim() || null,
    decisionLeadMinutes: read("decisionLead").trim() || null,
    venueStatus: read("venueUnconfirmed") === "on" ? "unconfirmed" : "confirmed",
  });
  if (rules.success) {
    data.minAttendance = rules.data.minAttendance ?? null;
    data.decisionLeadMinutes = rules.data.decisionLeadMinutes ?? null;
    data.venueStatus = rules.data.venueStatus;
  } else for (const issue of rules.error.issues) errors[issue.path[0] === "decisionLeadMinutes" ? "decisionLead" : String(issue.path[0])] = issue.message;
  if (data.decisionLeadMinutes && !data.minAttendance) errors.decisionLead = "Set a minimum first: the deadline decides whether enough people signed up";

  const zone = read("timeZone");
  if (zone) {
    if (normalizeTimeZone(zone)) data.timeZone = zone;
    else errors.timeZone = "Unknown time zone";
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}

/** The repository input for the parsed fields, given the event's start (4.3 deadline = start − lead). */
export function pilotInput(data: EventPilotFields, startsAt: Date) {
  const { decisionLeadMinutes, ...rest } = data;
  return {
    ...rest,
    ...(decisionLeadMinutes !== undefined ? { decisionDeadline: decisionLeadMinutes ? new Date(startsAt.getTime() - decisionLeadMinutes * 60_000).toISOString() : null } : {}),
  };
}
