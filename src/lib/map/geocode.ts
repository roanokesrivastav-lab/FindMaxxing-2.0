/**
 * Address lookup shared by the client and the /api/geocode route.
 *
 * The provider lives behind this module so the map and the address field agree
 * on one shape. Mapbox is used when a token is configured; otherwise Nominatim
 * (OpenStreetMap), which needs no key and is the default in this project.
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** Human-readable place label, e.g. "1210 Oak Street, Olde Towne East, Columbus". */
  label: string;
  /**
   * [west, south, east, north]. A full street address yields a tight box and a
   * neighborhood a wide one, which is what lets the map pick a sensible zoom
   * instead of guessing one.
   */
  bbox: [number, number, number, number] | null;
}

/** Shortest query worth sending. Below this the result is noise. */
export const MIN_GEOCODE_QUERY = 5;

export function buildAddressQuery(parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(", ");
}

/** Keeps a partial address useful without duplicating a street name. */
export function composeAddress(values: { city: string; streetName: string; exactAddress: string }, includeCity = false): string {
  const exact = values.exactAddress.trim();
  const street = values.streetName.trim();
  const city = values.city.trim();
  // Accept either a full address or just a house/building number in the exact
  // field. If it is only a number, combine it with the separately entered street.
  const normalize = (value: string) => value.toLowerCase().replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd").replace(/\bdrive\b/g, "dr");
  const streetLine = exact && street && !normalize(exact).includes(normalize(street))
    ? `${exact} ${street}`
    : exact || street;
  return [streetLine, includeCity ? city : ""].filter(Boolean).join(", ");
}

/** Builds a lookup query from the progressive address fields. */
export function composeGeocodeQuery(
  values: { city: string; streetName: string; exactAddress: string; neighborhood?: string },
  extra?: string,
): string {
  return buildAddressQuery([composeAddress(values), values.neighborhood, values.city, extra]);
}

/** Converts a Nominatim `boundingbox` ([south, north, west, east] strings). */
export function bboxFromNominatim(v: unknown): GeocodeResult["bbox"] {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [south, north, west, east] = v.map((n) => Number(n));
  if ([south, north, west, east].some((n) => !Number.isFinite(n))) return null;
  return [west, south, east, north];
}

interface NominatimRow {
  lat?: string;
  lon?: string;
  display_name?: string;
  boundingbox?: unknown;
}

export function mapNominatim(rows: unknown): GeocodeResult[] {
  if (!Array.isArray(rows)) return [];
  const out: GeocodeResult[] = [];
  for (const row of rows as NominatimRow[]) {
    const lat = Number(row?.lat);
    const lng = Number(row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.push({
      lat,
      lng,
      label: typeof row.display_name === "string" ? row.display_name : "",
      bbox: bboxFromNominatim(row.boundingbox),
    });
  }
  return out;
}

interface MapboxFeature {
  center?: unknown;
  place_name?: string;
  bbox?: unknown;
}

export function mapMapbox(body: unknown): GeocodeResult[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: GeocodeResult[] = [];
  for (const f of features as MapboxFeature[]) {
    const center = f?.center;
    if (!Array.isArray(center) || center.length < 2) continue;
    const lng = Number(center[0]);
    const lat = Number(center[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let bbox: GeocodeResult["bbox"] = null;
    if (Array.isArray(f.bbox) && f.bbox.length === 4) {
      const b = f.bbox.map((n) => Number(n));
      if (b.every((n) => Number.isFinite(n))) bbox = [b[0], b[1], b[2], b[3]];
    }
    out.push({ lat, lng, label: typeof f.place_name === "string" ? f.place_name : "", bbox });
  }
  return out;
}

/**
 * Picks a map zoom from how large the matched area is. A house-number match is
 * a few metres across and should land close; a neighborhood should stay wide.
 */
export function zoomForBbox(bbox: GeocodeResult["bbox"]): number {
  if (!bbox) return 16;
  const [west, south, east, north] = bbox;
  const spread = Math.max(Math.abs(north - south), Math.abs(east - west));
  if (spread < 0.002) return 17;
  if (spread < 0.01) return 16;
  if (spread < 0.05) return 14;
  if (spread < 0.2) return 12;
  return 10;
}

/** Trims a long provider label down to something that fits in a chip. */
export function shortLabel(label: string, parts = 3): string {
  const segments = label.split(",").map((s) => s.trim()).filter(Boolean);
  return segments.slice(0, parts).join(", ") || label;
}

/** Client-side lookup against our own route. Returns [] on any failure. */
export async function geocodeAddress(query: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const q = query.trim();
  if (q.length < MIN_GEOCODE_QUERY) return [];
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: GeocodeResult[] };
    return Array.isArray(body.results) ? body.results : [];
  } catch {
    // Aborted or offline: the caller treats this the same as "no match".
    return [];
  }
}
