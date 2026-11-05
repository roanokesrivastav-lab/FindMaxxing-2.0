import "server-only";
import { featureEnabled } from "@/lib/config";
import type { DataRepository } from "@/lib/data/repository";
import type { Event, ForYou, Place, Recommendation } from "@/lib/data/types";
import { diversify } from "./diversify";
import { rerankPlaces } from "./rerank";

/**
 * Names what produced a rail, for comparing policies in the interaction log.
 * rules-v2: the rules with the viewer's taste (0035_user_taste.sql), then
 * category and creator diversity.
 */
export const POLICY_RULES = "rules-v2";
export const POLICY_RERANKED = "rules-v2+rerank";

/** Scored candidates fetched for the diversity pass to choose twelve from. */
const POOL = 50;
const RAIL = 12;

const varied = <T extends Place | Event>(recs: Recommendation<T>[]) =>
  diversify(recs, (r) => ({ category: r.item.categorySlug, tags: r.item.tags, creatorId: r.item.creatorId, score: r.score }), { k: RAIL });

const none = <T>(): ForYou<T> => ({ requestId: crypto.randomUUID(), policy: POLICY_RULES, items: [] });

/**
 * The "For you" rails: rule-based recommendations, optionally reranked by
 * Claude for places, after a diversity pass over the strongest fifty. Empty
 * unless the recommendations flag is on and someone is signed in. Each call is one rendering with its own request id, which
 * the cards' impressions carry, so a later save can be traced to what was
 * shown and by which policy.
 */
export async function forYouPlaces(repo: DataRepository, viewer: { id: string; profile: { interests: string[] } } | null, near: { lat: number; lng: number } | null = null): Promise<ForYou<Place>> {
  if (!viewer || !featureEnabled("recommendations")) return none();
  const recs = varied(await repo.recommendations.places(viewer.id, { near, limit: POOL }));
  if (!featureEnabled("aiRerank")) return { requestId: crypto.randomUUID(), policy: POLICY_RULES, items: recs };
  const saved = await repo.places.listSaved(viewer.id);
  const reranked = await rerankPlaces(recs, { interests: viewer.profile.interests, savedPlaceNames: saved.map((p) => p.name) });
  // rerankPlaces hands the rule-based list back untouched whenever it falls back.
  return { requestId: crypto.randomUUID(), policy: reranked === recs ? POLICY_RULES : POLICY_RERANKED, items: reranked };
}

export async function forYouEvents(repo: DataRepository, viewer: { id: string } | null, near: { lat: number; lng: number } | null = null): Promise<ForYou<Event>> {
  if (!viewer || !featureEnabled("recommendations")) return none();
  return { requestId: crypto.randomUUID(), policy: POLICY_RULES, items: varied(await repo.recommendations.events(viewer.id, { near, limit: POOL })) };
}
