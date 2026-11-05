import "server-only";
import type { LatLng, LegResult } from "@/lib/itinerary/types";
import { REQUEST_TIMEOUT_MS, unknownLegs, withRequestTimeout, type WalkingRouter } from "./adapter";

/**
 * Mapbox Directions, walking profile (decision R-1, tentative). NOT LIVE: it is only constructed when
 * the pilotItinerary flag and the server-only MAPBOX_ROUTING_TOKEN are both set (selectWalkingRouter),
 * and no test ever calls it. No new dependency: plain fetch.
 *
 * Mapbox's terms (6.0 SPEC §2) forbid caching or storing Navigation API results, so a response is used
 * for one validation and dropped: never written to the database, the demo store, logs or a shared
 * cache. Only durations and distances are requested (overview=false, steps=false): no geometry.
 */
export const MAPBOX_DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox/walking/";
/** Mapbox Directions accepts at most 25 coordinates per request. */
export const MAPBOX_MAX_WAYPOINTS = 25;

export function mapboxWalkingUrl(points: LatLng[], token: string): string {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const query = new URLSearchParams({ alternatives: "false", overview: "false", steps: "false", access_token: token });
  return `${MAPBOX_DIRECTIONS_BASE}${coords}?${query}`;
}

/** Reads only each leg's duration and distance from a Directions response; anything odd is an unknown. */
export function parseMapboxWalking(body: unknown, legCount: number): LegResult[] {
  const response = body as { code?: unknown; routes?: Array<{ legs?: Array<{ duration?: unknown; distance?: unknown }> }> } | null;
  if (response?.code === "NoRoute" || response?.code === "NoSegment") return unknownLegs(legCount, "no_route");
  const legs = response?.code === "Ok" ? response.routes?.[0]?.legs : undefined;
  if (!Array.isArray(legs) || legs.length !== legCount) return unknownLegs(legCount, "provider_error");
  return legs.map((leg): LegResult => {
    const { duration, distance } = leg ?? {};
    return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      && typeof distance === "number" && Number.isFinite(distance) && distance >= 0
      ? { status: "ok", seconds: duration, meters: distance }
      : { status: "unknown", reason: "provider_error" };
  });
}

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createMapboxWalkingRouter(token: string, fetchImpl?: Fetch): WalkingRouter {
  return {
    id: "mapbox-walking",
    async legs(points, { signal }) {
      const out: LegResult[] = [];
      // Consecutive chunks share their boundary point, so every pair is covered exactly once.
      for (let start = 0; start < points.length - 1; start += MAPBOX_MAX_WAYPOINTS - 1) {
        const chunk = points.slice(start, start + MAPBOX_MAX_WAYPOINTS);
        const count = chunk.length - 1;
        if (signal.aborted) {
          out.push(...unknownLegs(count, "timeout"));
          continue;
        }
        try {
          out.push(...await withRequestTimeout(signal, REQUEST_TIMEOUT_MS, async (requestSignal) => {
            const res = await (fetchImpl ?? (globalThis.fetch as unknown as Fetch))(mapboxWalkingUrl(chunk, token), {
              signal: requestSignal,
              headers: { accept: "application/json" },
            });
            if (res.status === 422) return unknownLegs(count, "no_route");
            if (!res.ok) return unknownLegs(count, "provider_error");
            return parseMapboxWalking(await res.json(), count);
          }));
        } catch (err) {
          // Never log the URL: it carries the token. Never log the response: it may not be stored.
          const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
          out.push(...unknownLegs(count, aborted || signal.aborted ? "timeout" : "provider_error"));
        }
      }
      return out;
    },
  };
}
