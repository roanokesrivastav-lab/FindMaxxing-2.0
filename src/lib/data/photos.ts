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

/**
 * Content type from the bytes themselves. Migrated legacy objects keep their
 * original name (and extension) but hold WebP, so the name cannot be trusted.
 */
export function sniffImageType(bytes: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}
