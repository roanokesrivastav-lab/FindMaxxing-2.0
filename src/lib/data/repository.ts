import type {
  ConnectionEntry,
  Event,
  EventDetail,
  EventCountOptions,
  EventMapRecord,
  EventSearchOptions,
  MapQueryOptions,
  MapResult,
  NeighborhoodSummary,
  Page,
  PlaceMapRecord,
  PlaceSearchOptions,
  NewEventInput,
  NewPlaceInput,
  UpdateEventInput,
  UpdatePlaceInput,
  NewReportInput,
  OwnerPlaceStatus,
  Place,
  PlaceDetail,
  PlaceCountOptions,
  PlaceRating,
  PlacePhotoDelivery,
  ReportEntry,
  StoredImage,
  TagCounts,
  Visibility,
  Profile,
  ProfileStats,
  ProfileSummary,
  UpdateProfileInput,
  UserActivity,
} from "./types";

/**
 * The single data-access contract used by pages and server actions.
 * Two implementations exist:
 *   - SupabaseRepository (src/lib/data/supabase) — real Postgres + RLS
 *   - DemoRepository (src/lib/data/demo)         — file-backed local store
 *
 * Authorization is enforced inside implementations (RLS in Supabase, explicit
 * ownership checks in demo) and never trusted from the client.
 */
export interface DataRepository {
  places: {
    /**
     * Discovery list: every visible published place matching the filters,
     * newest first (created_at desc, id desc), in cursor pages.
     */
    search(opts?: PlaceSearchOptions): Promise<Page<Place>>;
    /** Total for the same filters, ignoring paging. */
    count(opts?: PlaceCountOptions): Promise<number>;
    /** Every neighborhood with visible places, biggest first, counted over all of them. */
    neighborhoods(opts?: { viewerId?: string | null }): Promise<NeighborhoodSummary[]>;
    /**
     * Map read model: compact records for the same filters, most notable first
     * (rating count, save count, id), capped with a truncation flag.
     */
    mapMarkers(opts?: MapQueryOptions): Promise<MapResult<PlaceMapRecord>>;
    get(id: string, viewerId?: string | null): Promise<PlaceDetail | null>;
    create(input: NewPlaceInput, creatorId: string): Promise<Place>;
    update(id: string, input: UpdatePlaceInput, creatorId: string): Promise<Place>;
    delete(id: string, creatorId: string): Promise<void>;
    addPhotos(placeId: string, images: StoredImage[], uploaderId: string): Promise<void>;
    removePhoto(placeId: string, photoId: string, uploaderId: string): Promise<{ storagePath: string | null }>;
    /**
     * The storage object behind a photo, only when the viewer may see its place.
     * Null for hidden, missing or externally hosted photos.
     */
    getPhotoObject(photoId: string, viewerId: string | null): Promise<{ storagePath: string } | null>;
    /** Owner-only. Accepts published/hidden; moderation statuses are refused. */
    setStatus(placeId: string, status: OwnerPlaceStatus, ownerId: string): Promise<void>;
    /** Owner-only. Moves a place between trust tiers. */
    setVisibility(placeId: string, visibility: Visibility, ownerId: string): Promise<void>;
    /** Ratings that carry a written note, newest first. The reviews surface. */
    listRatings(placeId: string, viewerId?: string | null): Promise<PlaceRating[]>;

    listByCreator(userId: string, viewerId?: string | null): Promise<Place[]>;
    listSaved(userId: string): Promise<Place[]>;
    save(userId: string, placeId: string): Promise<void>;
    unsave(userId: string, placeId: string): Promise<void>;
    rate(
      userId: string,
      placeId: string,
      score: number,
      note: string | null,
    ): Promise<{ ratingAvg: number; ratingCount: number }>;
    removeRating(userId: string, placeId: string): Promise<{ ratingAvg: number; ratingCount: number }>;
  };
  events: {
    /** Discovery list: visible published events, soonest first (starts_at, id), in cursor pages. */
    search(opts?: EventSearchOptions): Promise<Page<Event>>;
    /** Total for the same filters, ignoring paging. */
    count(opts?: EventCountOptions): Promise<number>;
    /** Map read model: compact records, soonest first, capped with a truncation flag. */
    mapMarkers(opts?: MapQueryOptions): Promise<MapResult<EventMapRecord>>;
    get(id: string, viewerId?: string | null): Promise<EventDetail | null>;
    create(input: NewEventInput, creatorId: string): Promise<Event>;
    update(id: string, input: UpdateEventInput, creatorId: string): Promise<Event>;
    cancel(id: string, creatorId: string): Promise<void>;
    delete(id: string, creatorId: string): Promise<void>;
    join(userId: string, eventId: string): Promise<void>;
    leave(userId: string, eventId: string): Promise<void>;
    listByCreator(userId: string, viewerId?: string | null): Promise<Event[]>;
    listJoined(userId: string, viewerId?: string | null): Promise<Event[]>;
    listForPlace(placeId: string): Promise<Event[]>;
  };
  tags: {
    /** Visible places and upcoming events per interest slug, over the whole data set. */
    counts(opts?: { viewerId?: string | null }): Promise<TagCounts>;
  };
  profiles: {
    getById(id: string): Promise<Profile | null>;
    getByUsername(username: string): Promise<Profile | null>;
    update(userId: string, input: UpdateProfileInput): Promise<Profile>;
    stats(userId: string): Promise<ProfileStats>;
    isFollowing(followerId: string, followingId: string): Promise<boolean>;
    follow(followerId: string, followingId: string): Promise<void>;
    unfollow(followerId: string, followingId: string): Promise<void>;
    listFollowing(userId: string): Promise<ProfileSummary[]>;
    /** Follower/following lists resolved for display, with the viewer's follow state. */
    connections(userId: string, kind: "followers" | "following", viewerId: string | null): Promise<ConnectionEntry[]>;
    /** True when the viewer counts as a local of the given city. */
    isLocalOf(userId: string | null, city: string): Promise<boolean>;
    activity(userId: string, viewerId?: string | null): Promise<UserActivity>;
    /** Lightweight people discovery: profiles sharing interests, excluding self + followed. */
    suggest(userId: string | null, limit?: number): Promise<Profile[]>;
    /** Case-insensitive match on username, display name or home city. Empty query returns []. */
    search(query: string, limit?: number): Promise<Profile[]>;
    /** Everyone who lists the interest, newest members first. */
    listByInterest(interestSlug: string, limit?: number): Promise<Profile[]>;
  };
  reports: {
    create(input: NewReportInput, reporterId: string): Promise<void>;
    /** Reports the user filed, newest first. */
    listFiledBy(userId: string): Promise<ReportEntry[]>;
    /** Reports against the user's own places and events. Never exposes who filed them. */
    listAgainstMyContent(userId: string): Promise<ReportEntry[]>;
  };
  storage: {
    /**
     * Stores an image. Avatars get a public URL; place photos are private and
     * get a storage reference, delivered later through /api/photos/[id].
     */
    uploadImage(file: File, folder: "places" | "avatars", ownerId: string): Promise<{ url: string; storagePath: string | null }>;
    /** Delivers a place photo object. Callers must authorize with places.getPhotoObject first. */
    deliverPlacePhoto(storagePath: string): Promise<PlacePhotoDelivery | null>;
    removeImage(folder: "places" | "avatars", storagePath: string): Promise<void>;
  };
}
