/**
 * Mapbox walking directions behind the WalkingRouter interface (6.0 §2, decision R-1: tentative).
 *
 * NOT LIVE: nothing constructs this without an explicit server-side token and router setting, the
 * project has neither, and the tests drive it with a stubbed fetch. The provider's terms for
 * storing results are unconfirmed, so this client hands back two numbers per leg and nothing else:
 * no geometry is requested, and no response field is passed through, logged or kept.
 */
import { measuredLeg, unknownLegs, validPoints, type LatLng, type LegResult, type LegUnknownReason, type WalkingRouter } from "./types";

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The Directions API takes at most 25 coordinates per request. */
const MAX_POINTS = 25;
const ENDPOINT = "https://api.mapbox.com/directions/v5/mapbox/walking";

const isAbort = (err: unknown) => err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

async function request(points: readonly LatLng[], token: string, fetchImpl: Fetch, signal: AbortSignal): Promise<LegResult[]> {
  const count = points.length - 1;
  const fail = (reason: LegUnknownReason) => unknownLegs(count, reason);
  const path = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  let body: unknown;
  try {
    const res = await fetchImpl(`${ENDPOINT}/${path}?alternatives=false&overview=false&steps=false&access_token=${encodeURIComponent(token)}`, { signal });
    if (!res.ok) return fail(res.status === 422 ? "no_route" : "provider_error");
    body = await res.json();
  } catch (err) {
    return fail(isAbort(err) || signal.aborted ? "timeout" : "provider_error");
  }
  if (!body || typeof body !== "object") return fail("provider_error");
  const { code, routes } = body as { code?: unknown; routes?: unknown };
  if (code === "NoRoute" || code === "NoSegment") return fail("no_route");
  if (code !== "Ok" || !Array.isArray(routes) || !routes[0] || typeof routes[0] !== "object") return fail("provider_error");
  const legs = (routes[0] as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || legs.length !== count) return fail("provider_error");
  // Two numbers per leg are read; everything else in the answer is dropped here.
  return legs.map((l) => (l && typeof l === "object" ? measuredLeg((l as { duration?: unknown }).duration, (l as { distance?: unknown }).distance) : { status: "unknown", reason: "provider_error" } as const));
}

export function createMapboxWalkingRouter({ token, fetch: fetchImpl }: { token: string; fetch: Fetch }): WalkingRouter {
  return {
    id: "mapbox-walking",
    async legs(points, { signal }) {
      const count = points.length - 1;
      if (count < 1) return [];
      if (!token) return unknownLegs(count, "not_configured");
      if (!validPoints(points)) return unknownLegs(count, "provider_error");
      // Long plans go in pieces that share an end point, so every leg is asked for exactly once.
      const out: LegResult[] = [];
      for (let start = 0; start < count; start += MAX_POINTS - 1) {
        const piece = points.slice(start, start + MAX_POINTS);
        out.push(...(await request(piece, token, fetchImpl, signal)));
      }
      return out;
    },
  };
}
