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
  ImageUpload,
  ReportEntry,
  ModerationAction,
  ModerationQueueItem,
  ModerationTargetDetail,
  PageRequest,
  RemovedContent,
  ReportTargetType,
  AnalyticsEventName,
  AdminContentItem,
  AdminHistoryEntry,
  AdminUser,
  RateLimitHit,
  TaxonomyEntry,
  FunnelStep,
  SaveSources,
  SavedList,
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
     * newest first (created_at desc, id desc), or nearest first (distance, id)
     * when `near` is given, in cursor pages.
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
  /**
   * Lists that organize a user's bookmarks. places.save/unsave stay the
   * bookmark itself: a saved place may be in no list or in several, and
   * unsaving it removes it from every list. All methods act on the owner's own
   * lists only; anyone else's list is not_found.
   */
  savedLists: {
    /** The owner's lists, most recently changed first. */
    list(ownerId: string): Promise<SavedList[]>;
    /** Names are trimmed and must be unique per owner, ignoring case (conflict); at most MAX_SAVED_LISTS (full). */
    create(ownerId: string, name: string): Promise<SavedList>;
    rename(ownerId: string, listId: string, name: string): Promise<void>;
    /** Removes the list and its memberships; the bookmarks stay saved. */
    delete(ownerId: string, listId: string): Promise<void>;
    /** Bookmarks the place if it is not already saved, then adds it. Idempotent. */
    addPlace(ownerId: string, listId: string, placeId: string): Promise<void>;
    /** Takes the place out of this list only; it stays saved. */
    removePlace(ownerId: string, listId: string, placeId: string): Promise<void>;
    /** The list and the places in it the owner can open, most recently added first. */
    get(ownerId: string, listId: string): Promise<{ list: SavedList; places: Place[] } | null>;
    /** Ids of the owner's lists that contain the place. */
    memberships(ownerId: string, placeId: string): Promise<string[]>;
  };
  profiles: {
    getById(id: string): Promise<Profile | null>;
    getByUsername(username: string): Promise<Profile | null>;
    update(userId: string, input: UpdateProfileInput): Promise<Profile>;
    /** Marks first-run onboarding finished (or skipped). Idempotent. */
    completeOnboarding(userId: string): Promise<void>;
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
  /**
   * Report review. Every method except myRemovedContent is for moderators:
   * the queue and target reads come back empty (or null) for anyone else, and
   * writes are refused as forbidden. Supabase enforces this in the database
   * (is_moderator()); the viewer ids are what the demo store checks.
   */
  moderation: {
    isModerator(userId: string | null): Promise<boolean>;
    /** Open reports grouped by target, oldest report first, in cursor pages. */
    queue(viewerId: string, opts?: PageRequest): Promise<Page<ModerationQueueItem>>;
    /** The target as it is now, all its reports with their reporters, and its history. */
    target(viewerId: string, targetType: ReportTargetType, targetId: string): Promise<ModerationTargetDetail | null>;
    /**
     * Resolves every open report on the target together, changing the
     * content's status when the action calls for it, and records the action.
     */
    resolve(
      moderatorId: string,
      input: { targetType: ReportTargetType; targetId: string; action: ModerationAction; reason?: string | null },
    ): Promise<{ statusAfter: string | null; resolvedReports: number }>;
    /** Revokes or restores a user's local status. A reason is required either way. */
    setLocalStatus(moderatorId: string, userId: string, revoked: boolean, reason: string): Promise<void>;
    /** Whether a moderator has revoked this user's local status. */
    localRevoked(userId: string): Promise<boolean>;
    /** The viewer's own places and events that moderators removed, with the reason. */
    myRemovedContent(userId: string): Promise<RemovedContent[]>;
  };
  /**
   * First-party analytics. track() records an event for the user under a
   * pseudonymous actor, and does nothing for users who opted out. The
   * metric reads return nothing for anyone but admins.
   */
  analytics: {
    track(userId: string, name: AnalyticsEventName, props?: Record<string, string | number | boolean | null>): Promise<void>;
    optedOut(userId: string): Promise<boolean>;
    setOptOut(userId: string, optOut: boolean): Promise<void>;
    funnel(viewerId: string, from: string, to: string): Promise<FunnelStep[]>;
    weeklyContributors(viewerId: string, weeks: number): Promise<{ weekStart: string; contributors: number }[]>;
    /** Saves made in the window, by where the saved place came from (the thesis metric). */
    saveSources(viewerId: string, from: string, to: string): Promise<SaveSources>;
  };
  /**
   * The admin dashboard. Reads return nothing (and writes are refused) for
   * anyone who is not an admin; every write is recorded in the moderation
   * history.
   */
  admin: {
    isAdmin(userId: string | null): Promise<boolean>;
    isSuspended(userId: string): Promise<boolean>;
    users(viewerId: string, opts?: PageRequest & { query?: string | null }): Promise<Page<AdminUser>>;
    content(viewerId: string, opts?: PageRequest & { kind?: "place" | "event"; status?: string | null; query?: string | null; creatorId?: string | null }): Promise<Page<AdminContentItem>>;
    rateLimitHits(viewerId: string): Promise<RateLimitHit[]>;
    /** Audit entries for one target, newest first (every page). */
    history(viewerId: string, target: { type: "place" | "event" | "profile" | "category" | "interest"; id?: string; key?: string }): Promise<AdminHistoryEntry[]>;
    setSuspended(adminId: string, userId: string, suspended: boolean, reason: string): Promise<void>;
    setModerator(adminId: string, userId: string, moderator: boolean, reason: string): Promise<void>;
    taxonomy(viewerId: string): Promise<TaxonomyEntry[]>;
    upsertTaxonomy(adminId: string, entry: Omit<TaxonomyEntry, "retired">, reason: string): Promise<void>;
    setTaxonomyRetired(adminId: string, kind: TaxonomyEntry["kind"], slug: string, retired: boolean, reason: string): Promise<void>;
  };
  /** Levels are cached; refreshAll is the hourly cron, reset is a moderator action. */
  reputation: {
    /** Moderators only: signals before now stop counting; recorded in the moderation history. */
    reset(moderatorId: string, userId: string, reason: string): Promise<void>;
    /** Service-level: recomputes every level. Returns how many profiles were refreshed. */
    refreshAll(): Promise<number>;
  };
  storage: {
    /**
     * Stores an image. Avatars get a public URL; place photos are private and
     * get a storage reference, delivered later through /api/photos/[id].
     */
    uploadImage(image: ImageUpload, folder: "places" | "avatars", ownerId: string): Promise<{ url: string; storagePath: string | null }>;
    /**
     * Delivers one stored place-photo object (the photo's path or one of its
     * size variants), or null when it does not exist. Callers must authorize
     * with places.getPhotoObject first.
     */
    deliverPlacePhoto(objectPath: string): Promise<PlacePhotoDelivery | null>;
    /** Removes an image and, for place photos, every stored size of it. */
    removeImage(folder: "places" | "avatars", storagePath: string): Promise<void>;
  };
}
