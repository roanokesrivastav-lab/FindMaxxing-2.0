import { REPORT_REASONS } from "@/lib/data/taxonomy";
import type { ModerationLogAction, ReportTargetType } from "@/lib/data/types";

export const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function reasonLabel(reason: string): string {
  return REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

export const TARGET_LABEL: Record<ReportTargetType, string> = { place: "Place", event: "Event", profile: "Profile" };

export const ACTION_LABEL: Record<ModerationLogAction, string> = {
  dismiss: "Dismissed the reports",
  review: "Marked reviewed, no action",
  remove: "Removed the content",
  restore: "Restored the content",
  revoke_local: "Revoked local status",
  restore_local: "Restored local status",
};

/** Where the target lives for everyone else; profiles link by username. */
export function publicHref(type: ReportTargetType, id: string, username: string | null): string | null {
  if (type === "place") return `/places/${id}`;
  if (type === "event") return `/events/${id}`;
  return username ? `/u/${username}` : null;
}
