/**
 * Pilot event fields (roadmap M4: 4.1, 4.2, 4.3, 4.8), shared by the web app and the mobile app.
 * Types and validation only: no Node or browser APIs.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 4.1 "Your first time?" newcomer block (host-entered; every field optional)
// ---------------------------------------------------------------------------
export interface EventNewcomer {
  /** Exactly where to find the group, e.g. "By the north goal, orange cones". */
  meetingSpot?: string | null;
  /** Who welcomes newcomers, e.g. "Maya (blue cap)". */
  welcomer?: string | null;
  /** What to bring. */
  bring?: string | null;
  /** Coming alone is normal here. */
  soloWelcome?: boolean;
}

export const NEWCOMER_LIMITS = { meetingSpot: 140, welcomer: 80, bring: 200 } as const;

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const eventNewcomerSchema = z
  .object({
    meetingSpot: optText(NEWCOMER_LIMITS.meetingSpot),
    welcomer: optText(NEWCOMER_LIMITS.welcomer),
    bring: optText(NEWCOMER_LIMITS.bring),
    soloWelcome: z.boolean().optional().default(false),
  })
  .strict()
  .transform((v): EventNewcomer | null => {
    const out: EventNewcomer = {};
    if (v.meetingSpot) out.meetingSpot = v.meetingSpot;
    if (v.welcomer) out.welcomer = v.welcomer;
    if (v.bring) out.bring = v.bring;
    if (v.soloWelcome) out.soloWelcome = true;
    return Object.keys(out).length ? out : null;
  });

/** True when the block has anything to show. */
export function hasNewcomerInfo(n: EventNewcomer | null | undefined): n is EventNewcomer {
  return !!n && !!(n.meetingSpot || n.welcomer || n.bring || n.soloWelcome);
}

// ---------------------------------------------------------------------------
// 4.2 Structured activity details, per kind. Skill is a plain description, never a number.
// ---------------------------------------------------------------------------
export const ACTIVITY_KINDS = ["run", "volleyball", "basketball", "pickleball", "walk"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  run: "Run",
  volleyball: "Volleyball",
  basketball: "Basketball",
  pickleball: "Pickleball",
  walk: "Walk",
};

/** Plain skill descriptions (no numeric rating). */
export const SKILL_LEVELS = ["new", "casual", "regular", "competitive"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];
export const SKILL_LABELS: Record<SkillLevel, string> = {
  new: "New to it: we'll show you the basics",
  casual: "Casual: you know the rules",
  regular: "Regular: you play most weeks",
  competitive: "Competitive: games are intense",
};

export type DistanceUnit = "km" | "mi";

export type ActivityDetails =
  | {
      kind: "run";
      distance?: number | null;
      unit?: DistanceUnit;
      /** Pace range per unit, "m:ss" (e.g. 9:00 to 10:30 min/mi). */
      paceFrom?: string | null;
      paceTo?: string | null;
      /** Where or when the group waits, e.g. "At every mile marker". */
      regroup?: string | null;
      noDrop?: boolean;
      /** How no-drop works here, in the host's words. */
      noDropNote?: string | null;
    }
  | {
      kind: "volleyball" | "basketball";
      /** e.g. "4v4", "Half-court 3s". */
      format?: string | null;
      playerLimit?: number | null;
      beginnersWelcome?: boolean;
    }
  | {
      kind: "pickleball";
      level?: SkillLevel | null;
      play?: "singles" | "doubles" | "either" | null;
      paddlesAvailable?: boolean;
    }
  | { kind: "walk"; note?: string | null };

const PACE = /^\d{1,2}:[0-5]\d$/;
const paceSeconds = (p: string) => { const [m, s] = p.split(":").map(Number); return m * 60 + s; };
const optShort = (max: number) => optText(max);
const optPace = z.string().trim().optional().nullable().transform((v) => (v ? v : null)).refine((v) => v === null || PACE.test(v), "Use minutes:seconds, e.g. 9:30");

export const activityDetailsSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("run"),
      distance: z.coerce.number().min(0.5, "At least 0.5").max(100, "At most 100").optional().nullable(),
      unit: z.enum(["km", "mi"]).optional().default("mi"),
      paceFrom: optPace,
      paceTo: optPace,
      regroup: optShort(120),
      noDrop: z.boolean().optional().default(false),
      noDropNote: optShort(160),
    }).strict().refine((v) => !v.paceFrom || !v.paceTo || paceSeconds(v.paceFrom) <= paceSeconds(v.paceTo), { message: "The faster pace comes first", path: ["paceTo"] }),
    z.object({
      kind: z.enum(["volleyball", "basketball"]),
      format: optShort(40),
      playerLimit: z.coerce.number().int().min(2, "At least 2").max(200, "At most 200").optional().nullable(),
      beginnersWelcome: z.boolean().optional().default(false),
    }).strict(),
    z.object({
      kind: z.literal("pickleball"),
      level: z.enum(SKILL_LEVELS).optional().nullable(),
      play: z.enum(["singles", "doubles", "either"]).optional().nullable(),
      paddlesAvailable: z.boolean().optional().default(false),
    }).strict(),
    z.object({ kind: z.literal("walk"), note: optShort(160) }).strict(),
  ])
  .transform((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== false)) as ActivityDetails);

/**
 * Activity details as plain-language lines for the event page and rows. Never invents a value: only
 * fields the host filled in appear.
 */
export function describeActivity(d: ActivityDetails | null | undefined): string[] {
  if (!d) return [];
  const lines: string[] = [];
  switch (d.kind) {
    case "run": {
      const unit = d.unit ?? "mi";
      if (d.distance) lines.push(`${d.distance} ${unit} run`);
      if (d.paceFrom && d.paceTo) lines.push(`Pace ${d.paceFrom} to ${d.paceTo} per ${unit}`);
      else if (d.paceFrom || d.paceTo) lines.push(`Pace about ${d.paceFrom ?? d.paceTo} per ${unit}`);
      if (d.regroup) lines.push(`Regroup: ${d.regroup}`);
      if (d.noDrop) lines.push(d.noDropNote ? `No-drop: ${d.noDropNote}` : "No-drop: nobody gets left behind");
      break;
    }
    case "volleyball":
    case "basketball":
      if (d.format) lines.push(`Format: ${d.format}`);
      if (d.playerLimit) lines.push(`Up to ${d.playerLimit} players`);
      if (d.beginnersWelcome) lines.push("Beginners welcome");
      break;
    case "pickleball":
      if (d.level) lines.push(`Level: ${SKILL_LABELS[d.level]}`);
      if (d.play) lines.push(d.play === "either" ? "Singles or doubles" : d.play === "singles" ? "Singles" : "Doubles");
      if (d.paddlesAvailable) lines.push("Paddles available to borrow");
      break;
    case "walk":
      if (d.note) lines.push(d.note);
      break;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 4.3 Minimum attendance and the Readiness row (4.0 spec §5)
// ---------------------------------------------------------------------------
export type VenueStatus = "confirmed" | "unconfirmed";
export type SessionDecision = "open" | "happening" | "not_happening";
export type CancelReason = "host" | "below_minimum" | "series_ended";

/** public.event_readiness(): each number from its own field. Null fields mean "not set", never zero. */
export interface EventReadiness {
  going: number;
  capacity: number | null;
  /** Seats held without being going (live paid holds; 4.4 adds live offers). */
  held: number;
  spotsOpen: number | null;
  minAttendance: number | null;
  moreNeeded: number | null;
  decisionDeadline: string | null;
  decision: SessionDecision;
  venueStatus: VenueStatus;
  /** Count only, never names (D-K). */
  waitlist: number;
}

/** Decision lead options in the form: how long before the start the host decides. */
export const DECISION_LEADS_MINUTES = [60, 120, 240, 720, 1440, 2880] as const;

export const sessionRulesSchema = z
  .object({
    minAttendance: z.coerce.number().int("Whole number").min(2, "At least 2").max(5000).optional().nullable(),
    decisionLeadMinutes: z.coerce.number().int().refine((v) => (DECISION_LEADS_MINUTES as readonly number[]).includes(v), "Pick a time").optional().nullable(),
    venueStatus: z.enum(["confirmed", "unconfirmed"]).optional().default("confirmed"),
  })
  .strict();

// ---------------------------------------------------------------------------
// 4.8 Party poster (host toggle; default is the Readiness row)
// ---------------------------------------------------------------------------
export type CardStyle = "readiness" | "party_poster";

// ---------------------------------------------------------------------------
// 4.4 Participation (4.0 spec §6). "going" is an event_attendees row; the rest are event_participants.
// ---------------------------------------------------------------------------
export type ParticipantStatus = "interested" | "waitlisted" | "offered" | "declined" | "left";
export type ViewerParticipation = "going" | ParticipantStatus | null;
export type JoinOutcome = "going" | "waitlisted";
/** D-D: an offer holds a seat for 2 hours, never closer than 30 minutes to the start. */
export const OFFER_WINDOW_MINUTES = 120;
export const OFFER_CUTOFF_MINUTES = 30;

/** A waitlist row as the host sees it (D-K: names to hosts only). */
export interface HostParticipant {
  userId: string;
  displayName: string;
  username: string;
  status: ParticipantStatus;
  queuePosition: number | null;
  offerExpiresAt: string | null;
}
