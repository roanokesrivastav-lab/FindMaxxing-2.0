/**
 * Pure helpers for the photo-first place page (roadmap 2.5).
 *
 * Founder decision: friends' actual reviews come first, then everyone else's. They
 * are never summarized, scored or blended: these helpers only order and split the
 * attributed reviews, they never compute anything about what friends think.
 */
import type { PlaceRating } from "@/lib/data/types";

export interface SplitReviews {
  /** Reviews by people the viewer follows, newest first. */
  friends: PlaceRating[];
  /** Everyone else's reviews (not the viewer's own), newest first. */
  everyone: PlaceRating[];
  /** The viewer's own review, shown in the "You" block, never in the lists. */
  own: PlaceRating | null;
}

const newestFirst = (a: PlaceRating, b: PlaceRating) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : 1);

/**
 * "Friends" are the people the viewer follows: the viewer's own choice, public in
 * the follow graph already, so marking their reviews reveals nothing new.
 */
export function splitReviews(ratings: PlaceRating[], followingIds: Iterable<string>, viewerId: string | null): SplitReviews {
  const following = new Set(followingIds);
  const friends: PlaceRating[] = [];
  const everyone: PlaceRating[] = [];
  let own: PlaceRating | null = null;
  for (const r of [...ratings].sort(newestFirst)) {
    const author = r.user?.id ?? null;
    if (viewerId && author === viewerId) own = r;
    else if (author && following.has(author)) friends.push(r);
    else everyone.push(r);
  }
  return { friends, everyone, own };
}

const KNOWN_FOR_MAX = 160;

/**
 * The one "known for" sentence: the first sentence of the contributor's own
 * description, never generated. Null when there is no description to quote.
 */
export function knownFor(description: string | null | undefined): string | null {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  const sentence = (match ? match[1] : text).trim();
  if (sentence.length <= KNOWN_FOR_MAX) return sentence;
  const cut = sentence.slice(0, KNOWN_FOR_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Element id for a review, so a friend's name in the Friends block can jump to it. */
export const reviewAnchor = (ratingId: string) => `review-${ratingId}`;
