/** Supabase twin of the save-details repository (roadmap 3.1). saved_places RLS is owner-only. */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import { DataError } from "../types";
import { libraryOps } from "../libraryOps";
import { libraryOrder, type LibraryItem } from "@/lib/places/library";
import { PLACE_SELECT, fetchAllRows, mapPlace, type PlaceRow } from "./repository";
import { countTags, normalizeSaveInput, type SaveDetails, type SaveStatus } from "@/lib/places/saves";

export type SaveDbRow = {
  place_id: string; note: string | null; tags: string[] | null; source_url: string | null; recommended_by: string | null;
  status: SaveStatus; created_at: string; updated_at: string;
};
export const SAVE_COLUMNS = "place_id, note, tags, source_url, recommended_by, status, created_at, updated_at";
export const toSaveDetails = (r: SaveDbRow): SaveDetails => ({
  placeId: r.place_id, note: r.note, tags: r.tags ?? [], sourceUrl: r.source_url, recommendedBy: r.recommended_by,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createSupabaseSaves(supabase: SupabaseClient, h: { translate(error: PostgrestError): DataError; repo(): DataRepository }): DataRepository["saves"] {
  const unwrap = <T>(res: { data: T | null; error: PostgrestError | null }): T => {
    if (res.error) throw h.translate(res.error);
    return res.data as T;
  };
  return {
    ...libraryOps(h.repo),
    async library(ownerId) {
      const [rows, items] = await Promise.all([
        fetchAllRows((from, to) =>
          supabase.from("saved_places").select(`${SAVE_COLUMNS}, place:places!saved_places_place_id_fkey(${PLACE_SELECT})`).eq("user_id", ownerId)
            .order("created_at", { ascending: false }).order("place_id", { ascending: true }).range(from, to),
        ) as unknown as Promise<(SaveDbRow & { place: PlaceRow | null })[]>,
        fetchAllRows((from, to) => supabase.from("saved_list_items").select("list_id, place_id").eq("owner_id", ownerId).order("list_id").order("place_id").range(from, to)) as unknown as Promise<{ list_id: string; place_id: string }[]>,
      ]);
      const lists = new Map<string, string[]>();
      for (const i of items) lists.set(i.place_id, [...(lists.get(i.place_id) ?? []), i.list_id]);
      return rows
        .filter((r) => r.place && r.place.status === "published")
        .map((r): LibraryItem => ({ place: mapPlace(r.place!), save: toSaveDetails(r), listIds: lists.get(r.place_id) ?? [] }))
        .sort(libraryOrder);
    },
    async get(ownerId, placeId) {
      const row = unwrap(await supabase.from("saved_places").select(SAVE_COLUMNS).eq("user_id", ownerId).eq("place_id", placeId).maybeSingle()) as SaveDbRow | null;
      return row ? toSaveDetails(row) : null;
    },
    async update(ownerId, placeId, input) {
      const clean = normalizeSaveInput(input);
      const patch: Record<string, unknown> = {};
      if ("note" in clean) patch.note = clean.note;
      if ("tags" in clean) patch.tags = clean.tags;
      if ("sourceUrl" in clean) patch.source_url = clean.sourceUrl;
      if ("recommendedBy" in clean) patch.recommended_by = clean.recommendedBy;
      if ("status" in clean) patch.status = clean.status;
      const rows = unwrap(await supabase.from("saved_places").update(patch).eq("user_id", ownerId).eq("place_id", placeId).select(SAVE_COLUMNS)) as SaveDbRow[];
      if (!rows.length) throw new DataError("Save it first", "not_found");
      return toSaveDetails(rows[0]);
    },
    async tags(ownerId) {
      const rows = unwrap(await supabase.from("saved_places").select("tags").eq("user_id", ownerId).range(0, 4999)) as { tags: string[] | null }[];
      return countTags(rows.map((r) => ({ tags: r.tags ?? [] })));
    },
  };
}
