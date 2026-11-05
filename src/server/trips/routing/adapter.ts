import type { LatLng, LegResult, LegUnknownReason, RouterId } from "@/lib/itinerary/types";

/**
 * Walking routing adapter (roadmap 6.1, 6.0 SPEC §3). Walking only (X3).
 *
 * Nothing here stores a result: no database, demo store, log or shared cache ever receives a provider
 * duration, distance or geometry (decision R-2). The only cache is createRequestMemo(), which a caller
 * creates for one server request and drops with it.
 */
export interface WalkingRouter {
  id: RouterId;
  /** One leg per consecutive pair: points.length - 1 legs. Unknowns are results, not throws. */
  legs(points: LatLng[], opts: { signal: AbortSignal }): Promise<LegResult[]>;
}

/** Per provider request (one HTTP call). */
export const REQUEST_TIMEOUT_MS = 4_000;
/** Per plan validation (all of a plan's requests together). */
export const PLAN_TIMEOUT_MS = 8_000;

export function unknownLegs(count: number, reason: LegUnknownReason): LegResult[] {
  return Array.from({ length: Math.max(count, 0) }, () => ({ status: "unknown", reason }) as const);
}

/** A router that is chosen but cannot run (no key or no host): every leg unknown, never a fake "fits". */
export function notConfiguredRouter(id: RouterId): WalkingRouter {
  return { id, legs: async (points) => unknownLegs(points.length - 1, "not_configured") };
}

/**
 * Runs `run` with a signal that aborts after `ms` or when `outer` aborts. Reports which one fired, so a
 * provider client can tell its own timeout from a cancelled validation.
 */
export async function withRequestTimeout<T>(outer: AbortSignal, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(outer.reason);
  if (outer.aborted) abort();
  else outer.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", abort);
  }
}
