/**
 * Walking routes behind one interface (roadmap 6.1, spec docs/features/6.0.md §3).
 *
 * Every router answers with the LegResult shape the feasibility validator
 * takes (6.2) and nothing else: a measured leg, or "unknown" with a reason.
 * No router throws to its caller and none returns a provider's own fields.
 */
import type { LatLng, LegResult, LegUnknownReason, ROUTER_IDS } from "@/lib/trips/feasibility";

export type { LatLng, LegResult, LegUnknownReason };
export type RouterId = (typeof ROUTER_IDS)[number];

export interface WalkingRouter {
  id: RouterId;
  /** points.length - 1 legs, in order. Fewer than two points is no legs. */
  legs(points: readonly LatLng[], opts: { signal: AbortSignal }): Promise<LegResult[]>;
}

export const unknownLegs = (count: number, reason: LegUnknownReason): LegResult[] =>
  Array.from({ length: Math.max(0, count) }, () => ({ status: "unknown", reason }) as const);

/** A leg rebuilt from two numbers only, or unknown if either is not a sane measurement. */
export function measuredLeg(seconds: unknown, meters: unknown): LegResult {
  const clean = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
  // A day on foot or 200 km is not a walking leg in one city; treat it as a bad answer.
  if (!clean(seconds, 86_400) || !clean(meters, 200_000)) return { status: "unknown", reason: "provider_error" };
  return { status: "ok", seconds: Math.round(seconds as number), meters: Math.round(meters as number) };
}

const validPoint = (p: LatLng) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export const validPoints = (points: readonly LatLng[]) => points.every(validPoint);

/** What a screen may say about where the times came from. Only a configured provider is "measured". */
export function describeRouter(id: RouterId): { measured: boolean; label: string } {
  return id === "fake"
    ? { measured: false, label: "Walking times are estimates for this demo, not measured routes." }
    : { measured: true, label: "Walking times are from a routing service." };
}
