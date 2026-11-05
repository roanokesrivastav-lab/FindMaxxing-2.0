import type {
  ComparisonPrompt,
  ConnectionEntry,
  AdCampaign,
  GeoBounds,
  NewCampaignInput,
  SponsoredCard,
  Entitlement,
  Ticket,
  TicketReservation,
  TicketSummary,
  AppNotification,
  NotificationSettings,
  PushClaim,
  PushDevice,
  ConversationDetail,
  ConversationSummary,
  Message,
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
  Recommendation,
  RecommendOptions,
  InteractionInput,
  UserInteraction,
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
import type { EventSeries, HostParticipant, JoinOutcome, NewSeriesInput, SeriesUpdateInput, ViewerParticipation } from "@findmaxxing/shared/events";
import type { PlaceTip, TipEvidence, TipInput, TipStatus } from "@/lib/places/tips";
import type { OccasionInput, OccasionNote } from "@/lib/places/occasions";
import type { SaveDetails, SaveDetailsInput } from "@/lib/places/saves";
import type { BulkOp, LibraryItem, SaveSnapshot } from "@/lib/places/library";
import type { PersonalPhoto, PersonalPhotoDelivery, PublicPhotoCredit } from "@/lib/places/personalPhotos";

/**
 * The single data-access contract used by pages and server actions.
 * Two implementations exist:
 *   - SupabaseRepository (src/lib/data/supabase) — real Postgres + RLS
 *   - DemoRepository (src/lib/data/demo)         — file-backed local store
 *
 * Authorization is enforced inside implementations (RLS in Supabase, explicit
 * ownership checks in demo) and never trusted from the client.
 */
export type StripeEventClaim = { state: "claimed"; token: string } | { state: "complete"; outcome: string } | { state: "busy" };
export interface StripePlanSnapshot {
  userId: string;
  status: Entitlement["status"];
  periodEnd: string | null;
  subscriptionId: string;
  customerId?: string;
}

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
    /**
     * The next "which did you prefer" question after the viewer rated placeId:
     * a place they gave the same stars in the same category, chosen by binary
     * search over the answers so far. Null when there is nothing left to ask.
     */
    nextComparison(userId: string, placeId: string): Promise<ComparisonPrompt | null>;
    /** Records that the viewer preferred winnerId to loserId (both rated by them, one category). Answering a pair again replaces the earlier answer. */
    compare(userId: string, winnerId: string, loserId: string): Promise<void>;
  };
  /**
   * Local tips with provenance (roadmap 2.6, 0060_place_tips.sql). A tip follows
   * its place's visibility and its own status; hidden or removed tips (and their
   * confirmations and corrections) are seen only by their author and moderators.
   */
  tips: {
    /** Current tips (published, not expired) the viewer can see, most recently confirmed first. */
    list(placeId: string, viewerId?: string | null, now?: number): Promise<PlaceTip[]>;
    /** The tip, every confirmation and every correction; null when the viewer may not see the tip. */
    evidence(tipId: string, viewerId?: string | null): Promise<TipEvidence | null>;
    add(userId: string, placeId: string, input: TipInput): Promise<PlaceTip>;
    /** Author only. Never counts as a confirmation. */
    edit(userId: string, tipId: string, input: TipInput): Promise<PlaceTip>;
    /** "Still true?" by anyone but the author (forbidden for the author). Rate-limited. */
    confirm(userId: string, tipId: string): Promise<void>;
    suggestCorrection(userId: string, tipId: string, body: string): Promise<void>;
    /** Moderators only. */
    setStatus(moderatorId: string, tipId: string, status: TipStatus): Promise<void>;
  };
  /**
   * Best for / less suited for (roadmap 2.7, 0061_place_occasions.sql): attributed
   * occasion notes, one per author, place, occasion and side. Follows place visibility;
   * hidden notes are seen only by their author and moderators.
   */
  occasions: {
    /** Published notes on a place the viewer can see, newest first. */
    list(placeId: string, viewerId?: string | null): Promise<OccasionNote[]>;
    /** Adds, or updates the note text of, the author's note for that occasion and side. */
    add(userId: string, placeId: string, input: OccasionInput): Promise<OccasionNote>;
    /** Author only. */
    remove(userId: string, noteId: string): Promise<void>;
    /** Moderators only. */
    setStatus(moderatorId: string, noteId: string, status: OccasionNote["status"]): Promise<void>;
  };
  /**
   * Why the owner saved a place (roadmap 3.1, 0062_save_details.sql): private note,
   * personal tags, source URL, who recommended it, want-to-go / visited. Owner-only:
   * every method reads and writes the caller's own saves and nobody else's.
   */
  saves: {
    /** The owner's save of the place with its details; null when not saved. */
    get(ownerId: string, placeId: string): Promise<SaveDetails | null>;
    /** Updates only the fields given; not_found when the place is not saved. */
    update(ownerId: string, placeId: string, input: SaveDetailsInput): Promise<SaveDetails>;
    /** The owner's personal tags with how many saves carry each, most used first. */
    tags(ownerId: string): Promise<{ tag: string; count: number }[]>;
    /**
     * Every save the owner can still open (3.2), newest first, each as the place
     * (community) plus the owner's details and list ids. Callers filter and page with
     * src/lib/places/library.ts, so both repositories agree.
     */
    library(ownerId: string): Promise<LibraryItem[]>;
    /** Applies one action to the owner's saves among placeIds; returns their prior state for undo. */
    bulk(ownerId: string, placeIds: string[], op: BulkOp): Promise<SaveSnapshot[]>;
    /** Puts saves back as snapshots describe (undo). Only ever the owner's own saves and lists. */
    restore(ownerId: string, snapshots: SaveSnapshot[]): Promise<void>;
  };
  /**
   * Personal photos (roadmap 2.8, 0063_personal_photos.sql): one per user and place,
   * owner-only in every method; there is no way to read someone else's.
   */
  personalPhotos: {
    get(ownerId: string, placeId: string): Promise<PersonalPhoto | null>;
    /** Stores (or replaces) the owner's photo for a place they can see. The image has been through the pipeline. */
    upload(ownerId: string, placeId: string, image: ImageUpload): Promise<PersonalPhoto>;
    remove(ownerId: string, placeId: string): Promise<void>;
    /** The owner's own photo: a short-lived signed URL (Supabase) or bytes (demo); null otherwise. */
    deliver(ownerId: string, placeId: string): Promise<PersonalPhotoDelivery | null>;
  };
  /** The team-chosen public photo of a place, with credit (roadmap 2.8). */
  publicPhotos: {
    get(placeId: string, viewerId?: string | null): Promise<PublicPhotoCredit | null>;
    /** Moderators and admins only; the photo must be one of the place's photos. It becomes the first photo. */
    set(moderatorId: string, placeId: string, photoId: string, permissionNote: string): Promise<void>;
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
    /** 4.4: going when a seat is free (or the viewer holds a live offer), else waitlisted. Free events only wait. */
    join(userId: string, eventId: string): Promise<JoinOutcome>;
    /** 4.4: leaving frees the seat, which is offered to the next person waiting. */
    leave(userId: string, eventId: string): Promise<void>;
    listByCreator(userId: string, viewerId?: string | null): Promise<Event[]>;
    listJoined(userId: string, viewerId?: string | null): Promise<Event[]>;
    listForPlace(placeId: string): Promise<Event[]>;
    /** 4.4: interested on/off; never touches going, the waitlist or seats. */
    setInterest(userId: string, eventId: string, on: boolean): Promise<ViewerParticipation | "none">;
    /** 4.4: converts the viewer's live offer to going; past its expiry, "offer_expired". */
    acceptOffer(userId: string, eventId: string): Promise<"going" | "offer_expired">;
    declineOffer(userId: string, eventId: string): Promise<void>;
    /** 4.4: the creator removes someone going, waitlisted or offered. */
    hostRemoveParticipant(hostId: string, eventId: string, userId: string): Promise<void>;
    /** 4.4: the waitlist with names, for the event's creator only (empty for anyone else). */
    participants(hostId: string, eventId: string): Promise<HostParticipant[]>;
    /** 4.4 service (cron): offers past expiry are declined and passed on; returns how many. */
    expireOffers(now: string): Promise<number>;
    /** 4.3: the creator confirms the session is happening (before its deadline). */
    confirmSession(userId: string, eventId: string): Promise<void>;
    /** 4.3 service (cron): sessions past their deadline below minimum become not happening; returns how many. */
    decideSessions(now: string): Promise<number>;
  };
  /**
   * 4.5a recurring series (0055). Occurrences are ordinary events (series_id set). Host tools re-check
   * hosting on every call; following never RSVPs.
   */
  series: {
    /** Creates the series, the owner host row, and the first 4 weeks of occurrences. */
    create(input: NewSeriesInput, ownerId: string): Promise<{ seriesId: string; firstEventId: string | null }>;
    get(seriesId: string, viewerId?: string | null): Promise<EventSeries | null>;
    /** Occurrences the viewer can see, soonest first (past ones too, newest last). */
    occurrences(seriesId: string, viewerId?: string | null): Promise<Event[]>;
    /** Edit this occurrence only (any host); records overridden template fields. */
    updateOccurrence(hostId: string, eventId: string, input: UpdateEventInput): Promise<void>;
    /** Edit this and future occurrences (any host). Returns how many occurrences were updated. */
    updateFrom(hostId: string, eventId: string, input: SeriesUpdateInput): Promise<number>;
    cancelOccurrence(hostId: string, eventId: string): Promise<void>;
    /** Ends the series; future occurrences after endsOn are cancelled. Returns how many. */
    end(hostId: string, seriesId: string, endsOn: string): Promise<number>;
    /** The owner adds or removes a backup host. */
    setHost(ownerId: string, seriesId: string, userId: string, on: boolean): Promise<void>;
    follow(userId: string, seriesId: string, on: boolean): Promise<void>;
    /** After the occurrence ends, a host records whether someone came. */
    setAttended(hostId: string, eventId: string, userId: string, attended: boolean): Promise<void>;
    /** Attendance as recorded, for hosts of the occurrence (null = not recorded). */
    attendance(hostId: string, eventId: string): Promise<{ userId: string; attended: boolean | null }[]>;
    /** Service (cron): materializes occurrences within the horizon. Idempotent. */
    generate(now: string): Promise<number>;
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
    /** Private self status; viewerId must come from the authenticated session. */
    isSuspended(userId: string, viewerId: string | null): Promise<boolean>;
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
  /**
   * "For you": rule-based, explained recommendations for the signed-in
   * viewer, computed under the same visibility rules as everything else (see
   * 0018_recommendations.sql). Strongest first; empty for nobody signed in.
   */
  recommendations: {
    places(viewerId: string, opts?: RecommendOptions): Promise<Recommendation<Place>[]>;
    /** `now` pins the clock (tests); defaults to the current time. */
    events(viewerId: string, opts?: RecommendOptions & { now?: string }): Promise<Recommendation<Event>[]>;
  };
  /**
   * The private per-user interaction log (0031_user_interactions.sql): what a
   * future personalized recommender trains on. Only the person's own rows are
   * ever written or read here; nobody else's, admins included.
   */
  interactions: {
    /**
     * Appends rows for the user (at most MAX_INTERACTION_BATCH; one rate-limit
     * tick per call). Refused as forbidden when an item is not visible to the
     * user, when the action is not one of CLIENT_INTERACTION_ACTIONS (saves,
     * ratings and attendance are logged by the store itself when they happen),
     * or (except "hide") when they opted out of analytics. A repeated
     * impression for the same requestId is dropped.
     */
    log(userId: string, rows: InteractionInput[]): Promise<void>;
    /** The user's own history, newest first. */
    list(userId: string, opts?: { limit?: number }): Promise<UserInteraction[]>;
    /** Undoes Not interested: deletes the user's hide rows for the item. */
    unhide(userId: string, item: { itemType: "place" | "event"; itemId: string }): Promise<void>;
    /** Deletes the user's whole history; returns how many rows went. */
    clear(userId: string): Promise<number>;
  };
  /**
   * Direct messages and event group chats (0020_messaging.sql). Only members
   * read a conversation. A direct conversation can be started only with
   * someone who follows the viewer back or is going to an event they are both
   * going to, never across a block; group chats follow event attendance.
   */
  messaging: {
    /** The viewer's conversations, latest activity first, with unread counts. */
    conversations(userId: string): Promise<ConversationSummary[]>;
    unreadTotal(userId: string): Promise<number>;
    /** The anti-spam rule, for the viewer and someone else. */
    canMessage(userId: string, otherId: string): Promise<boolean>;
    /** Opens (or finds) the direct conversation; refused as forbidden when the rule does not allow it. */
    startDirect(userId: string, otherId: string): Promise<string>;
    /** The id of an event's group chat, when the viewer is in it. */
    eventConversation(userId: string, eventId: string): Promise<string | null>;
    /** Header, members and read receipts, for members only (null for anyone else). */
    get(userId: string, conversationId: string): Promise<ConversationDetail | null>;
    /** Newest first, in cursor pages; empty for non-members. */
    messages(userId: string, conversationId: string, opts?: PageRequest): Promise<Page<Message>>;
    send(userId: string, conversationId: string, body: string): Promise<Message>;
    markRead(userId: string, conversationId: string): Promise<void>;
    block(userId: string, otherId: string): Promise<void>;
    unblock(userId: string, otherId: string): Promise<void>;
    /** People the viewer blocked. */
    blocked(userId: string): Promise<ProfileSummary[]>;
  };
  /**
   * Notifications (0021_notifications.sql). Rows are written by database
   * triggers (or, in demo mode, the repository) when someone acts; people
   * only read, mark read and configure their own. The last four methods are
   * service-level, for the cron route: in Supabase mode they need a
   * repository built on the service-role client.
   */
  notifications: {
    /** Most recently updated first, in cursor pages. */
    list(userId: string, opts?: PageRequest): Promise<Page<AppNotification>>;
    unreadCount(userId: string): Promise<number>;
    /** Marks the given notifications (or all) read; returns how many changed. */
    markRead(userId: string, ids?: string[] | null): Promise<number>;
    settings(userId: string): Promise<NotificationSettings>;
    updateSettings(userId: string, settings: NotificationSettings): Promise<void>;
    /** A device opting in to push (an endpoint moves to its latest user; at most 10 each). */
    addDevice(userId: string, device: PushDevice): Promise<void>;
    removeDevice(userId: string, endpoint: string): Promise<void>;
    deviceCount(userId: string): Promise<number>;
    tripPlanReady(userId: string, title: string): Promise<void>;
    /** Service: event reminders due at `now`; returns how many were created. Idempotent. */
    scheduleReminders(now: string): Promise<number>;
    /** Service: claims only ready transports, once per kind; unsendable kinds stay pending. */
    claimPushes(now: string, limit?: number, kinds?: ("web" | "expo")[]): Promise<PushClaim[]>;
    /** Service: forgets a device the push service says is gone. */
    dropDevice(endpoint: string): Promise<void>;
    /** Service: retention. */
    purge(now: string): Promise<number>;
  };
  /**
   * Paid tickets and the Plus subscription (0022_payments.sql). Money records
   * are owner-only; buyers and hosts act through the first group of methods.
   * The "service" methods are called by Stripe webhooks, checkout and the
   * cron: in Supabase mode they need a repository on the service-role client.
   * In demo mode a labeled fake checkout calls them and no money moves.
   */
  payments: {
    /** Closing/missing accounts must not create or restore billing state. */
    isClosing(userId: string): Promise<boolean>;
    isPlus(userId: string): Promise<boolean>;
    entitlement(userId: string): Promise<Entitlement | null>;
    /** Whether the host can take payments (a Stripe account with charges enabled). Always true in demo mode. */
    canSell(userId: string): Promise<boolean>;
    /** Owner only, before anyone else is going; null makes the event free. */
    setEventPrice(ownerId: string, eventId: string, cents: number | null): Promise<void>;
    /** Holds a spot for 30 minutes (reusing an existing hold). Pending holds count against capacity. */
    reserveTicket(userId: string, eventId: string): Promise<TicketReservation>;
    myTickets(userId: string): Promise<Ticket[]>;
    /** The host's sales on their own event; null for anyone else. */
    ticketSummary(ownerId: string, eventId: string): Promise<TicketSummary | null>;
    /** Service: the Stripe customer for a user, if one was made. */
    customerOf(userId: string): Promise<string | null>;
    hostAccountOf(userId: string): Promise<string | null>;
    attachCheckout(ticketId: string, sessionId: string): Promise<void>;
    /** Service: checkout completed. Idempotent. */
    confirmTicket(sessionId: string, paymentIntentId: string, amountCents: number): Promise<"confirmed" | "duplicate" | "refund" | "unknown">;
    expireCheckout(sessionId: string): Promise<void>;
    ticketsToRefund(): Promise<{ ticketId: string; paymentIntentId: string }[]>;
    markRefunded(paymentIntentId: string): Promise<void>;
    setEntitlement(userId: string, status: Entitlement["status"], periodEnd: string | null, subscriptionId: string | null): Promise<void>;
    linkCustomer(userId: string, customerId: string): Promise<void>;
    setHostAccount(userId: string, accountId: string, chargesEnabled: boolean): Promise<void>;
    /** Service: true the first time a Stripe event id is seen. */
    recordStripeEvent(id: string, type: string, objectId: string | null): Promise<boolean>;
    /** Service: fenced event lease; subscription events serialize by user before remote reads. */
    claimStripeEvent(id: string, type: string, objectId: string | null, userId: string | null): Promise<StripeEventClaim>;
    /** Service: atomically apply a reconciled plan and complete its event, or release failed work. */
    finishStripeEvent(id: string, token: string, outcome: string, plan?: StripePlanSnapshot): Promise<void>;
    releaseStripeEvent(id: string, token: string): Promise<void>;
  };
  /**
   * Sponsored cards (0023_ads.sql): local, labeled, contextual, never
   * personal, never part of the organic results. Advertisers promote their
   * own public place or upcoming event; admins review; payment activates.
   */
  ads: {
    create(advertiserId: string, input: NewCampaignInput): Promise<string>;
    /** The advertiser's campaigns, newest first, with delivery. */
    mine(advertiserId: string): Promise<AdCampaign[]>;
    setPaused(advertiserId: string, campaignId: string, paused: boolean): Promise<void>;
    /** Admins only: campaigns waiting for review, oldest first (empty for anyone else). */
    reviewQueue(viewerId: string): Promise<AdCampaign[]>;
    review(adminId: string, campaignId: string, approve: boolean, note: string | null): Promise<void>;
    /** Service: the campaign for a checkout, the payment that activates it, serving, expiry. */
    attachCheckout(campaignId: string, sessionId: string): Promise<void>;
    activate(sessionId: string, amountCents: number): Promise<"active" | "duplicate" | "mismatch" | "unknown">;
    serve(slot: "places" | "events", context: { bounds: GeoBounds | null; categorySlug: string | null }, now?: string): Promise<SponsoredCard | null>;
    endFinished(now?: string): Promise<number>;
  };
  /** Limits on actions that write no row of their own (an AI plan). */
  limits: {
    /** Counts one use against the user's limit, or throws rate_limited. */
    consume(userId: string, action: "trip_plans"): Promise<void>;
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
