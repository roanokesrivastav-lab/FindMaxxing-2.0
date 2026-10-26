import "server-only";
import { featureEnabled } from "@/lib/config";
import type { DataRepository } from "@/lib/data/repository";
import type { Event, ForYou, Place } from "@/lib/data/types";
import { rerankPlaces } from "./rerank";

/** Names what produced a rail, for comparing policies in the interaction log. */
export const POLICY_RULES = "rules-v1";
export const POLICY_RERANKED = "rules-v1+rerank";

const none = <T>(): ForYou<T> => ({ requestId: crypto.randomUUID(), policy: POLICY_RULES, items: [] });

/**
 * The "For you" rails: rule-based recommendations, optionally reranked by
 * Claude for places. Empty unless the recommendations flag is on and someone
 * is signed in. Each call is one rendering with its own request id, which
 * the cards' impressions carry, so a later save can be traced to what was
 * shown and by which policy.
 */
export async function forYouPlaces(repo: DataRepository, viewer: { id: string; profile: { interests: string[] } } | null, near: { lat: number; lng: number } | null = null): Promise<ForYou<Place>> {
  if (!viewer || !featureEnabled("recommendations")) return none();
  const recs = await repo.recommendations.places(viewer.id, { near, limit: 12 });
  if (!featureEnabled("aiRerank")) return { requestId: crypto.randomUUID(), policy: POLICY_RULES, items: recs };
  const saved = await repo.places.listSaved(viewer.id);
  const reranked = await rerankPlaces(recs, { interests: viewer.profile.interests, savedPlaceNames: saved.map((p) => p.name) });
  // rerankPlaces hands the rule-based list back untouched whenever it falls back.
  return { requestId: crypto.randomUUID(), policy: reranked === recs ? POLICY_RULES : POLICY_RERANKED, items: reranked };
}

export async function forYouEvents(repo: DataRepository, viewer: { id: string } | null, near: { lat: number; lng: number } | null = null): Promise<ForYou<Event>> {
  if (!viewer || !featureEnabled("recommendations")) return none();
  return { requestId: crypto.randomUUID(), policy: POLICY_RULES, items: await repo.recommendations.events(viewer.id, { near, limit: 12 }) };
}
