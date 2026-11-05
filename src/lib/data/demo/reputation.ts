/**
 * Demo twin of compute_reputation() / refresh_reputation() in
 * 0016_reputation.sql. Same signals, same weights, same levels, and the same
 * caching: levels change when refreshDemoReputation runs (the hourly cron, a
 * moderator reset, seeding), not on every read.
 */
import type { ReputationLevel } from "../types";
import type { DemoState } from "./store";

const DAY = 86_400_000;

export function computeDemoReputation(state: DemoState, userId: string, now = Date.now()): { score: number; level: ReputationLevel } | null {
  const me = state.profiles.find((p) => p.id === userId);
  if (!me) return null;
  const since = new Date(state.reputationResets.find((r) => r.userId === userId)?.resetAt ?? 0).getTime();
  const after = (iso: string) => new Date(iso).getTime() >= since;
  const mine = new Set(state.places.filter((p) => p.creatorId === userId).map((p) => p.id));
  const myEvents = new Map(state.events.filter((e) => e.creatorId === userId).map((e) => [e.id, e]));
  const points =
    2 * state.savedPlaces.filter((s) => mine.has(s.placeId) && s.userId !== userId && after(s.createdAt)).length +
    2 * state.placeRatings.filter((r) => mine.has(r.placeId) && r.userId !== userId && after(r.createdAt)).length +
    1 * state.eventAttendees.filter((a) => a.userId !== userId && myEvents.has(a.eventId) && myEvents.get(a.eventId)!.status !== "removed" && after(a.createdAt)).length +
    3 * state.places.filter((p) => p.creatorId === userId && p.status === "published" && new Date(p.createdAt).getTime() <= now - 14 * DAY && after(p.createdAt)).length -
    10 * state.places.filter((p) => p.creatorId === userId && p.status === "removed" && after(p.updatedAt)).length -
    10 * state.events.filter((e) => e.creatorId === userId && e.status === "removed" && after(e.updatedAt)).length +
    1 * state.reports.filter((r) => r.reporterId === userId && r.status === "reviewed" && after(r.resolvedAt ?? r.createdAt)).length -
    1 * state.reports.filter((r) => r.reporterId === userId && r.status === "dismissed" && after(r.resolvedAt ?? r.createdAt)).length;
  const ageDays = Math.max(0, (now - new Date(me.createdAt).getTime()) / DAY);
  const score = Math.round(points * Math.min(1, ageDays / 30) * 100) / 100;
  const revoked = state.localRevocations.some((r) => r.userId === userId);
  const level: ReputationLevel = score >= 40 && ageDays >= 30 && !revoked ? "trusted" : score >= 10 && ageDays >= 7 ? "contributor" : "new";
  return { score, level };
}

export const LEVEL_RANK: Record<ReputationLevel, 0 | 1 | 2> = { new: 0, contributor: 1, trusted: 2 };

/** Recomputes and caches levels for one user, or everyone. Returns how many were refreshed. */
export function refreshDemoReputation(state: DemoState, userId?: string, now = Date.now()): number {
  const ids = userId ? [userId] : state.profiles.map((p) => p.id);
  for (const id of ids) {
    const r = computeDemoReputation(state, id, now);
    if (!r) continue;
    state.reputation[id] = { score: r.score, level: r.level, computedAt: new Date(now).toISOString() };
    const profile = state.profiles.find((p) => p.id === id)!;
    profile.reputationLevel = r.level;
    for (const place of state.places) if (place.creatorId === id) place.creatorReputation = LEVEL_RANK[r.level];
  }
  return ids.length;
}
