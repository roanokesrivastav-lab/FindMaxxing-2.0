/**
 * Supabase twin of personal and public photos (roadmap 2.8). Every call runs under
 * the viewer's own session: table RLS and the personal-photos storage policies admit
 * only the owner's folder, so a signed URL can only ever be minted by the owner.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import { DataError } from "../types";
import { PERSONAL_PHOTO_BUCKET, PERSONAL_PHOTO_URL_TTL, personalPhotoUrl } from "@/lib/places/personalPhotos";

type Row = { place_id: string; storage_path: string; created_at: string; updated_at: string };

export function createSupabasePersonalPhotos(supabase: SupabaseClient, h: { translate(error: PostgrestError): DataError }): DataRepository["personalPhotos"] {
  const unwrap = <T>(res: { data: T | null; error: PostgrestError | null }): T => {
    if (res.error) throw h.translate(res.error);
    return res.data as T;
  };
  const rowOf = async (ownerId: string, placeId: string) =>
    unwrap(await supabase.from("personal_place_photos").select("place_id, storage_path, created_at, updated_at").eq("user_id", ownerId).eq("place_id", placeId).maybeSingle()) as Row | null;
  const toPhoto = (r: Row) => ({ placeId: r.place_id, url: personalPhotoUrl(r.place_id, r.updated_at), createdAt: r.created_at, updatedAt: r.updated_at });
  const bucket = () => supabase.storage.from(PERSONAL_PHOTO_BUCKET);

  return {
    async get(ownerId, placeId) {
      const row = await rowOf(ownerId, placeId);
      return row ? toPhoto(row) : null;
    },
    async upload(ownerId, placeId, image) {
      const objectPath = `${ownerId}/${crypto.randomUUID()}.webp`;
      const { error } = await bucket().upload(objectPath, image.main, { contentType: "image/webp", upsert: false });
      if (error) throw new DataError(`Upload failed: ${error.message}`, "unavailable");
      const existing = await rowOf(ownerId, placeId);
      try {
        const row = existing
          ? (unwrap(await supabase.from("personal_place_photos").update({ storage_path: objectPath }).eq("user_id", ownerId).eq("place_id", placeId).select("place_id, storage_path, created_at, updated_at").single()) as Row)
          : (unwrap(await supabase.from("personal_place_photos").insert({ user_id: ownerId, place_id: placeId, storage_path: objectPath }).select("place_id, storage_path, created_at, updated_at").single()) as Row);
        if (existing) await bucket().remove([existing.storage_path]);
        return toPhoto(row);
      } catch (err) {
        await bucket().remove([objectPath]);
        throw err;
      }
    },
    async remove(ownerId, placeId) {
      const existing = await rowOf(ownerId, placeId);
      if (!existing) return;
      unwrap(await supabase.from("personal_place_photos").delete().eq("user_id", ownerId).eq("place_id", placeId));
      await bucket().remove([existing.storage_path]);
    },
    async deliver(ownerId, placeId) {
      const row = await rowOf(ownerId, placeId);
      if (!row) return null;
      const { data, error } = await bucket().createSignedUrl(row.storage_path, PERSONAL_PHOTO_URL_TTL);
      if (error || !data?.signedUrl) return null;
      return { kind: "redirect", url: data.signedUrl };
    },
  };
}

export function createSupabasePublicPhotos(supabase: SupabaseClient, h: { translate(error: PostgrestError): DataError }): DataRepository["publicPhotos"] {
  return {
    async get(placeId) {
      const res = await supabase.from("place_public_photos").select("place_id, photo_id, permission_note, created_at, setter:profiles!place_public_photos_set_by_fkey(id, username, display_name)").eq("place_id", placeId).maybeSingle();
      if (res.error) throw h.translate(res.error);
      const r = res.data as unknown as { place_id: string; photo_id: string; permission_note: string; created_at: string; setter: { id: string; username: string; display_name: string } | null } | null;
      return r ? { placeId: r.place_id, photoId: r.photo_id, permissionNote: r.permission_note, createdAt: r.created_at, setBy: r.setter ? { id: r.setter.id, username: r.setter.username, displayName: r.setter.display_name } : null } : null;
    },
    async set(_moderatorId, placeId, photoId, note) {
      const res = await supabase.rpc("set_place_public_photo", { p_place: placeId, p_photo: photoId, p_note: note });
      if (res.error) throw h.translate(res.error);
    },
  };
}
