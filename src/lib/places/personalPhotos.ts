/**
 * Public and personal place photos (roadmap 2.8, migration 0063).
 *
 * "Personal photo" is deliberately not called "private place photo": that name
 * already means 0005's place_photos, whose visibility follows the place. A
 * personal photo is seen by its owner and nobody else, ever (not friends,
 * moderators, the place's creator, outings, shares or recommendations).
 */
export const PERSONAL_PHOTO_BUCKET = "personal-photos";
/** Signed URLs for personal photos live this long (seconds). */
export const PERSONAL_PHOTO_URL_TTL = 300;

export interface PersonalPhoto {
  placeId: string;
  /** Where the owner's browser loads it: the owner-only route, never a raw object URL. */
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPhotoCredit {
  placeId: string;
  photoId: string;
  setBy: { id: string; displayName: string; username: string } | null;
  permissionNote: string;
  createdAt: string;
}

export type PersonalPhotoDelivery =
  | { kind: "redirect"; url: string }
  | { kind: "bytes"; body: Uint8Array<ArrayBuffer>; contentType: string };

/** The owner-only route that hands the owner their personal photo for a place. */
export const personalPhotoUrl = (placeId: string, version: string) => `/api/personal-photos/${placeId}?v=${encodeURIComponent(version)}`;

export const PHOTO_REQUIRED_MESSAGE = "Add your own photo of this place before your first rating. Only you will ever see it; a photo from your library is fine.";
