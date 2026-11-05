import type { LatLng, LegResult } from "@/lib/itinerary/types";
import type { WalkingRouter } from "./adapter";

/**
 * The deterministic fake walking router (6.0 SPEC §3): used by tests, demo mode, and anywhere no
 * provider key exists. It is ours, so its output may be cached or shown freely.
 *
 * - walking distance = haversine x 1.3 detour factor, at 80 m/min, rounded up to whole minutes;
 * - a fixture river: a straight line that crosses it detours over the nearest fixture bridge;
 * - a fixture island: any leg to or from it has no route.
 *
 * The fixtures are simplified shapes near the demo data in Columbus; they are not real geography.
 */
export const DETOUR_FACTOR = 1.3;
export const WALK_METERS_PER_MIN = 80;

/** Fixture river, north to south, west of the demo centre. */
export const FIXTURE_RIVER: readonly LatLng[] = [
  { lat: 39.99, lng: -83.012 },
  { lat: 39.97, lng: -83.01 },
  { lat: 39.955, lng: -83.006 },
  { lat: 39.94, lng: -83.0 },
];
/** Fixture bridges, each on the river line. */
export const FIXTURE_BRIDGES: readonly LatLng[] = [
  { lat: 39.98, lng: -83.011 },
  { lat: 39.9625, lng: -83.008 },
];
/** Fixture island with no walking access. */
export const FIXTURE_ISLAND = { center: { lat: 39.95, lng: -83.02 } as LatLng, radiusMeters: 150 };

export function haversineMeters(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Planar segment intersection on lng/lat; fine at a neighbourhood's scale. */
function segmentsCross(p1: LatLng, p2: LatLng, q1: LatLng, q2: LatLng): boolean {
  const cross = (a: LatLng, b: LatLng, c: LatLng) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function crossesFixtureRiver(a: LatLng, b: LatLng): boolean {
  return FIXTURE_RIVER.slice(1).some((p, i) => segmentsCross(a, b, FIXTURE_RIVER[i], p));
}

function onIsland(p: LatLng): boolean {
  return haversineMeters(p, FIXTURE_ISLAND.center) <= FIXTURE_ISLAND.radiusMeters;
}

/** One fake leg. */
export function fakeLeg(a: LatLng, b: LatLng): LegResult {
  if (onIsland(a) || onIsland(b)) return { status: "unknown", reason: "no_route" };
  const straight = crossesFixtureRiver(a, b)
    ? Math.min(...FIXTURE_BRIDGES.map((bridge) => haversineMeters(a, bridge) + haversineMeters(bridge, b)))
    : haversineMeters(a, b);
  const meters = Math.round(straight * DETOUR_FACTOR);
  return { status: "ok", seconds: Math.ceil(meters / WALK_METERS_PER_MIN) * 60, meters };
}

export const fakeWalkingRouter: WalkingRouter = {
  id: "fake",
  async legs(points) {
    return points.slice(1).map((p, i) => fakeLeg(points[i], p));
  },
};
