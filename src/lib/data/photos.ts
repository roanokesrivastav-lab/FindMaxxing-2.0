/**
 * Photo delivery rules shared by the Supabase and demo repositories.
 *
 * Place photo objects are private. A Storage-backed photo is always rendered
 * through the authorized route, which re-checks place visibility per request;
 * only externally hosted images (no storage path) keep their stored URL.
 */
export const PLACE_PHOTO_BUCKET = "place-photos";

export function placePhotoUrl(photo: { id: string; url: string; storagePath: string | null }): string {
  return photo.storagePath ? `/api/photos/${photo.id}` : photo.url;
}

/** Non-public reference stored in place_photos.url for private objects. */
export function placePhotoReference(storagePath: string): string {
  return `storage:${PLACE_PHOTO_BUCKET}/${storagePath}`;
}
