/**
 * The deterministic fake walking router (6.0 §3): used by tests, by demo mode,
 * and in place of a provider until one is configured. Same input, same answer.
 *
 * - Distance is the great-circle distance times a 1.3 detour factor, walked at
 *   80 m a minute and rounded up to whole minutes.
 * - A barrier (a river) cannot be crossed in a straight line: a leg that would
 *   cross it goes by the fixture bridge that makes the walk shortest.
 * - A point inside a no-route zone (an island) cannot be reached: unknown.
 *
 * It is an estimate and says so through its id ("fake"); see describeRouter.
 */
import { unknownLegs, validPoints, type LatLng, type LegResult, type WalkingRouter } from "./types";

export interface FakeRouteFixtures {
  /** Polylines that cannot be crossed except at a bridge. */
  barriers: ReadonlyArray<{ line: readonly LatLng[]; bridges: readonly LatLng[] }>;
  /** Places no walking route reaches. */
  noRoute: ReadonlyArray<{ center: LatLng; radiusMeters: number }>;
}

export const DETOUR_FACTOR = 1.3;
export const WALK_METERS_PER_MINUTE = 80;

/**
 * Demo fixtures for the pilot area: the Scioto through downtown Columbus, drawn as a few straight
 * pieces, with its downtown bridges, and one unreachable spot in the river. Approximate on purpose:
 * this is a stand-in for a routing service, not a map.
 */
export const COLUMBUS_FIXTURES: FakeRouteFixtures = {
  barriers: [
    {
      line: [
        { lat: 39.9755, lng: -83.0215 },
        { lat: 39.9668, lng: -83.0128 },
        { lat: 39.9612, lng: -83.0068 },
        { lat: 39.9555, lng: -83.0062 },
        { lat: 39.9470, lng: -83.0085 },
      ],
      bridges: [
        { lat: 39.9668, lng: -83.0128 }, // Souder / Spring
        { lat: 39.9622, lng: -83.0079 }, // Broad
        { lat: 39.9590, lng: -83.0066 }, // Rich
        { lat: 39.9555, lng: -83.0062 }, // Main
      ],
    },
  ],
  noRoute: [{ center: { lat: 39.9601, lng: -83.0067 }, radiusMeters: 40 }],
};

const RAD = Math.PI / 180;
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Planar test on degrees: fine at city scale, and exact about which side of a line a point is on.
const side = (a: LatLng, b: LatLng, c: LatLng) => Math.sign((b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng));
function crosses(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const s1 = side(a, b, c), s2 = side(a, b, d), s3 = side(c, d, a), s4 = side(c, d, b);
  return s1 !== s2 && s3 !== s4 && s1 !== 0 && s2 !== 0 && s3 !== 0 && s4 !== 0;
}
const crossesLine = (a: LatLng, b: LatLng, line: readonly LatLng[]) => line.slice(1).some((p, i) => crosses(a, b, line[i], p));

function leg(from: LatLng, to: LatLng, fixtures: FakeRouteFixtures): LegResult {
  if (fixtures.noRoute.some((z) => haversineMeters(z.center, from) <= z.radiusMeters || haversineMeters(z.center, to) <= z.radiusMeters)) {
    return { status: "unknown", reason: "no_route" };
  }
  let straight = haversineMeters(from, to);
  for (const barrier of fixtures.barriers) {
    if (!crossesLine(from, to, barrier.line)) continue;
    // By the bridge that makes the walk shortest; with no bridge there is no way across.
    const viaBridge = Math.min(...barrier.bridges.map((bridge) => haversineMeters(from, bridge) + haversineMeters(bridge, to)));
    if (!Number.isFinite(viaBridge)) return { status: "unknown", reason: "no_route" };
    straight = Math.max(straight, viaBridge);
  }
  const meters = straight * DETOUR_FACTOR;
  const minutes = Math.max(0, Math.ceil(meters / WALK_METERS_PER_MINUTE - 1e-9));
  return { status: "ok", seconds: minutes * 60, meters: Math.round(meters) };
}

export function createFakeRouter(fixtures: FakeRouteFixtures = COLUMBUS_FIXTURES): WalkingRouter {
  return {
    id: "fake",
    async legs(points) {
      if (!validPoints(points)) return unknownLegs(points.length - 1, "provider_error");
      return points.slice(1).map((to, i) => leg(points[i], to, fixtures));
    },
  };
}
