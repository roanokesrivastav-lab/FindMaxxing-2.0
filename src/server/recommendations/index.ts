import "server-only";
import { featureEnabled } from "@/lib/config";
import type { DataRepository } from "@/lib/data/repository";
import type { Event, Place, Recommendation } from "@/lib/data/types";
import { rerankPlaces } from "./rerank";

/**
 * The "For you" rails: rule-based recommendations, optionally reranked by
 * Claude for places. Empty unless the recommendations flag is on and someone
 * is signed in.
 */
export async function forYouPlaces(repo: DataRepository, viewer: { id: string; profile: { interests: string[] } } | null, near: { lat: number; lng: number } | null = null): Promise<Recommendation<Place>[]> {
  if (!viewer || !featureEnabled("recommendations")) return [];
  const recs = await repo.recommendations.places(viewer.id, { near, limit: 12 });
  if (!featureEnabled("aiRerank")) return recs;
  const saved = await repo.places.listSaved(viewer.id);
  return rerankPlaces(recs, { interests: viewer.profile.interests, savedPlaceNames: saved.map((p) => p.name) });
}

export async function forYouEvents(repo: DataRepository, viewer: { id: string } | null, near: { lat: number; lng: number } | null = null): Promise<Recommendation<Event>[]> {
  if (!viewer || !featureEnabled("recommendations")) return [];
  return repo.recommendations.events(viewer.id, { near, limit: 12 });
}
