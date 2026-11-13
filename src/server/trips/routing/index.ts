/**
 * Choosing a walking router, bounding it in time, and remembering its answers
 * for one request only (roadmap 6.1, 6.0 §3).
 */
import { getDataMode } from "@/lib/config";
import { DataError } from "@/lib/data/types";
import { waitPhrase } from "@/lib/rateLimits";
import { createFakeRouter } from "./fake";
import { createGraphhopperFootRouter } from "./graphhopper";
import { createMapboxWalkingRouter } from "./mapbox";
import { unknownLegs, type LatLng, type LegResult, type RouterId, type WalkingRouter } from "./types";

export * from "./types";
export { createFakeRouter, COLUMBUS_FIXTURES, type FakeRouteFixtures } from "./fake";
export { createMapboxWalkingRouter } from "./mapbox";
export { createGraphhopperFootRouter } from "./graphhopper";

/** 6.0 §3: 4 s for one provider request, 8 s for a whole plan validation. No retries. */
export const REQUEST_TIMEOUT_MS = 4_000;
export const VALIDATION_TIMEOUT_MS = 8_000;

/** Every leg unknown, "not configured": what Supabase mode gets until a provider is set up. */
export function createUnconfiguredRouter(id: RouterId = "mapbox-walking"): WalkingRouter {
  return { id, legs: async (points) => unknownLegs(points.length - 1, "not_configured") };
}

/**
 * The router for this deployment. Demo mode always uses the fake. Otherwise a provider is used only
 * when BOTH the router is named and its own server-side token is set; the map-tile token
 * (NEXT_PUBLIC_MAPBOX_TOKEN) is public and is never used for routing. Anything else is "not
 * configured": legs come back unknown rather than estimated.
 */
export function resolveWalkingRouter(env: Record<string, string | undefined> = process.env, mode: "demo" | "supabase" = getDataMode()): WalkingRouter {
  if (mode === "demo") return createFakeRouter();
  const wanted = env.WALKING_ROUTER;
  if (wanted === "mapbox-walking" && env.MAPBOX_WALKING_TOKEN) {
    return createMapboxWalkingRouter({ token: env.MAPBOX_WALKING_TOKEN, fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }) });
  }
  if (wanted === "graphhopper-foot") return createGraphhopperFootRouter();
  return createUnconfiguredRouter();
}

/**
 * One bounded call. Whatever the router does (hangs, throws, returns the wrong number of legs or
 * something that is not a leg), the caller gets exactly points.length - 1 well-formed legs.
 */
export async function routeLegs(router: WalkingRouter, points: readonly LatLng[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LegResult[]> {
  const count = points.length - 1;
  if (count < 1) return [];
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  if (signal.aborted) return unknownLegs(count, "timeout");
  const aborted = new Promise<"aborted">((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
  let answer: LegResult[] | "aborted";
  try {
    answer = await Promise.race([router.legs(points, { signal }), aborted]);
  } catch {
    return unknownLegs(count, signal.aborted ? "timeout" : "provider_error");
  }
  if (answer === "aborted") return unknownLegs(count, "timeout");
  if (!Array.isArray(answer) || answer.length !== count) return unknownLegs(count, "provider_error");
  return answer.map(cleanLeg);
}

const REASONS: readonly string[] = ["timeout", "no_route", "provider_error", "not_configured"];
/** Rebuilt field by field, so nothing a router attached to a leg travels further. */
function cleanLeg(leg: unknown): LegResult {
  const l = leg as { status?: unknown; seconds?: unknown; meters?: unknown; reason?: unknown } | null;
  if (l && l.status === "ok" && typeof l.seconds === "number" && typeof l.meters === "number" && Number.isFinite(l.seconds) && Number.isFinite(l.meters) && l.seconds >= 0 && l.meters >= 0) {
    return { status: "ok", seconds: l.seconds, meters: l.meters };
  }
  if (l && l.status === "unknown" && typeof l.reason === "string" && REASONS.includes(l.reason)) {
    return { status: "unknown", reason: l.reason as Extract<LegResult, { status: "unknown" }>["reason"] };
  }
  return { status: "unknown", reason: "provider_error" };
}

const pairKey = (a: LatLng, b: LatLng) => `${a.lat.toFixed(6)},${a.lng.toFixed(6)}>${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;

/**
 * Remembers each leg for as long as the returned router object lives. Make one per server request
 * and let it go with the request: there is no module-level store here, nothing is written to the
 * database, the demo store, a log or a shared cache, and a new object starts empty (6.0 R-2).
 * Unknown answers are remembered too, so one validation does not ask a failing provider twice.
 */
export function withRequestMemo(router: WalkingRouter): WalkingRouter {
  const seen = new Map<string, LegResult>();
  return {
    id: router.id,
    async legs(points, opts) {
      const keys = points.slice(1).map((to, i) => pairKey(points[i], to));
      if (keys.every((k) => seen.has(k))) return keys.map((k) => seen.get(k)!);
      const fresh = await routeLegs(router, points, { signal: opts.signal });
      fresh.forEach((leg, i) => { if (!seen.has(keys[i])) seen.set(keys[i], leg); });
      return keys.map((k) => seen.get(k)!);
    },
  };
}

export interface RouteValidationDeps {
  /** Reserves one validation for this user; 0 when admitted, else seconds to wait. Throws when the limiter cannot be reached. */
  limit: (userId: string) => Promise<number>;
  router: WalkingRouter;
}

/**
 * Legs for one plan validation, for a signed-in user. The budget is reserved first: when the user
 * is over the limit, or the limiter cannot be reached, no router is called at all. The whole
 * validation shares one 8 s deadline and one memo.
 */
export async function routeForValidation(userId: string, requests: ReadonlyArray<readonly LatLng[]>, deps: RouteValidationDeps): Promise<{ router: RouterId; legs: LegResult[][] }> {
  if (!userId) throw new DataError("Sign in to check a plan.", "forbidden");
  const wait = await deps.limit(userId);
  if (wait) throw new DataError(`Too many plan checks. Try again in ${waitPhrase(wait)}.`, "rate_limited");
  const deadline = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
  const router = withRequestMemo(deps.router);
  const legs: LegResult[][] = [];
  for (const points of requests) legs.push(await routeLegs(router, points, { signal: deadline }));
  return { router: router.id, legs };
}
