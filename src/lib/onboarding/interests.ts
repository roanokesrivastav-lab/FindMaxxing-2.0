/**
 * Onboarding interest picker (roadmap 1.2): which six interests lead, how a tap
 * changes the selection, and the link that opens the first map.
 *
 * One limit, MAX_INTERESTS, is used by the picker, the profile schema, the map
 * link and the discovery query, so everything the picker accepts is what the
 * first map filters by. Nothing is dropped on the way.
 */
import { FEATURED_INTEREST_SLUGS, INTERESTS, MAX_INTERESTS, parseInterestTags, type Interest } from "@/lib/data/taxonomy";

export interface FeaturedInterest extends Interest {
  /** One short line under the label, so the row is recognizable without a photo. */
  blurb: string;
  /** Tint for the fallback glyph tile. */
  color: string;
  /** A team-supplied or permissioned image. None are bundled yet, so the glyph shows. */
  thumbnail: string | null;
}

const FEATURED_COPY: Record<(typeof FEATURED_INTEREST_SLUGS)[number], { blurb: string; color: string; thumbnail: string | null }> = {
  "pickup-sports": { blurb: "Open games you can join", color: "#1f8a5b", thumbnail: null },
  coffee: { blurb: "Cafés worth the walk", color: "#8b5a2b", thumbnail: null },
  "cheap-eats": { blurb: "Good food on a budget", color: "#e0741f", thumbnail: null },
  outdoors: { blurb: "Parks, trails and fresh air", color: "#2f7d4f", thumbnail: null },
  nightlife: { blurb: "Bars, shows and late nights", color: "#6b4cff", thumbnail: null },
  studying: { blurb: "Quiet spots with wifi", color: "#3b6fd6", thumbnail: null },
};

/** The six rows shown first, in order. */
export const FEATURED_INTERESTS: FeaturedInterest[] = FEATURED_INTEREST_SLUGS.map((slug) => {
  const interest = INTERESTS.find((i) => i.slug === slug);
  if (!interest) throw new Error(`featured interest ${slug} is not in the taxonomy`);
  return { ...interest, ...FEATURED_COPY[slug] };
});

/** Every other interest, behind "More interests". */
export const MORE_INTERESTS: Interest[] = INTERESTS.filter((i) => !(FEATURED_INTEREST_SLUGS as readonly string[]).includes(i.slug));

/** True when a saved selection includes something outside the first six, so "More interests" must start open. */
export function hasMoreSelected(selected: readonly string[]): boolean {
  return selected.some((slug) => MORE_INTERESTS.some((i) => i.slug === slug));
}

export interface ToggleResult {
  selected: string[];
  /** The tap asked for one more than the limit. Nothing changed; the picker says so. */
  refused: boolean;
}

/** Adds or removes one interest. Removing always works; adding stops at the limit and reports it. */
export function toggleInterest(selected: readonly string[], slug: string, max: number = MAX_INTERESTS): ToggleResult {
  if (selected.includes(slug)) return { selected: selected.filter((s) => s !== slug), refused: false };
  if (selected.length >= max) return { selected: [...selected], refused: true };
  return { selected: [...selected, slug], refused: false };
}

/**
 * Where onboarding lands. With interests it is the map filtered to all of them
 * (the same list the profile saved); without, or after "Skip setup", the
 * unfiltered map. `welcome=1` marks the first arrival.
 */
export function firstMapHref(interests: readonly string[], filtered: boolean): string {
  const tags = filtered ? parseInterestTags(interests) : [];
  return tags.length ? `/?tags=${encodeURIComponent(tags.join(","))}&welcome=1` : "/?welcome=1";
}
