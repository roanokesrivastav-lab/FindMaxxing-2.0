/**
 * Domain types shared by the UI, server actions and both repository
 * implementations (Supabase + demo). All dates are ISO-8601 strings.
 */

export type PlaceStatus = "published" | "pending" | "hidden" | "removed";
export type EventStatus = "published" | "cancelled" | "hidden" | "removed";
/**
 * Trust tiers for a place.
 *   public  — anyone, signed in or not
 *   locals    — only people who count as a local of the place's city
 *   trusted   — locals of the city whose reputation level is "trusted"
 *   followers — people the creator follows back (mutual follows)
 *   private   — only the creator
 * "Who is a local" is defined once in SQL (public.is_local) and mirrored by the
 * demo store: an account at least LOCAL_MIN_ACCOUNT_AGE_DAYS old, whose local
 * status a moderator has not revoked, whose home city matches or who has
 * contributed a published place there.
 */
export type Visibility = "public" | "locals" | "trusted" | "followers" | "private";

/**
 * Contributor reputation as people see it (never a raw score). Computed in SQL
 * (0016_reputation.sql) and cached; see the README for how levels are earned.
 */
export type ReputationLevel = "new" | "contributor" | "trusted";

/** Statuses an owner may set. `pending` and `removed` are reserved for moderation. */
export const OWNER_SETTABLE_PLACE_STATUSES = ["published", "hidden"] as const;
export type OwnerPlaceStatus = (typeof OWNER_SETTABLE_PLACE_STATUSES)[number];

/** A new account counts as a local only after this many days. */
export const LOCAL_MIN_ACCOUNT_AGE_DAYS = 7;
/** Home city can change at most once per this many days. */
export const HOME_CITY_COOLDOWN_DAYS = 30;

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
  /** When the home city last changed; it can change again 30 days later. */
  homeCityChangedAt: string | null;
  /** When first-run onboarding was finished or skipped; null shows /welcome. */
  onboardedAt: string | null;
  reputationLevel: ReputationLevel;
  interests: string[];
  createdAt: string;
  updatedAt: string;
  /** A Plus subscriber (the supporter badge). */
  supporter?: boolean;
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
  /** Ticket price in cents (USD); null or absent for a free event. */
  priceCents?: number | null;
}

export interface EventDetail extends Event {
  viewerJoined: boolean;
  attendees: ProfileSummary[];
}

export type ReportTargetType = "place" | "event" | "profile" | "message";
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

/** Processed image bytes, ready to store. Produced by src/lib/images/pipeline.ts. */
export interface ImageUpload {
  /** Stored at the returned storage path (the lg size for place photos). */
  main: Uint8Array<ArrayBuffer>;
  /** Smaller place-photo sizes, stored next to it (see photoVariantPath). */
  variants?: Partial<Record<"sm" | "md", Uint8Array<ArrayBuffer>>>;
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
  status: ReportStatus;
  createdAt: string;
  /** When a moderator resolved it. Who resolved it is never exposed. */
  resolvedAt: string | null;
  /** Resolved label for the reported place/event, when it still exists. */
  targetLabel: string | null;
}

export type ReportStatus = "open" | "reviewed" | "dismissed";

export interface NewReportInput {
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details?: string | null;
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
  /**
   * A neighborhood name, matched ignoring case and spacing. Events match
   * through their linked place.
   */
  neighborhood?: string | null;
  /** ISO timestamp: only records created at or after it. */
  createdAfter?: string | null;
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
  /**
   * Order by distance from this point instead of newest first (distance, then
   * id). Bounds still prefilter when given. Cursors from one order do not work
   * in the other.
   */
  near?: { lat: number; lng: number } | null;
}

export interface EventSearchOptions extends DiscoveryFilters, PageRequest {
  viewerId?: string | null;
  includePast?: boolean;
  /** ISO timestamp: only events starting before it (Today, This week). */
  startsBefore?: string | null;
}

/** The same filters a list takes, without paging. */
export type PlaceCountOptions = DiscoveryFilters & { viewerId?: string | null };
export type EventCountOptions = DiscoveryFilters & { viewerId?: string | null; includePast?: boolean; startsBefore?: string | null };

/** One neighborhood over the places the viewer can see. */
export interface NeighborhoodSummary {
  /** Comparison key (see neighborhoodKey); the same for every spelling. */
  key: string;
  /** Display name: the alphabetically first spelling, trimmed. */
  name: string;
  city: string;
  placeCount: number;
  /** Category slugs by frequency, most common first. */
  topCategories: string[];
  /** Mean position of its places. */
  lat: number;
  lng: number;
}

export type TagCounts = Record<string, { places: number; events: number }>;

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

/**
 * One of a user's own saved lists. `placeCount` counts the places in it the
 * owner can open (published and visible), like the Saved page.
 */
export interface SavedList {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  placeCount: number;
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

// ----------------------------------------------------------------------------
// Moderation
// ----------------------------------------------------------------------------

/**
 * dismiss and review resolve the open reports and leave the content alone;
 * remove takes content down (a reason is required and shown to its owner);
 * restore publishes removed content again.
 */
export type ModerationAction = "dismiss" | "review" | "remove" | "restore";
export type ModerationLogAction =
  | ModerationAction
  | "revoke_local"
  | "restore_local"
  | "reset_reputation"
  | "suspend"
  | "unsuspend"
  | "grant_moderator"
  | "revoke_moderator"
  | "taxonomy_upsert"
  | "taxonomy_retire"
  | "taxonomy_restore"
  | "approve_ad"
  | "reject_ad";

/** One target in the queue: its open reports, grouped. */
export interface ModerationQueueItem {
  targetType: ReportTargetType;
  targetId: string;
  reportCount: number;
  firstReportedAt: string;
  lastReportedAt: string;
  reasons: ReportReason[];
  /** Null when the target no longer exists. */
  targetLabel: string | null;
  /** Content status, or "active"/"revoked" (local status) for profiles. */
  targetStatus: string | null;
}

/** A report as a moderator sees it: with who filed it. */
export interface ModerationReport {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  reporter: ProfileSummary | null;
}

export interface ModerationLogEntry {
  id: string;
  action: ModerationLogAction;
  reason: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  resolvedReports: number;
  createdAt: string;
  moderator: ProfileSummary | null;
}

/** The target as it is now, whoever may otherwise see it. */
export interface ModerationSnapshot {
  label: string;
  status: string;
  visibility: string | null;
  city: string | null;
  neighborhood: string | null;
  body: string | null;
  /** Local tip for places, location for events. */
  extra: string | null;
  ownerId: string | null;
  ownerUsername: string | null;
  createdAt: string;
}

export interface ModerationTargetDetail {
  targetType: ReportTargetType;
  targetId: string;
  /** Null when the target has been deleted since it was reported. */
  snapshot: ModerationSnapshot | null;
  /** Every report on the target, open first, then newest first. */
  reports: ModerationReport[];
  /** Every moderation action on the target, newest first. */
  history: ModerationLogEntry[];
}

/** One of the viewer's own places or events that moderators removed. */
export interface RemovedContent {
  targetType: "place" | "event";
  targetId: string;
  label: string;
  reason: string | null;
  removedAt: string | null;
}

// ----------------------------------------------------------------------------
// Analytics (admins only)
// ----------------------------------------------------------------------------
export const ANALYTICS_EVENTS = [
  "view_place", "save_place", "add_to_list", "contribute_place", "create_event",
  "join_event", "follow", "rate_place", "search_no_results", "onboarding_step",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];
/** The core loop, in order, as the funnel shows it. */
export const FUNNEL_STEPS = ["view_place", "save_place", "add_to_list", "contribute_place", "create_event", "join_event", "follow"] as const;

export interface FunnelStep {
  step: (typeof FUNNEL_STEPS)[number];
  actors: number;
  events: number;
}

export interface SaveSources {
  community: number;
  seed: number;
}

// ----------------------------------------------------------------------------
// Admin dashboard
// ----------------------------------------------------------------------------
export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  homeCity: string | null;
  createdAt: string;
  reputationLevel: ReputationLevel;
  isModerator: boolean;
  isAdmin: boolean;
  suspended: boolean;
  places: number;
  events: number;
  reportsAgainst: number;
}

export interface AdminContentItem {
  kind: "place" | "event";
  id: string;
  label: string;
  status: string;
  visibility: string | null;
  city: string | null;
  creatorId: string | null;
  creatorUsername: string | null;
  createdAt: string;
  openReports: number;
  actions: number;
}

export interface RateLimitHit {
  action: string;
  usersAtLimit: number;
  maxCount: number;
  windowSeconds: number;
}

export interface TaxonomyEntry {
  kind: "category" | "interest";
  slug: string;
  label: string;
  emoji: string;
  sortOrder: number;
  retired: boolean;
  /** Categories only. */
  color?: string;
  scope?: "place" | "event" | "both";
}

export interface AdminHistoryEntry {
  id: string;
  action: ModerationLogAction;
  reason: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  createdAt: string;
  moderatorUsername: string | null;
}

// ----------------------------------------------------------------------------
// Recommendations ("For you")
// ----------------------------------------------------------------------------
export interface RecommendationReason {
  /** Which signal explains it: followed_added, liked_similar, interest, saved_place, … */
  kind: string;
  /** Shown under the card: "Because you saved Meeple Cellar". */
  text: string;
  /** What the reason points at (a place id, a username, an interest slug), when it points at something. */
  ref: string | null;
}

export interface Recommendation<T> {
  item: T;
  score: number;
  reason: RecommendationReason;
}

export interface RecommendOptions {
  near?: { lat: number; lng: number } | null;
  /** Clamped to [1, 50]; defaults to 12. */
  limit?: number;
}

/** The private per-user interaction log (0031_user_interactions.sql). */
export const INTERACTION_ACTIONS = ["impression", "view", "save", "unsave", "rate", "directions", "share", "join", "leave", "hide"] as const;
export type InteractionAction = (typeof INTERACTION_ACTIONS)[number];
export const INTERACTION_SURFACES = ["for_you", "list", "map", "search", "detail", "saved", "profile"] as const;
export type InteractionSurface = (typeof INTERACTION_SURFACES)[number];
/** Most rows one log call (one insert statement) may carry. */
export const MAX_INTERACTION_BATCH = 100;

export interface InteractionInput {
  itemType: "place" | "event";
  itemId: string;
  action: InteractionAction;
  surface?: InteractionSurface | null;
  /** Zero-based position in the list the item was shown in. */
  position?: number | null;
  /** The score, for "rate" only (1–5). */
  value?: number | null;
}

export interface UserInteraction extends Required<InteractionInput> {
  id: number;
  createdAt: string;
}

/** Thrown by repositories for expected, user-facing failures. */
// ----------------------------------------------------------------------------
// Messaging
// ----------------------------------------------------------------------------
export interface ConversationSummary {
  id: string;
  kind: "direct" | "group";
  /** Group chats belong to one event. */
  eventId: string | null;
  eventTitle: string | null;
  /** The other person in a direct conversation (null once their account is gone). */
  other: ProfileSummary | null;
  lastMessageAt: string | null;
  lastBody: string | null;
  lastSenderId: string | null;
  /** Messages from others since the viewer last read the conversation. */
  unread: number;
}

export interface ConversationMember {
  profile: ProfileSummary;
  lastReadAt: string | null;
}

export interface ConversationDetail extends ConversationSummary {
  /** Members the viewer can see (people who blocked the viewer are left out). */
  members: ConversationMember[];
  /** Whether the viewer can still post (directs across a block, and chats of events no longer on, are closed). */
  canSend: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: ProfileSummary | null;
  senderId: string;
  body: string;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Notifications
// ----------------------------------------------------------------------------
export type NotificationType =
  | "new_follower"
  | "event_joined"
  | "event_tomorrow"
  | "event_soon"
  | "event_changed"
  | "event_cancelled"
  | "new_message"
  | "place_saved"
  | "place_rated"
  | "report_resolved"
  | "content_moderated"
  | "trip_plan_ready";

export interface AppNotification {
  id: string;
  type: NotificationType;
  /** Who did it; null for saves (private), scheduled reminders and moderation. */
  actor: ProfileSummary | null;
  subjectType: "profile" | "event" | "place" | "conversation" | "report" | "message" | "plan" | null;
  subjectId: string | null;
  label: string | null;
  detail: string | null;
  /** How many events this one stands for (batched). */
  count: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
}

export interface NotificationSettings {
  mutedTypes: NotificationType[];
  pushTypes: NotificationType[];
  /** Local hours (0-23); pushes wait while quiet. Both null when off. */
  quietStart: number | null;
  quietEnd: number | null;
  timeZone: string;
}

/**
 * A device that opted in to push: a browser (web push: endpoint and keys) or
 * the mobile app (an Expo push token as the endpoint, no keys).
 */
export interface PushDevice {
  kind?: "web" | "expo";
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

/** Expo push tokens, as the mobile app gets them from expo-notifications. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;

/** A push the scheduler claimed: already marked sent, with the devices to send it to. */
export interface PushClaim {
  notificationId: string;
  userId: string;
  type: NotificationType;
  actorUsername: string | null;
  subjectType: AppNotification["subjectType"];
  subjectId: string | null;
  label: string | null;
  detail: string | null;
  count: number;
  devices: PushDevice[];
}

// ----------------------------------------------------------------------------
// Payments
// ----------------------------------------------------------------------------
export type TicketStatus = "pending" | "paid" | "expired" | "refund_pending" | "refunded";

export interface Ticket {
  id: string;
  eventId: string | null;
  eventTitle: string | null;
  eventStartsAt: string | null;
  status: TicketStatus;
  amountCents: number;
  currency: string;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
}

/** A 30-minute hold on a spot, to be paid through checkout. */
export interface TicketReservation {
  ticketId: string;
  amountCents: number;
  currency: string;
  expiresAt: string;
  eventTitle: string;
  /** The host's Stripe account (payouts); null in demo mode. */
  hostAccount: string | null;
}

export type EntitlementStatus = "active" | "trialing" | "past_due" | "canceled" | "incomplete" | "incomplete_expired" | "unpaid" | "paused";

export interface Entitlement {
  plan: "plus";
  status: EntitlementStatus;
  currentPeriodEnd: string | null;
  /** Whether the perks apply now. */
  active: boolean;
}

export interface TicketSummary {
  paid: number;
  pending: number;
  refunded: number;
  revenueCents: number;
}

// ----------------------------------------------------------------------------
// Sponsored cards
// ----------------------------------------------------------------------------
export type CampaignStatus = "pending_review" | "rejected" | "awaiting_payment" | "active" | "paused" | "ended";

export interface NewCampaignInput {
  kind: "place" | "event";
  targetId: string;
  headline: string;
  body: string | null;
  /** Contextual targeting only. */
  bounds: GeoBounds | null;
  categorySlug: string | null;
  startsAt: string;
  endsAt: string;
  budgetCents: number;
}

export interface AdCampaign {
  id: string;
  advertiserId: string;
  kind: "place" | "event";
  targetId: string;
  targetLabel: string | null;
  headline: string;
  body: string | null;
  bounds: GeoBounds | null;
  categorySlug: string | null;
  startsAt: string;
  endsAt: string;
  budgetCents: number;
  status: CampaignStatus;
  reviewNote: string | null;
  createdAt: string;
  /** Impressions so far, and how many the budget buys. */
  delivered: number;
  impressionBudget: number;
}

/** A served card: always shown labeled "Sponsored". */
export interface SponsoredCard {
  campaignId: string;
  kind: "place" | "event";
  targetId: string;
  headline: string;
  body: string | null;
}

export class DataError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "full"
      | "invalid"
      | "unavailable"
      | "rate_limited" = "invalid",
  ) {
    super(message);
    this.name = "DataError";
  }
}
