import type { NeighborhoodSummary } from "@/lib/data/types";

/**
 * Comparison key: neighborhoods differ in case/whitespace across contributors.
 * public.discover_neighborhood_key is its SQL twin; keep them in step.
 */
export function neighborhoodKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** URL segment for a neighborhood page; decoded and matched via neighborhoodKey. */
export function neighborhoodHref(name: string): string {
  return `/neighborhoods/${encodeURIComponent(name.trim())}`;
}

/** Finds the neighborhood matching a decoded URL segment, if any. */
export function findNeighborhood(groups: NeighborhoodSummary[], segment: string): NeighborhoodSummary | null {
  const key = neighborhoodKey(segment);
  return groups.find((g) => g.key === key) ?? null;
}
