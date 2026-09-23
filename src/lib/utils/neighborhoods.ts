import type { Place } from "@/lib/data/types";

export interface NeighborhoodGroup {
  /** Display name, as first seen on a place. */
  name: string;
  city: string;
  places: Place[];
  /** Category slugs by frequency, most common first. */
  topCategories: string[];
  lat: number;
  lng: number;
}

/** Comparison key: neighborhoods differ in case/whitespace across contributors. */
export function neighborhoodKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** URL segment for a neighborhood page; decoded and matched via neighborhoodKey. */
export function neighborhoodHref(name: string): string {
  return `/neighborhoods/${encodeURIComponent(name.trim())}`;
}

/** Groups places that have a neighborhood, biggest group first. */
export function groupByNeighborhood(places: Place[]): NeighborhoodGroup[] {
  const groups = new Map<string, NeighborhoodGroup>();
  for (const place of places) {
    if (!place.neighborhood?.trim()) continue;
    const key = neighborhoodKey(place.neighborhood);
    const group = groups.get(key) ?? { name: place.neighborhood.trim(), city: place.city, places: [], topCategories: [], lat: 0, lng: 0 };
    group.places.push(place);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const p of group.places) counts.set(p.categorySlug, (counts.get(p.categorySlug) ?? 0) + 1);
    group.topCategories = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
    group.lat = group.places.reduce((sum, p) => sum + p.lat, 0) / group.places.length;
    group.lng = group.places.reduce((sum, p) => sum + p.lng, 0) / group.places.length;
  }
  return [...groups.values()].sort((a, b) => b.places.length - a.places.length || a.name.localeCompare(b.name));
}

/** Finds the group matching a decoded URL segment, if any. */
export function findNeighborhood(groups: NeighborhoodGroup[], segment: string): NeighborhoodGroup | null {
  const key = neighborhoodKey(segment);
  return groups.find((g) => neighborhoodKey(g.name) === key) ?? null;
}
