/**
 * Structured activity details for an event (roadmap 4.2): a few plain facts per
 * kind of activity, shown in plain language. Skill is always a description
 * ("all levels", "beginners welcome"), never a numeric rating. Client-safe.
 *
 * The database stores this object in events.activity_details and checks only
 * the kind, scalar values and size (0050); this file is the exact shape.
 */
import { z } from "zod";

export const ACTIVITY_KINDS = ["run", "volleyball", "basketball", "pickleball", "walk"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  run: "Run",
  volleyball: "Volleyball",
  basketball: "Basketball",
  pickleball: "Pickleball",
  walk: "Walk",
};

export const COURT_FORMATS = ["2v2", "3v3", "4v4", "5v5", "6v6", "open"] as const;
export const PICKLEBALL_LEVELS = ["beginner", "intermediate", "advanced", "all"] as const;
export const PICKLEBALL_PLAY = ["singles", "doubles", "both"] as const;
export const WALK_PACES = ["easy", "moderate", "brisk"] as const;

const pace = z.string().regex(/^([4-9]|1\d|2[0-4]):[0-5]\d$/, "Use minutes:seconds per mile, like 9:30");
const miles = z.number().min(0.1, "Distance must be at least 0.1 miles").max(100, "Distance must be 100 miles or less");
const paceSeconds = (p: string) => Number(p.split(":")[0]) * 60 + Number(p.split(":")[1]);

const runSchema = z
  .object({
    kind: z.literal("run"),
    distanceMiles: miles.optional(),
    paceFrom: pace.optional(),
    paceTo: pace.optional(),
    regroup: z.boolean().optional(),
    noDrop: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.paceFrom && v.paceTo && paceSeconds(v.paceFrom) > paceSeconds(v.paceTo)) {
      ctx.addIssue({ code: "custom", path: ["paceTo"], message: "The slower pace must come second" });
    }
  });
const courtFields = {
  format: z.enum(COURT_FORMATS).optional(),
  playerLimit: z.number().int().min(2, "Player limit must be at least 2").max(60, "Player limit must be 60 or less").optional(),
  beginnersWelcome: z.boolean().optional(),
};
const volleyballSchema = z.object({ kind: z.literal("volleyball"), ...courtFields }).strict();
const basketballSchema = z.object({ kind: z.literal("basketball"), ...courtFields }).strict();
const pickleballSchema = z
  .object({
    kind: z.literal("pickleball"),
    level: z.enum(PICKLEBALL_LEVELS).optional(),
    play: z.enum(PICKLEBALL_PLAY).optional(),
    paddlesAvailable: z.boolean().optional(),
  })
  .strict();
const walkSchema = z.object({ kind: z.literal("walk"), distanceMiles: miles.optional(), pace: z.enum(WALK_PACES).optional() }).strict();

export const activityDetailsSchema = z.union([runSchema, volleyballSchema, basketballSchema, pickleballSchema, walkSchema]);
export type ActivityDetails = z.infer<typeof activityDetailsSchema>;

/** A stored value, or null when it is missing or not a shape this version knows. Never throws. */
export function parseActivityDetails(value: unknown): ActivityDetails | null {
  if (value === null || value === undefined) return null;
  const parsed = activityDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const num = (v: FormDataEntryValue | string | null | undefined) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : Number(s);
};
const text = (v: FormDataEntryValue | string | null | undefined) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? undefined : s;
};
const flag = (v: FormDataEntryValue | string | null | undefined) => (v === "on" || v === "true" ? true : undefined);

/**
 * The unvalidated object for the form's activity fields (names prefixed
 * "activity."), or null when no kind is chosen. Unticked boxes are left out
 * rather than stored as false: the page then says nothing about them.
 */
export function activityFromFields(get: (name: string) => FormDataEntryValue | string | null | undefined): Record<string, unknown> | null {
  const kind = text(get("activity.kind"));
  if (!kind) return null;
  const f = (name: string) => get(`activity.${name}`);
  const raw: Record<string, unknown> = (() => {
    switch (kind) {
      case "run":
        return { kind, distanceMiles: num(f("distanceMiles")), paceFrom: text(f("paceFrom")), paceTo: text(f("paceTo")), regroup: flag(f("regroup")), noDrop: flag(f("noDrop")) };
      case "volleyball":
      case "basketball":
        return { kind, format: text(f("format")), playerLimit: num(f("playerLimit")), beginnersWelcome: flag(f("beginnersWelcome")) };
      case "pickleball":
        return { kind, level: text(f("level")), play: text(f("play")), paddlesAvailable: flag(f("paddlesAvailable")) };
      case "walk":
        return { kind, distanceMiles: num(f("distanceMiles")), pace: text(f("pace")) };
      default:
        return { kind };
    }
  })();
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
}

const milesText = (n: number) => `${Number(n.toFixed(1))} mile${n === 1 ? "" : "s"}`;
const FORMAT_TEXT: Record<(typeof COURT_FORMATS)[number], string> = {
  "2v2": "2 v 2", "3v3": "3 v 3", "4v4": "4 v 4", "5v5": "5 v 5", "6v6": "6 v 6", open: "Open play",
};
const LEVEL_TEXT: Record<(typeof PICKLEBALL_LEVELS)[number], string> = {
  beginner: "Best for beginners", intermediate: "For people who have played a fair bit", advanced: "For experienced players", all: "All levels",
};
const PLAY_TEXT: Record<(typeof PICKLEBALL_PLAY)[number], string> = { singles: "Singles", doubles: "Doubles", both: "Singles and doubles" };
const WALK_TEXT: Record<(typeof WALK_PACES)[number], string> = { easy: "Easy pace", moderate: "Moderate pace", brisk: "Brisk pace" };

/**
 * Plain-language lines for a details object, most useful first. Only what was
 * entered is described: a missing field produces no line, never a default.
 */
export function describeActivity(details: ActivityDetails | null | undefined): string[] {
  if (!details) return [];
  const out: string[] = [];
  switch (details.kind) {
    case "run":
      if (details.distanceMiles !== undefined) out.push(milesText(details.distanceMiles));
      if (details.paceFrom && details.paceTo && details.paceFrom !== details.paceTo) out.push(`${details.paceFrom} to ${details.paceTo} per mile`);
      else if (details.paceFrom || details.paceTo) out.push(`About ${details.paceFrom ?? details.paceTo} per mile`);
      if (details.regroup) out.push("Regroups along the way");
      if (details.noDrop) out.push("No-drop: the group waits, nobody is left behind");
      break;
    case "volleyball":
    case "basketball":
      if (details.format) out.push(FORMAT_TEXT[details.format]);
      if (details.playerLimit !== undefined) out.push(`Up to ${details.playerLimit} players`);
      if (details.beginnersWelcome) out.push("Beginners welcome");
      break;
    case "pickleball":
      if (details.level) out.push(LEVEL_TEXT[details.level]);
      if (details.play) out.push(PLAY_TEXT[details.play]);
      if (details.paddlesAvailable) out.push("Paddles available to borrow");
      break;
    case "walk":
      if (details.distanceMiles !== undefined) out.push(milesText(details.distanceMiles));
      if (details.pace) out.push(WALK_TEXT[details.pace]);
      break;
  }
  return out;
}

/** One line for rows and cards, e.g. "Basketball · 4 v 4 · Beginners welcome". Null without details. */
export function activitySummary(details: ActivityDetails | null | undefined): string | null {
  if (!details) return null;
  return [ACTIVITY_KIND_LABELS[details.kind], ...describeActivity(details).slice(0, 2)].join(" · ");
}
