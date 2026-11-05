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
