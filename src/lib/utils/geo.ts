export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function isValidLat(v: number) {
  return Number.isFinite(v) && v >= -90 && v <= 90;
}
export function isValidLng(v: number) {
  return Number.isFinite(v) && v >= -180 && v <= 180;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function boundsFromPoints(points: LatLng[], paddingDeg = 0.01): Bounds | null {
  if (points.length === 0) return null;
  let north = -90,
    south = 90,
    east = -180,
    west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lng);
    west = Math.min(west, p.lng);
  }
  return {
    north: north + paddingDeg,
    south: south - paddingDeg,
    east: east + paddingDeg,
    west: west - paddingDeg,
  };
}
