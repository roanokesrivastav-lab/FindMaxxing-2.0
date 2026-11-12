/**
 * First-map arrival (roadmap 1.3): what the map may say, and offer, when a
 * newcomer lands on it filtered to their interests.
 *
 * Two rules shape everything here:
 * - Filters are never relaxed for the viewer. An empty result is reported as
 *   empty, and the only changes are ones the viewer taps: remove an interest,
 *   "Show everything", or the one widening offered ("Search a wider area").
 * - Nothing is claimed that the loaded data cannot support. An interest is
 *   called empty only when every result in the area is loaded; otherwise it is
 *   unknown and nothing is said.
 */
import type { GeoBounds } from "@/lib/data/types";

/** sessionStorage key written by onboarding when the location prompt was refused. */
export const LOCATION_DENIED_KEY = "findmaxxing:location-denied";

export interface ArrivalInput {
  /** Interest filters currently applied to the map. */
  interests: readonly string[];
  /** False while a query is in flight or its results are not the ones on screen. */
  settled: boolean;
  /** The last query failed; the map has its own retry for that. */
  failed: boolean;
  /** Pins in the area for the current filters. */
  total: number;
  /** Tags of every loaded place and event in the area. */
  loadedTags: readonly (readonly string[])[];
  /** True when loadedTags covers every result (no further page, pins not capped) and interests are the only filter. */
  complete: boolean;
  /** Location permission is off, so "nearby" cannot mean near the viewer. */
  locationDenied: boolean;
  /** The viewer already used the widening. */
  widened: boolean;
}

export interface ArrivalNotice {
  /** Interests with no results in the area. Empty when all have some, or when it is not known. */
  emptyInterests: string[];
  /** None of the selected interests has any result in the area. */
  nothingMatches: boolean;
  /** The viewer widened the area and there is still something missing. */
  stillEmptyAfterWidening: boolean;
  locationDenied: boolean;
  /** The one widening to offer, or null. Never more than one. */
  widening: "wider-area" | null;
}

/** Interests none of the loaded results carries; null when the loaded results are not the whole picture. */
export function interestsWithoutMatches(interests: readonly string[], loadedTags: readonly (readonly string[])[], complete: boolean): string[] | null {
  if (!complete) return null;
  return interests.filter((slug) => !loadedTags.some((tags) => tags.includes(slug)));
}

export function arrivalNotice(input: ArrivalInput): ArrivalNotice {
  const quiet: ArrivalNotice = { emptyInterests: [], nothingMatches: false, stillEmptyAfterWidening: false, locationDenied: input.locationDenied, widening: null };
  // While loading, after a failure, or with no interest filter, there is nothing truthful to say about interests.
  const known = input.settled && !input.failed && input.interests.length > 0;
  const nothingMatches = known && input.total === 0;
  const emptyInterests = !known ? [] : nothingMatches ? [...input.interests] : (interestsWithoutMatches(input.interests, input.loadedTags, input.complete) ?? []);
  const missing = emptyInterests.length > 0;
  return {
    ...quiet,
    emptyInterests,
    nothingMatches,
    stillEmptyAfterWidening: missing && input.widened,
    // One widening, offered once: when something is missing, or when location is off and the
    // starting area is only a guess. After it is used, what is left is on the strip already:
    // remove an interest or show everything.
    widening: !input.widened && (missing || (input.locationDenied && input.settled && !input.failed)) ? "wider-area" : null,
  };
}

/**
 * The same centre, `factor` times the span in each direction: the "bigger
 * area" for the one widening. Latitude stays inside the Web Mercator range and
 * a box wider than the world becomes the whole world.
 */
export function widerBounds(b: GeoBounds, factor = 2): GeoBounds {
  const midLat = (b.north + b.south) / 2;
  const halfLat = (Math.abs(b.north - b.south) / 2) * factor;
  // A box that crosses the antimeridian has west > east.
  const span = b.east >= b.west ? b.east - b.west : b.east + 360 - b.west;
  const halfLng = (span / 2) * factor;
  const midLng = b.west + span / 2;
  const north = Math.min(85, midLat + halfLat);
  const south = Math.max(-85, midLat - halfLat);
  if (halfLng >= 180) return { north, south, east: 180, west: -180 };
  return { north, south, east: midLng + halfLng, west: midLng - halfLng };
}

/** "Coffee", "Coffee or Hiking", "Coffee, Hiking or Dogs". */
export function orList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
