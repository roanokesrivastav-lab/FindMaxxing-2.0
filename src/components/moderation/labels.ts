import { REPORT_REASONS } from "@/lib/data/taxonomy";
import type { ModerationLogAction, ReportTargetType } from "@/lib/data/types";

export const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function reasonLabel(reason: string): string {
  return REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

export const TARGET_LABEL: Record<ReportTargetType, string> = { place: "Place", event: "Event", profile: "Profile", message: "Message" };

export const ACTION_LABEL: Record<ModerationLogAction, string> = {
  dismiss: "Dismissed the reports",
  review: "Marked reviewed, no action",
  remove: "Removed the content",
  restore: "Restored the content",
  revoke_local: "Revoked local status",
  restore_local: "Restored local status",
  reset_reputation: "Reset reputation",
  suspend: "Suspended the account",
  unsuspend: "Lifted the suspension",
  grant_moderator: "Made a moderator",
  revoke_moderator: "Removed as moderator",
  taxonomy_upsert: "Edited",
  taxonomy_retire: "Retired",
  taxonomy_restore: "Brought back",
  approve_ad: "Approved the campaign",
  reject_ad: "Rejected the campaign",
};

/** Where the target lives for everyone else; profiles link by username. Messages are private: no link. */
export function publicHref(type: ReportTargetType, id: string, username: string | null): string | null {
  if (type === "place") return `/places/${id}`;
  if (type === "event") return `/events/${id}`;
  if (type === "message") return null;
  return username ? `/u/${username}` : null;
}
