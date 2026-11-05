/** Supabase twin of the occasion notes repository (roadmap 2.7). RLS in 0061 decides visibility. */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import { DataError } from "../types";
import { normalizeOccasionInput, type Occasion, type OccasionNote, type Polarity } from "@/lib/places/occasions";

type Row = {
  id: string; place_id: string; polarity: Polarity; occasion: Occasion; note: string | null; status: OccasionNote["status"]; created_at: string;
  author: { id: string; username: string; display_name: string; avatar_url: string | null } | null;
};
const SELECT = "id, place_id, polarity, occasion, note, status, created_at, author:profiles!place_occasion_notes_author_id_fkey(id, username, display_name, avatar_url)";
const toNote = (r: Row): OccasionNote => ({
  id: r.id, placeId: r.place_id, polarity: r.polarity, occasion: r.occasion, note: r.note, status: r.status, createdAt: r.created_at,
  author: r.author ? { id: r.author.id, username: r.author.username, displayName: r.author.display_name, avatarUrl: r.author.avatar_url } : null,
});

export function createSupabaseOccasions(supabase: SupabaseClient, h: { translate(error: PostgrestError): DataError }): DataRepository["occasions"] {
  const unwrap = <T>(res: { data: T | null; error: PostgrestError | null }): T => {
    if (res.error) throw h.translate(res.error);
    return res.data as T;
  };
  return {
    async list(placeId) {
      const rows = unwrap(await supabase.from("place_occasion_notes").select(SELECT).eq("place_id", placeId).eq("status", "published").order("created_at", { ascending: false })) as unknown as Row[];
      return rows.map(toNote);
    },
    async add(userId, placeId, input) {
      const clean = normalizeOccasionInput(input);
      const existing = unwrap(
        await supabase.from("place_occasion_notes").update({ note: clean.note }).eq("place_id", placeId).eq("author_id", userId).eq("occasion", clean.occasion).eq("polarity", clean.polarity).select(SELECT),
      ) as unknown as Row[];
      if (existing.length) return toNote(existing[0]);
      const row = unwrap(await supabase.from("place_occasion_notes").insert({ place_id: placeId, author_id: userId, ...clean }).select(SELECT).single()) as unknown as Row;
      return toNote(row);
    },
    async remove(userId, noteId) {
      const rows = unwrap(await supabase.from("place_occasion_notes").delete().eq("id", noteId).eq("author_id", userId).select("id")) as { id: string }[];
      if (!rows.length) throw new DataError("Note not found", "not_found");
    },
    async setStatus(_moderatorId, noteId, status) {
      const rows = unwrap(await supabase.from("place_occasion_notes").update({ status }).eq("id", noteId).select("id")) as { id: string }[];
      if (!rows.length) throw new DataError("Moderators only", "forbidden");
    },
  };
}
