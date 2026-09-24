import type { GeoBounds } from "@/lib/data/types";

/** Wraps any longitude into [-180, 180]. */
function wrapLng(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Turns a map library's viewport into bounds the discovery API accepts.
 * Map libraries report longitudes past ±180 when the world repeats, so they
 * are wrapped; a box that then has west > east crosses the antimeridian,
 * which the API supports. A viewport wider than the world covers everything.
 * Values are rounded (~11 m) so tiny jitters do not produce new requests.
 */
export function normalizeViewportBounds(raw: GeoBounds): GeoBounds {
  const north = round(Math.min(90, Math.max(-90, raw.north)));
  const south = round(Math.min(90, Math.max(-90, raw.south)));
  if (raw.east - raw.west >= 360) return { north, south, east: 180, west: -180 };
  return { north, south, east: round(wrapLng(raw.east)), west: round(wrapLng(raw.west)) };
}

/** `west,south,east,north`, the order the discovery endpoints take. */
export function bboxParam(b: GeoBounds): string {
  return [b.west, b.south, b.east, b.north].join(",");
}

export function sameBounds(a: GeoBounds | null, b: GeoBounds | null): boolean {
  return a === b || (!!a && !!b && bboxParam(a) === bboxParam(b));
}
