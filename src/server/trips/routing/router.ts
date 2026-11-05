import "server-only";
import { featureEnabled, getDataMode, type DataMode } from "@/lib/config";
import type { LatLng, LegResult, RouterId } from "@/lib/itinerary/types";
import { PLAN_TIMEOUT_MS, notConfiguredRouter, unknownLegs, type WalkingRouter } from "./adapter";
import { fakeWalkingRouter } from "./fake";
import { graphHopperFootRouter } from "./graphhopper";
import { createMapboxWalkingRouter } from "./mapbox";

export * from "./adapter";

function wellFormed(legs: unknown, count: number): legs is LegResult[] {
  return Array.isArray(legs) && legs.length === count && legs.every((leg) =>
    (leg?.status === "ok" && Number.isFinite(leg.seconds) && leg.seconds >= 0 && Number.isFinite(leg.meters) && leg.meters >= 0)
    || (leg?.status === "unknown" && ["timeout", "no_route", "provider_error", "not_configured"].includes(leg.reason)));
}

/**
 * The legs for one plan validation, within PLAN_TIMEOUT_MS. Never throws: a slow router gives
 * "timeout" for every leg (even one that ignores its signal), a throwing or malformed one
 * "provider_error". No retries (the user can retry).
 */
export async function routeLegs(
  router: WalkingRouter,
  points: LatLng[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LegResult[]> {
  const count = points.length - 1;
  if (count <= 0) return [];
  const controller = new AbortController();
  const cancel = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) return unknownLegs(count, "timeout");
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<LegResult[]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("plan validation timed out", "TimeoutError"));
      resolve(unknownLegs(count, "timeout"));
    }, opts.timeoutMs ?? PLAN_TIMEOUT_MS);
  });
  const call = Promise.resolve()
    .then(() => router.legs(points, { signal: controller.signal }))
    .then(
      (legs) => (wellFormed(legs, count) ? legs : unknownLegs(count, "provider_error")),
      () => unknownLegs(count, controller.signal.aborted ? "timeout" : "provider_error"),
    );
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

const pairKey = (a: LatLng, b: LatLng) => `${a.lat.toFixed(6)},${a.lng.toFixed(6)}>${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;

/**
 * Decision R-2: an in-memory memo for ONE server request, so identical legs within one validation are
 * not requested twice. Create it per request and let it go; never hold one in module state.
 */
export function createRequestMemo(router: WalkingRouter): WalkingRouter {
  const legs = new Map<string, LegResult>();
  return {
    id: router.id,
    async legs(points, opts) {
      const keys = points.slice(1).map((p, i) => pairKey(points[i], p));
      if (keys.every((k) => legs.has(k))) return keys.map((k) => legs.get(k)!);
      const fresh = await router.legs(points, opts);
      if (wellFormed(fresh, keys.length)) keys.forEach((k, i) => legs.set(k, fresh[i]));
      return fresh;
    },
  };
}

/**
 * Which router this deployment uses (R-1). A real provider runs only with the pilotItinerary flag AND
 * its server-only key: WALKING_ROUTER picks it (default mapbox-walking; graphhopper-foot is the named
 * fallback), MAPBOX_ROUTING_TOKEN / GRAPHHOPPER_URL configure it. Otherwise: the deterministic fake in
 * demo mode, and an all-unknown "not configured" router in Supabase mode.
 */
export function selectWalkingRouter(
  env: Record<string, string | undefined> = process.env,
  mode: DataMode = getDataMode(),
): WalkingRouter {
  const choice: RouterId = env.WALKING_ROUTER === "graphhopper-foot" ? "graphhopper-foot" : "mapbox-walking";
  if (featureEnabled("pilotItinerary", env)) {
    if (choice === "mapbox-walking" && env.MAPBOX_ROUTING_TOKEN) return createMapboxWalkingRouter(env.MAPBOX_ROUTING_TOKEN);
    if (choice === "graphhopper-foot" && env.GRAPHHOPPER_URL) return graphHopperFootRouter;
  }
  return mode === "demo" ? fakeWalkingRouter : notConfiguredRouter(choice);
}
