/**
 * Domain types shared by the UI, server actions and both repository
 * implementations (Supabase + demo). All dates are ISO-8601 strings.
 */

export type PlaceStatus = "published" | "pending" | "hidden" | "removed";
export type EventStatus = "published" | "cancelled" | "hidden" | "removed";
/**
 * Trust tiers for a place.
 *   public  — anyone, signed in or not
 *   locals  — only people who count as a local of the place's city
 *   private — only the creator
 * "Who is a local" is defined once in SQL (public.is_local) and mirrored by the
 * demo store: home city matches, or you have contributed a published place there.
 */
export type Visibility = "public" | "locals" | "private";

/** Statuses an owner may set. `pending` and `removed` are reserved for moderation. */
export const OWNER_SETTABLE_PLACE_STATUSES = ["published", "hidden"] as const;
export type OwnerPlaceStatus = (typeof OWNER_SETTABLE_PLACE_STATUSES)[number];

/** Upper bound on a place's photo set, enforced in the database and both repositories. */
export const MAX_PLACE_PHOTOS = 6;

export interface ProfileSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Profile extends ProfileSummary {
  bio: string | null;
  homeCity: string | null;
  interests: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProfileStats {
  places: number;
  events: number;
  followers: number;
  following: number;
}

export interface Photo {
  id: string;
  /**
   * Where the browser loads the image. Storage-backed photos resolve to the
   * authorized /api/photos/[id] route, never to a raw object URL.
   */
  url: string;
  /** Nullable for legacy rows or externally hosted images. */
  storagePath: string | null;
  uploaderId: string | null;
}

export interface Place {
  id: string;
  name: string;
  description: string;
  /** The "why locals love it" field: the heart of the local-knowledge angle. */
  localTip: string | null;
  categorySlug: string;
  lat: number;
  lng: number;
  address: string | null;
  neighborhood: string | null;
  city: string;
  creatorId: string | null;
  creator: ProfileSummary | null;
  ratingAvg: number;
  ratingCount: number;
  tags: string[];
  photos: Photo[];
  status: PlaceStatus;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceDetail extends Place {
  viewerSaved: boolean;
  viewerRating: number | null;
  /** The note attached to the viewer's own rating, if they left one. */
  viewerRatingNote: string | null;
  saveCount: number;
  /** Whether the viewer counts as a local of this place's city. */
  viewerIsLocal: boolean;
}

/** A rating with its author, for the reviews list. Notes are optional. */
export interface PlaceRating {
  id: string;
  score: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  user: ProfileSummary | null;
}

export interface Event {
  id: string;
  title: string;
  description: string;
  placeId: string | null;
  placeName: string | null;
  locationName: string;
  address: string | null;
  lat: number;
  lng: number;
  startsAt: string;
  endsAt: string | null;
  creatorId: string | null;
  creator: ProfileSummary | null;
  categorySlug: string;
  capacity: number | null;
  attendeeCount: number;
  tags: string[];
  status: EventStatus;
  createdAt: string;
}

export interface EventDetail extends Event {
  viewerJoined: boolean;
  attendees: ProfileSummary[];
}

export type ReportTargetType = "place" | "event" | "profile";
export type ReportReason =
  | "inaccurate"
  | "closed"
  | "inappropriate"
  | "spam"
  | "duplicate"
  | "other";

export interface NewPlaceInput {
  name: string;
  description: string;
  localTip?: string | null;
  categorySlug: string;
  lat: number;
  lng: number;
  address?: string | null;
  neighborhood?: string | null;
  city: string;
  tags: string[];
  visibility?: Visibility;
  photos?: StoredImage[];
}

export interface UpdatePlaceInput {
  name: string;
  description: string;
  localTip?: string | null;
  categorySlug: string;
  lat: number;
  lng: number;
  address?: string | null;
  neighborhood?: string | null;
  city: string;
  tags: string[];
  visibility?: Visibility;
}

export interface NewEventInput {
  title: string;
  description: string;
  placeId?: string | null;
  locationName: string;
  address?: string | null;
  lat: number;
  lng: number;
  startsAt: string;
  endsAt?: string | null;
  categorySlug: string;
  capacity?: number | null;
  tags: string[];
}

export type UpdateEventInput = NewEventInput;

export interface StoredImage {
  /** Public URL for avatars; a non-public storage reference for place photos. */
  url: string;
  storagePath: string | null;
}

/** How a private place photo is handed to the browser once authorized. */
export type PlacePhotoDelivery = { kind: "bytes"; body: Uint8Array<ArrayBuffer>; contentType: string };

export interface UpdateProfileInput {
  username: string;
  displayName: string;
  bio: string | null;
  homeCity: string | null;
  interests: string[];
  avatarUrl?: string | null;
}

/** A report as its filer sees it, or as the owner of the reported thing sees it. */
export interface ReportEntry {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  status: "open" | "reviewed" | "dismissed";
  createdAt: string;
  /** Resolved label for the reported place/event, when it still exists. */
  targetLabel: string | null;
}

export interface NewReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string | null;
}

export interface EventListOptions {
  viewerId?: string | null;
  includePast?: boolean;
  limit?: number;
}

export interface PlaceListOptions {
  viewerId?: string | null;
  limit?: number;
}

// ----------------------------------------------------------------------------
// Discovery queries
//
// Two read models over the same filters: cursor-paged lists of full records,
// and capped sets of compact map records. Paging pins would make dense areas
// look empty, so the map model is capped and flagged instead.
// ----------------------------------------------------------------------------

/** Degrees. A box with west > east crosses the antimeridian. */
export interface GeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface DiscoveryFilters {
  bounds?: GeoBounds | null;
  /** Literal substring; also matches category and interest labels and keywords. */
  text?: string | null;
  category?: string | null;
  /** Matches records carrying any of these interest slugs. */
  tags?: string[];
}

export interface PageRequest {
  /** Clamped to [1, MAX_PAGE_SIZE]; defaults to DEFAULT_PAGE_SIZE. */
  limit?: number;
  /** Opaque token from a previous page's nextCursor. */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export interface PlaceSearchOptions extends DiscoveryFilters, PageRequest {
  viewerId?: string | null;
}

export interface EventSearchOptions extends DiscoveryFilters, PageRequest {
  viewerId?: string | null;
  includePast?: boolean;
}

export interface MapQueryOptions extends DiscoveryFilters {
  viewerId?: string | null;
  /** Clamped to [1, MAX_MAP_MARKERS]; defaults to DEFAULT_MAP_MARKERS. */
  limit?: number;
  /** Events only. */
  includePast?: boolean;
}

/** Just enough to draw and label a pin. Full details load on selection. */
export interface PlaceMapRecord {
  id: string;
  name: string;
  categorySlug: string;
  lat: number;
  lng: number;
  ratingAvg: number;
  ratingCount: number;
}

export interface EventMapRecord {
  id: string;
  title: string;
  categorySlug: string;
  lat: number;
  lng: number;
  startsAt: string;
}

export interface MapResult<T> {
  items: T[];
  /** True when more records matched than the limit allowed. */
  truncated: boolean;
  limit: number;
}

/** A profile in a follower/following list, with the viewer's own follow state. */
export interface ConnectionEntry {
  profile: Profile;
  viewerFollows: boolean;
  isViewer: boolean;
}

export interface UserActivity {
  createdPlaces: Place[];
  createdEvents: Event[];
  joinedEvents: Event[];
  savedPlaces: Place[];
}

/** Thrown by repositories for expected, user-facing failures. */
export class DataError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "full"
      | "invalid"
      | "unavailable" = "invalid",
  ) {
    super(message);
    this.name = "DataError";
  }
}
