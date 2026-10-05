/**
 * Moderation rules shared by both repositories. The database raises
 * "moderation:<key>" from moderate_target() and set_local_status()
 * (0010_moderation.sql); the demo repository throws the same keys, so the two
 * report every refusal in the same words.
 */
import { compareTimestamps } from "./discovery";
import { DataError, type ModerationAction, type ReportTargetType } from "./types";

export const MAX_MODERATION_REASON = 500;
export const MODERATION_ACTIONS: readonly ModerationAction[] = ["dismiss", "review", "remove", "restore"];
export const REPORT_TARGET_TYPES: readonly ReportTargetType[] = ["place", "event", "profile"];

const ERRORS = {
  invalid_target: ["Unknown report target", "invalid"],
  invalid_action: ["Unknown moderation action", "invalid"],
  reason_too_long: [`Keep the reason under ${MAX_MODERATION_REASON} characters`, "invalid"],
  reason_required: ["Give a reason", "invalid"],
  not_found: ["That no longer exists", "not_found"],
  cannot_remove_profile: ["Profiles can't be removed. Revoke local status or dismiss the reports instead.", "invalid"],
  already_removed: ["This is already removed", "conflict"],
  not_removed: ["Only removed content can be restored", "conflict"],
  nothing_open: ["There are no open reports to resolve", "conflict"],
  no_change: ["Nothing to change", "conflict"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type ModerationErrorKey = keyof typeof ERRORS;

export function moderationError(key: ModerationErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

/** Maps "moderation:<key>" from a database error message, or null for anything else. */
export function parseModerationMessage(message: string): DataError | null {
  const m = /moderation:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? moderationError(m[1] as ModerationErrorKey) : null;
}

/** Trimmed reason, or null when blank. */
export function normalizeReason(reason: string | null | undefined): string | null {
  const trimmed = (reason ?? "").trim();
  return trimmed ? trimmed : null;
}

/** Open reports first, then newest first; id breaks ties. */
export function compareModerationReports(
  a: { status: string; createdAt: string; id: string },
  b: { status: string; createdAt: string; id: string },
): number {
  const open = Number(b.status === "open") - Number(a.status === "open");
  return open || compareTimestamps(b.createdAt, a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}
