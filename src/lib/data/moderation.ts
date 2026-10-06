/**
 * Moderation rules shared by both repositories. The database raises
 * "moderation:<key>" from moderate_target() and set_local_status()
 * (0010_moderation.sql); the demo repository throws the same keys, so the two
 * report every refusal in the same words.
 */
import { compareTimestamps } from "./discovery";
import { DataError, type ModerationAction, type ReportTargetType } from "./types";

export const MAX_MODERATION_REASON = 500;
export const SUSPENDED_MESSAGE = "Your account is suspended, so you can't add or change anything right now.";
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
  self: ["You can't do that to your own account", "invalid"],
  bad_slug: ["Slugs are lowercase words joined by hyphens, up to 40 characters", "invalid"],
  bad_label: ["Check the label, emoji, colour and scope", "invalid"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type ModerationErrorKey = keyof typeof ERRORS;

export function moderationError(key: ModerationErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

/** Maps "moderation:<key>" or "admin:<key>" from a database error message, or null for anything else. */
export function parseModerationMessage(message: string): DataError | null {
  if (/account_suspended/.test(message)) return new DataError(SUSPENDED_MESSAGE, "forbidden");
  const m = /(?:moderation|admin):([a-z_]+)/.exec(message);
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
