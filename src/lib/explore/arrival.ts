/**
 * First-map arrival (roadmap 1.3): for each interest the viewer picked, how many matching records the
 * map would show here, and in a bigger area around it. Counted with the repositories' own count()
 * (the full authorized matching set, the same rules as the map pins), never from a capped page.
 */
import type { DataRepository } from "@/lib/data/repository";
import type { GeoBounds } from "@/lib/data/types";

export interface InterestPresence {
  slug: string;
  /** Matching places + events in the current area. */
  nearby: number;
  /** Matching places + events in the bigger area (WIDER_FACTOR times the span, same center). */
  wider: number;
}

/** "A bigger area": three times the width and height, around the same center. */
export const WIDER_FACTOR = 3;

export function widerBounds(b: GeoBounds, factor = WIDER_FACTOR): GeoBounds {
  const latHalf = ((b.north - b.south) * factor) / 2;
  // An antimeridian-crossing box (west > east) is left as is: no pilot data is near it.
  if (b.west > b.east) return b;
  const lngHalf = ((b.east - b.west) * factor) / 2;
  const lat = (b.north + b.south) / 2;
  const lng = (b.east + b.west) / 2;
  return {
    north: Math.min(90, lat + latHalf),
    south: Math.max(-90, lat - latHalf),
    east: lngHalf >= 180 ? 180 : Math.min(180, lng + lngHalf),
    west: lngHalf >= 180 ? -180 : Math.max(-180, lng - lngHalf),
  };
}

export interface PresenceQuery {
  bounds: GeoBounds;
  tags: string[];
  category: string | null;
  kind: "all" | "places" | "events";
  viewerId: string | null;
}

export async function interestPresence(repo: DataRepository, q: PresenceQuery): Promise<InterestPresence[]> {
  const count = async (bounds: GeoBounds, slug: string) => {
    const f = { bounds, tags: [slug], category: q.category, viewerId: q.viewerId };
    const [p, e] = await Promise.all([
      q.kind === "events" ? 0 : repo.places.count(f),
      q.kind === "places" ? 0 : repo.events.count(f),
    ]);
    return p + e;
  };
  return Promise.all(
    q.tags.map(async (slug) => {
      const nearby = await count(q.bounds, slug);
      // The bigger area is only asked about when it matters.
      const wider = nearby ? nearby : await count(widerBounds(q.bounds), slug);
      return { slug, nearby, wider };
    }),
  );
}

/**
 * The one widening offered for an interest with nothing here: a bigger area when that would find
 * something, otherwise all interests. Null when the interest has results. Never applied by itself.
 */
export function arrivalWidening(p: InterestPresence): "bigger-area" | "all-interests" | null {
  if (p.nearby > 0) return null;
  return p.wider > 0 ? "bigger-area" : "all-interests";
}
