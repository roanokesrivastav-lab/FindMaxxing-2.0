/**
 * Onboarding interest picker rules (roadmap 1.2), shared by the picker, the hand-off to the first map
 * and the Explore page, so what someone picks is exactly what the map honours.
 */
import { INTERESTS, INTEREST_MAP } from "@/lib/data/taxonomy";

/**
 * The most interests the map's discovery query takes (discoveryQuerySchema `tags` keeps the first 8).
 * The pilot picker stops at the same number, so nothing picked is silently dropped. A test pins this
 * to the shared schema.
 */
export const MAP_INTEREST_LIMIT = 8;

/** The six recognizable interests shown first; the rest sit behind "More interests". */
export const FEATURED_INTERESTS = ["pickup-sports", "coffee", "food", "hiking", "nightlife", "music"] as const;

/**
 * The category whose PlaceGlyph stands in as an interest's thumbnail (no interest has an image).
 * Unlisted interests fall back to "other" through PlaceGlyph itself.
 */
export const INTEREST_GLYPH: Record<string, string> = {
  sports: "watch-party",
  "pickup-sports": "pickup-sports",
  fitness: "fitness",
  hiking: "outdoors",
  outdoors: "outdoors",
  food: "food",
  coffee: "coffee-study",
  studying: "coffee-study",
  nightlife: "nightlife",
  music: "music",
  art: "arts",
  gaming: "gaming-hobby",
  "board-games": "gaming-hobby",
  climbing: "fitness",
  running: "fitness",
  cycling: "outdoors",
  "ohio-state": "college",
  college: "college",
  "cheap-eats": "food",
  "date-night": "date-spot",
  dogs: "outdoors",
  volunteering: "community",
  "new-in-town": "community",
  social: "community",
};

/** Toggle one interest. Adding past the limit changes nothing; unknown slugs are ignored. */
export function toggleInterest(selected: readonly string[], slug: string, limit = MAP_INTEREST_LIMIT): string[] {
  if (selected.includes(slug)) return selected.filter((s) => s !== slug);
  if (!(slug in INTEREST_MAP) || selected.length >= limit) return [...selected];
  return [...selected, slug];
}

/**
 * The rows to show: the six, plus (collapsed) any picked interest outside them so a pick is never
 * hidden, or (expanded) every interest, the six first.
 */
export function visibleInterests(selected: readonly string[], expanded: boolean): string[] {
  const featured: string[] = [...FEATURED_INTERESTS];
  const rest = INTERESTS.map((i) => i.slug).filter((s) => !featured.includes(s));
  return expanded ? [...featured, ...rest] : [...featured, ...rest.filter((s) => selected.includes(s))];
}

/** The interests the first map starts with: the picked ones, in order, up to the limit. */
export function mapInterests(selected: readonly string[]): string[] {
  return selected.filter((s) => s in INTEREST_MAP).slice(0, MAP_INTEREST_LIMIT);
}

/** Where onboarding lands: the map filtered to the picked interests, flagged as the welcome visit. */
export function welcomeMapHref(selected: readonly string[]): string {
  const tags = mapInterests(selected);
  return tags.length ? `/?tags=${encodeURIComponent(tags.join(","))}&welcome=1` : "/?welcome=1";
}
