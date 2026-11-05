import type { StoreHandle } from "./store";

/** Mirrors purge_analytics(): drops events older than keepDays, returns how many. */
export function purgeDemoAnalytics(handle: StoreHandle, keepDays: number, now = Date.now()): number {
  const cutoff = now - keepDays * 86_400_000;
  const before = handle.state.analyticsEvents.length;
  handle.state.analyticsEvents = handle.state.analyticsEvents.filter((e) => new Date(e.createdAt).getTime() >= cutoff);
  const deleted = before - handle.state.analyticsEvents.length;
  if (deleted) handle.persist();
  return deleted;
}
