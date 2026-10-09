import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import {
  DataError,
  MAX_PLACE_PHOTOS,
  type Event,
  type EventDetail,
  type NeighborhoodSummary,
  type Place,
  type PlaceDetail,
  type Profile,
  type ProfileStats,
  type ProfileSummary,
  type PlaceRating,
  type ReportEntry,
  type SavedList,
  type ConnectionEntry,
  type EventMapRecord,
  type PlaceMapRecord,
  type ModerationLogEntry,
  type ModerationQueueItem,
  type ModerationReport,
  type ModerationSnapshot,
  type RemovedContent,
  type FunnelStep,
  type AdminHistoryEntry,
  type AdminUser,
  type ConversationMember,
  type ConversationSummary,
  type Message,
  type AppNotification,
  type NotificationSettings,
  type PushClaim,
  type Ticket,
  type Entitlement,
  type AdCampaign,
} from "../types";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@/lib/notifications";
import { parsePaymentsMessage } from "../payments";
import { impressionBudget, parseAdsMessage, validateCampaign } from "../ads";
import { MESSAGE_PAGE_SIZE, messagingError, normalizeMessageBody, parseMessagingMessage } from "../messaging";
import { parseRateLimitMessage } from "@/lib/rateLimits";
import { compareModerationReports, parseModerationMessage } from "../moderation";
import { homeCityCooldownMessage, nextHomeCityChange, sameCity } from "../localTier";
import { LIST_LIMIT_ERROR, duplicateListName, normalizeListName } from "../savedLists";
import {
  DEFAULT_MAP_MARKERS,
  DEFAULT_PAGE_SIZE,
  MAX_MAP_MARKERS,
  MAX_PAGE_SIZE,
  UPCOMING_GRACE_MS,
  clampLimit,
  decodeCursor,
  decodeDistanceCursor,
  encodeDistanceCursor,
  normalizeFilters,
  validateNear,
  normalizeTimestamp,
  toPage,
  type NormalizedFilters,
} from "../discovery";
import { PLACE_PHOTO_BUCKET, placePhotoReference, placePhotoUrl, sniffImageType } from "../photos";
import { photoObjectPaths, photoVariantPath } from "@/lib/images/sizes";

/**
 * Supabase implementation. Every query runs through the request-scoped client
 * (anon key + user session) so Row Level Security is the authorization layer.
 *
 * Rows are mapped from snake_case DB shapes into the domain types via the
 * explicit mappers below; the client is intentionally untyped and results are
 * narrowed at the boundary.
 */

interface ProfileSummaryRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}
interface ProfileRow extends ProfileSummaryRow {
  bio: string | null;
  home_city: string | null;
  home_city_changed_at?: string | null;
  onboarded_at?: string | null;
  reputation_level?: Profile["reputationLevel"];
  supporter?: boolean;
  created_at: string;
  updated_at: string;
  profile_interests?: { interest_slug: string }[];
}
interface PlaceRow {
  id: string;
  name: string;
  description: string;
  local_tip: string | null;
  category_slug: string;
  lat: number;
  lng: number;
  address: string | null;
  neighborhood: string | null;
  city: string;
  creator_id: string | null;
  rating_avg: number | string;
  rating_count: number;
  save_count?: number;
  status: Place["status"];
  visibility: Place["visibility"];
  created_at: string;
  updated_at: string;
  creator?: ProfileSummaryRow | null;
  place_tags?: { interest_slug: string }[];
  place_photos?: { id: string; url: string; storage_path: string | null; uploader_id: string | null; sort_order: number }[];
}
interface EventRow {
  id: string;
  title: string;
  description: string;
  place_id: string | null;
  location_name: string;
  address: string | null;
  lat: number;
  lng: number;
  starts_at: string;
  ends_at: string | null;
  creator_id: string | null;
  category_slug: string;
  capacity: number | null;
  price_cents?: number | null;
  status: Event["status"];
  created_at: string;
  creator?: ProfileSummaryRow | null;
  place?: { name: string } | null;
  event_tags?: { interest_slug: string }[];
  attendee_count?: { count: number }[];
}

const PROFILE_SUMMARY = "id, username, display_name, avatar_url";
const PLACE_SELECT = `*, creator:profiles!places_creator_id_fkey(${PROFILE_SUMMARY}), place_tags(interest_slug), place_photos(id, url, storage_path, uploader_id, sort_order)`;
const EVENT_SELECT = `*, creator:profiles!events_creator_id_fkey(${PROFILE_SUMMARY}), place:places!events_place_id_fkey(name), event_tags(interest_slug), attendee_count:event_attendees(count)`;
const PROFILE_SELECT = "*, profile_interests(interest_slug)";

function mapSummary(r: ProfileSummaryRow | null | undefined): ProfileSummary | null {
  return r ? { id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null;
}
function mapProfile(r: ProfileRow): Profile {
  return {
    ...(mapSummary(r) as ProfileSummary),
    bio: r.bio,
    homeCity: r.home_city,
    homeCityChangedAt: r.home_city_changed_at ?? null,
    onboardedAt: r.onboarded_at ?? null,
    reputationLevel: r.reputation_level ?? "new",
    supporter: !!r.supporter,
    interests: (r.profile_interests ?? []).map((i) => i.interest_slug),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function mapPlace(r: PlaceRow): Place {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    localTip: r.local_tip,
    categorySlug: r.category_slug,
    lat: Number(r.lat),
    lng: Number(r.lng),
    address: r.address,
    neighborhood: r.neighborhood,
    city: r.city,
    creatorId: r.creator_id,
    creator: mapSummary(r.creator),
    ratingAvg: Number(r.rating_avg),
    ratingCount: r.rating_count,
    tags: (r.place_tags ?? []).map((t) => t.interest_slug),
    photos: [...(r.place_photos ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((p) => ({ id: p.id, url: placePhotoUrl({ id: p.id, url: p.url, storagePath: p.storage_path }), storagePath: p.storage_path, uploaderId: p.uploader_id })),
    status: r.status,
    visibility: r.visibility,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function mapEvent(r: EventRow): Event {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    placeId: r.place_id,
    placeName: r.place?.name ?? null,
    locationName: r.location_name,
    address: r.address,
    lat: Number(r.lat),
    lng: Number(r.lng),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    creatorId: r.creator_id,
    creator: mapSummary(r.creator),
    categorySlug: r.category_slug,
    capacity: r.capacity,
    attendeeCount: r.attendee_count?.[0]?.count ?? 0,
    tags: (r.event_tags ?? []).map((t) => t.interest_slug),
    status: r.status,
    createdAt: r.created_at,
    priceCents: r.price_cents ?? null,
  };
}

/** Translate Postgres errors into user-facing DataErrors. */
export function translate(error: PostgrestError): DataError {
  switch (error.code) {
    case "FM429": // check_rate_limit()
      return parseRateLimitMessage(error.message) ?? new DataError("Too many requests. Try again later.", "rate_limited");
    case "P0002": // no_data_found, raised by our functions for a missing target
      return parseModerationMessage(error.message) ?? parseMessagingMessage(error.message) ?? parsePaymentsMessage(error.message) ?? parseAdsMessage(error.message) ?? new DataError("Not found", "not_found");
    case "23505":
      return new DataError("That already exists", "conflict");
    case "23503":
      return new DataError("Related record not found", "not_found");
    case "42501":
      return parsePaymentsMessage(error.message) ?? new DataError("You don't have permission to do that", "forbidden");
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return new DataError("Invalid date or time", "invalid");
    case "P0001": { // raise exception from our triggers
      const moderation = parseModerationMessage(error.message) ?? parseMessagingMessage(error.message) ?? parsePaymentsMessage(error.message) ?? parseAdsMessage(error.message);
      if (moderation) return moderation;
      const cooldown = /home_city_cooldown:(\S+)/.exec(error.message);
      if (cooldown) return new DataError(homeCityCooldownMessage(cooldown[1]), "rate_limited");
      if (/full/i.test(error.message)) return new DataError("This event is full", "full");
      if (/ended|past/i.test(error.message)) return new DataError("This event has already ended", "invalid");
      return new DataError(error.message, "invalid");
    }
    default:
      return new DataError(error.message || "Something went wrong", "unavailable");
  }
}

interface SavedListRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  place_count: number;
}

function mapSavedList(r: SavedListRow): SavedList {
  return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, placeCount: Number(r.place_count) };
}

/** Saved-list failures in the user's terms (the generic translate() would say "That already exists"). */
function listError(error: PostgrestError, name?: string): DataError {
  if (error.code === "23505" && name) return duplicateListName(name);
  if (error.code === "P0001" && error.message.includes("at most")) {
    const cap = /at most (\d+)/.exec(error.message)?.[1];
    return new DataError(cap ? `You can have at most ${cap} lists` : LIST_LIMIT_ERROR, "full");
  }
  // add_to_saved_list: the list is not the caller's (P0002), or the place is not one they may see (RLS).
  if (error.code === "P0002") return new DataError("List not found", "not_found");
  if (error.code === "42501") return new DataError("Place not found", "not_found");
  return translate(error);
}

/** PostgREST's default max-rows. A single request never returns more, silently. */
export const SUPABASE_PAGE_ROWS = 1000;

/**
 * Every row of a query that has no natural bound (a user's bookmarks, a
 * list's places), fetched in pages of SUPABASE_PAGE_ROWS. `page` must apply a
 * total order (a unique tie-break column) so ranges neither skip nor repeat.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE_ROWS) {
    const batch = unwrap(await page(from, from + SUPABASE_PAGE_ROWS - 1)) ?? [];
    rows.push(...batch);
    if (batch.length < SUPABASE_PAGE_ROWS) return rows;
  }
}

function unwrap<T>(res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) throw translate(res.error);
  return res.data as T;
}

interface ReportViewRow {
  id: string;
  target_type: ReportEntry["targetType"];
  target_id: string;
  reason: ReportEntry["reason"];
  details: string | null;
  status: ReportEntry["status"];
  created_at: string;
  /** Only reports_i_filed has it. */
  resolved_at?: string | null;
}

/**
 * Reads one of the two anonymizing report views and resolves a display label
 * for each target. The views omit reporter_id entirely, so no caller can leak it.
 */
async function readReports(supabase: SupabaseClient, view: "reports_i_filed" | "reports_about_my_stuff"): Promise<ReportEntry[]> {
  const res = await supabase.from(view).select("*").order("created_at", { ascending: false });
  if (res.error) throw translate(res.error);
  const rows = (res.data ?? []) as ReportViewRow[];
  if (!rows.length) return [];

  const placeIds = rows.filter((r) => r.target_type === "place").map((r) => r.target_id);
  const eventIds = rows.filter((r) => r.target_type === "event").map((r) => r.target_id);
  const [placesRes, eventsRes] = await Promise.all([
    placeIds.length ? supabase.from("places").select("id, name").in("id", placeIds) : Promise.resolve({ data: [], error: null }),
    eventIds.length ? supabase.from("events").select("id, title").in("id", eventIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (placesRes.error) throw translate(placesRes.error);
  if (eventsRes.error) throw translate(eventsRes.error);
  const labels = new Map<string, string>();
  for (const p of (placesRes.data ?? []) as { id: string; name: string }[]) labels.set(p.id, p.name);
  for (const e of (eventsRes.data ?? []) as { id: string; title: string }[]) labels.set(e.id, e.title);

  return rows.map((r) => ({
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    details: r.details,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
    targetLabel: labels.get(r.target_id) ?? null,
  }));
}

const CAMPAIGN_SELECT = "*, place:places!ad_campaigns_place_id_fkey(name), event:events!ad_campaigns_event_id_fkey(title), impressions:ad_impressions(impressions)";

interface CampaignDbRow {
  id: string;
  advertiser_id: string;
  kind: "place" | "event";
  place_id: string | null;
  event_id: string | null;
  headline: string;
  body: string | null;
  north: number | null;
  south: number | null;
  east: number | null;
  west: number | null;
  category_slug: string | null;
  starts_at: string;
  ends_at: string;
  budget_cents: number;
  status: AdCampaign["status"];
  review_note: string | null;
  created_at: string;
  place: { name: string } | null;
  event: { title: string } | null;
  impressions: { impressions: number }[];
}

function mapCampaign(r: CampaignDbRow): AdCampaign {
  return {
    id: r.id, advertiserId: r.advertiser_id, kind: r.kind, targetId: (r.place_id ?? r.event_id)!,
    targetLabel: r.place?.name ?? r.event?.title ?? null, headline: r.headline, body: r.body,
    bounds: r.north === null ? null : { north: Number(r.north), south: Number(r.south), east: Number(r.east), west: Number(r.west) },
    categorySlug: r.category_slug, startsAt: r.starts_at, endsAt: r.ends_at, budgetCents: r.budget_cents, status: r.status,
    reviewNote: r.review_note, createdAt: r.created_at,
    // The embedded rows are the per-day counts; their sum is what was delivered.
    delivered: (r.impressions ?? []).reduce((n, i) => n + Number(i.impressions), 0),
    impressionBudget: impressionBudget(r.budget_cents),
  };
}

interface TicketDbRow {
  id: string;
  event_id: string | null;
  status: Ticket["status"];
  amount_cents: number;
  currency: string;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  event: { title: string; starts_at: string } | null;
}

interface NotificationRpcRow {
  id: string;
  type: AppNotification["type"];
  actor_id: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  subject_type: AppNotification["subjectType"];
  subject_id: string | null;
  label: string | null;
  detail: string | null;
  count: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
}

function mapNotification(r: NotificationRpcRow): AppNotification {
  return {
    id: r.id,
    type: r.type,
    actor: r.actor_id && r.actor_username ? { id: r.actor_id, username: r.actor_username, displayName: r.actor_display_name ?? r.actor_username, avatarUrl: r.actor_avatar_url } : null,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    label: r.label,
    detail: r.detail,
    count: Number(r.count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    readAt: r.read_at,
  };
}

interface SettingsRow {
  muted_types: NotificationSettings["mutedTypes"];
  push_types: NotificationSettings["pushTypes"];
  quiet_start: number | null;
  quiet_end: number | null;
  time_zone: string;
}

interface PushClaimRow {
  notification_id: string;
  user_id: string;
  type: PushClaim["type"];
  actor_username: string | null;
  subject_type: PushClaim["subjectType"];
  subject_id: string | null;
  label: string | null;
  detail: string | null;
  count: number;
  devices: PushClaim["devices"];
}

interface ConversationRpcRow {
  id: string;
  kind: "direct" | "group";
  event_id: string | null;
  event_title: string | null;
  other_id: string | null;
  other_username: string | null;
  other_display_name: string | null;
  other_avatar_url: string | null;
  last_message_at: string | null;
  last_body: string | null;
  last_sender_id: string | null;
  unread: number;
}

function mapConversation(r: ConversationRpcRow): ConversationSummary {
  return {
    id: r.id,
    kind: r.kind,
    eventId: r.event_id,
    eventTitle: r.event_title,
    other: r.other_id && r.other_username ? { id: r.other_id, username: r.other_username, displayName: r.other_display_name ?? r.other_username, avatarUrl: r.other_avatar_url } : null,
    lastMessageAt: r.last_message_at,
    lastBody: r.last_body,
    lastSenderId: r.last_sender_id,
    unread: Number(r.unread),
  };
}

/** Public profile summaries by id. */
async function profileSummaries(supabase: SupabaseClient, ids: string[]): Promise<Map<string, ProfileSummary>> {
  if (!ids.length) return new Map();
  const rows = unwrap(await supabase.from("profiles").select(PROFILE_SUMMARY).in("id", ids)) as ProfileSummaryRow[];
  return new Map(rows.map((r) => [r.id, mapSummary(r)!]));
}

/** Arguments shared by public.discover_places and public.discover_events. */
export function discoverArgs(f: NormalizedFilters) {
  return {
    p_north: f.bounds?.north ?? null,
    p_south: f.bounds?.south ?? null,
    p_east: f.bounds?.east ?? null,
    p_west: f.bounds?.west ?? null,
    p_text: f.search.text,
    p_text_categories: f.search.categories,
    p_text_tags: f.search.tags,
    p_category: f.category,
    p_tags: f.tags,
    p_neighborhood: f.neighborhood,
    p_created_after: f.createdAfter,
  };
}

export function upcomingCutoff(includePast: boolean | undefined): string | null {
  return includePast ? null : new Date(Date.now() - UPCOMING_GRACE_MS).toISOString();
}

type RecRow<K extends string> = { [key in K]: string } & { score: number | string; reason_kind: string; reason_text: string; reason_ref: string | null };

interface QueueRow {
  target_type: ModerationQueueItem["targetType"];
  target_id: string;
  report_count: number;
  first_reported_at: string;
  last_reported_at: string;
  reasons: ModerationQueueItem["reasons"];
  target_label: string | null;
  target_status: string | null;
}

function mapQueueRow(r: QueueRow): ModerationQueueItem {
  return {
    targetType: r.target_type,
    targetId: r.target_id,
    reportCount: r.report_count,
    firstReportedAt: r.first_reported_at,
    lastReportedAt: r.last_reported_at,
    reasons: r.reasons ?? [],
    targetLabel: r.target_label,
    targetStatus: r.target_status,
  };
}

interface ReportRowWithReporter {
  id: string;
  reason: ModerationReport["reason"];
  details: string | null;
  status: ModerationReport["status"];
  created_at: string;
  resolved_at: string | null;
  reporter: ProfileSummaryRow | null;
}

interface HistoryRow {
  id: string;
  action: ModerationLogEntry["action"];
  reason: string | null;
  status_before: string | null;
  status_after: string | null;
  resolved_reports: number;
  created_at: string;
  moderator: ProfileSummaryRow | null;
}

/** moderation_target() returns jsonb; fill in every key so the shape is exact. */
function mapSnapshot(s: Partial<ModerationSnapshot>): ModerationSnapshot {
  return {
    label: s.label ?? "",
    status: s.status ?? "",
    visibility: s.visibility ?? null,
    city: s.city ?? null,
    neighborhood: s.neighborhood ?? null,
    body: s.body ?? null,
    extra: s.extra ?? null,
    ownerId: s.ownerId ?? null,
    ownerUsername: s.ownerUsername ?? null,
    createdAt: s.createdAt ?? "",
  };
}

const PLACE_MAP_SELECT = "id, name, category_slug, lat, lng, rating_avg, rating_count";
const EVENT_MAP_SELECT = "id, title, category_slug, lat, lng, starts_at";

export function createSupabaseRepository(supabase: SupabaseClient): DataRepository {
  const repo: DataRepository = {
    places: {
      async search(opts = {}) {
        const filters = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const near = validateNear(opts.near);
        if (near) {
          // Ids in distance order (RLS applies inside), then the full rows by id.
          const afterNear = decodeDistanceCursor(opts.cursor);
          const ranked = unwrap(
            await supabase
              .rpc("discover_places_nearest", {
                p_lat: near.lat,
                p_lng: near.lng,
                ...discoverArgs(filters),
                p_after_distance: afterNear?.distance ?? null,
                p_after_id: afterNear?.id ?? null,
              })
              .order("distance_m", { ascending: true })
              .order("id", { ascending: true })
              .limit(limit + 1),
          ) as { id: string; distance_m: number }[];
          const page = ranked.slice(0, limit);
          const full = page.length
            ? (unwrap(await supabase.from("places").select(PLACE_SELECT).in("id", page.map((r) => r.id))) as PlaceRow[])
            : [];
          const byId = new Map(full.map((r) => [r.id, r]));
          const last = page.at(-1);
          return {
            items: page.map((r) => byId.get(r.id)).filter((r): r is PlaceRow => !!r).map(mapPlace),
            nextCursor: ranked.length > limit && last ? encodeDistanceCursor(Number(last.distance_m), last.id) : null,
          };
        }
        const after = decodeCursor(opts.cursor);
        // RLS applies inside the invoker-rights function; ordering and limit
        // are applied by PostgREST around the inlined query.
        const rows = unwrap(
          await supabase
            .rpc("discover_places", { ...discoverArgs(filters), p_after_created_at: after?.key ?? null, p_after_id: after?.id ?? null })
            .select(PLACE_SELECT)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(limit + 1),
        ) as PlaceRow[];
        return toPage(rows, limit, mapPlace, (r) => ({ key: r.created_at, id: r.id }));
      },
      async count(opts = {}) {
        const { count, error } = await supabase.rpc("discover_places", discoverArgs(normalizeFilters(opts)), { count: "exact", head: true });
        if (error) throw translate(error);
        return count ?? 0;
      },
      async neighborhoods() {
        const rows = unwrap(await supabase.rpc("discover_neighborhoods")) as {
          key: string;
          name: string;
          city: string;
          place_count: number;
          top_categories: string[] | null;
          lat: number;
          lng: number;
        }[];
        return rows.map<NeighborhoodSummary>((r) => ({
          key: r.key,
          name: r.name,
          city: r.city,
          placeCount: r.place_count,
          topCategories: r.top_categories ?? [],
          lat: Number(r.lat),
          lng: Number(r.lng),
        }));
      },
      async mapMarkers(opts = {}) {
        const filters = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
        const rows = unwrap(
          await supabase
            .rpc("discover_places", discoverArgs(filters))
            .select(PLACE_MAP_SELECT)
            .order("rating_count", { ascending: false })
            .order("save_count", { ascending: false })
            .order("creator_reputation", { ascending: false })
            .order("id", { ascending: true })
            .limit(limit + 1),
        ) as { id: string; name: string; category_slug: string; lat: number; lng: number; rating_avg: number | string; rating_count: number }[];
        return {
          items: rows.slice(0, limit).map<PlaceMapRecord>((r) => ({
            id: r.id, name: r.name, categorySlug: r.category_slug, lat: Number(r.lat), lng: Number(r.lng),
            ratingAvg: Number(r.rating_avg), ratingCount: r.rating_count,
          })),
          truncated: rows.length > limit,
          limit,
        };
      },
      async get(id, viewerId = null) {
        const row = unwrap(await supabase.from("places").select(PLACE_SELECT).eq("id", id).maybeSingle()) as PlaceRow | null;
        if (!row) return null;
        // saved_places RLS only exposes the viewer's own rows, so a count over it
        // would be 0 or 1. The trigger-maintained column is the real total.
        const [viewerSaveRes, viewerRatingRes] = await Promise.all([
          viewerId
            ? supabase.from("saved_places").select("place_id").eq("place_id", id).eq("user_id", viewerId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          viewerId
            ? supabase.from("place_ratings").select("score, note").eq("place_id", id).eq("user_id", viewerId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        const detail: PlaceDetail = {
          ...mapPlace(row),
          saveCount: row.save_count ?? 0,
          viewerSaved: !!viewerSaveRes.data,
          viewerRating: (viewerRatingRes.data as { score: number; note: string | null } | null)?.score ?? null,
          viewerRatingNote: (viewerRatingRes.data as { score: number; note: string | null } | null)?.note ?? null,
          viewerIsLocal: viewerId ? await repo.profiles.isLocalOf(viewerId, row.city) : false,
        };
        return detail;
      },
      async create(input, creatorId) {
        const id = unwrap(
          await supabase.rpc("create_place_with_details", {
            p_name: input.name,
            p_description: input.description,
            p_local_tip: input.localTip ?? null,
            p_category_slug: input.categorySlug,
            p_lat: input.lat,
            p_lng: input.lng,
            p_address: input.address ?? null,
            p_neighborhood: input.neighborhood ?? null,
            p_city: input.city,
            p_visibility: input.visibility ?? "public",
            p_tags: input.tags,
            p_photos: input.photos ?? [],
          }),
        ) as string;
        const created = await repo.places.get(id, creatorId);
        if (!created) throw new DataError("Place not found after create", "not_found");
        return created;
      },
      async update(id, input, creatorId) {
        unwrap(
          await supabase.rpc("update_place_with_tags", {
            p_id: id,
            p_name: input.name,
            p_description: input.description,
            p_local_tip: input.localTip ?? null,
            p_category_slug: input.categorySlug,
            p_lat: input.lat,
            p_lng: input.lng,
            p_address: input.address ?? null,
            p_neighborhood: input.neighborhood ?? null,
            p_city: input.city,
            p_tags: input.tags,
          }),
        );
        const updated = await repo.places.get(id, creatorId);
        if (!updated) throw new DataError("Place not found after update", "not_found");
        return updated;
      },
      async delete(id, creatorId) {
        const photos = unwrap(await supabase.from("place_photos").select("storage_path").eq("place_id", id)) as { storage_path: string | null }[];
        const paths = photos.map((photo) => photo.storage_path).filter((path): path is string => !!path);
        for (const storagePath of paths) await repo.storage.removeImage("places", storagePath);
        const deletedRows = unwrap(await supabase.from("places").delete().eq("id", id).eq("creator_id", creatorId).select("id")) as { id: string }[];
        if (!deletedRows.length) throw new DataError("You don't have permission to delete this place", "forbidden");
      },
      async addPhotos(placeId, images, uploaderId) {
        if (!images.length) return;
        const existingRows = unwrap(
          await supabase.from("place_photos").select("sort_order").eq("place_id", placeId),
        ) as { sort_order: number }[];
        const existing = existingRows.length;
        if (existing + images.length > MAX_PLACE_PHOTOS) {
          throw new DataError(
            `A place can have at most ${MAX_PLACE_PHOTOS} photos (${MAX_PLACE_PHOTOS - existing} slot(s) left)`,
            "invalid",
          );
        }
        const nextSortOrder = existingRows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;
        unwrap(
          await supabase.from("place_photos").insert(
            images.map((image, i) => ({
              place_id: placeId,
              url: image.url,
              storage_path: image.storagePath ?? null,
              uploader_id: uploaderId,
              sort_order: nextSortOrder + i,
            })),
          ),
        );
      },
      async setStatus(placeId, status, ownerId) {
        // RLS restricts this to the owner and to non-moderation statuses.
        const rows = unwrap(await supabase.from("places").update({ status }).eq("id", placeId).eq("creator_id", ownerId).select("id")) as { id: string }[];
        if (!rows.length) throw new DataError("You don't own this place", "forbidden");
      },
      async setVisibility(placeId, visibility, ownerId) {
        const rows = unwrap(await supabase.from("places").update({ visibility }).eq("id", placeId).eq("creator_id", ownerId).select("id")) as { id: string }[];
        if (!rows.length) throw new DataError("You don't own this place", "forbidden");
      },
      async listRatings(placeId) {
        const rows = unwrap(
          await supabase
            .from("place_ratings")
            .select(`id, score, note, created_at, updated_at, user:profiles!place_ratings_user_id_fkey(${PROFILE_SUMMARY})`)
            .eq("place_id", placeId)
            .not("note", "is", null)
            .order("updated_at", { ascending: false }),
        ) as unknown as {
          id: string;
          score: number;
          note: string | null;
          created_at: string;
          updated_at: string;
          user: ProfileSummaryRow | null;
        }[];
        return rows
          .filter((r) => r.note && r.note.trim().length > 0)
          .map<PlaceRating>((r) => ({
            id: r.id,
            score: r.score,
            note: r.note,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            user: mapSummary(r.user),
          }));
      },
      async removePhoto(placeId, photoId, uploaderId) {
        const photo = unwrap(await supabase.from("place_photos").select("storage_path, uploader_id, place:places!place_photos_place_id_fkey(creator_id)").eq("id", photoId).eq("place_id", placeId).maybeSingle()) as { storage_path: string | null; uploader_id: string | null; place: { creator_id: string | null } | null } | null;
        if (!photo) throw new DataError("Photo not found", "not_found");
        const isUploader = photo.uploader_id === uploaderId;
        const isOwner = photo.place?.creator_id === uploaderId;
        if (!isUploader && !isOwner) throw new DataError("Only the uploader or place owner can remove this photo", "forbidden");
        const deleted = unwrap(await supabase.from("place_photos").delete().eq("id", photoId).select("id")) as { id: string }[];
        if (!deleted.length) throw new DataError("You don't have permission to remove this photo", "forbidden");
        // Uploaders retain storage permission through their own folder policy.
        // Owner moderation removes the visible row; orphan cleanup is an admin job.
        return { storagePath: isUploader ? photo.storage_path : null };
      },
      async getPhotoObject(photoId) {
        // RLS on place_photos applies can_view_place(); an invisible row is simply absent.
        const row = unwrap(
          await supabase.from("place_photos").select("storage_path").eq("id", photoId).maybeSingle(),
        ) as { storage_path: string | null } | null;
        return row?.storage_path ? { storagePath: row.storage_path } : null;
      },
      async listByCreator(userId) {
        const rows = unwrap(
          await supabase.from("places").select(PLACE_SELECT).eq("creator_id", userId).neq("status", "removed").order("created_at", { ascending: false }),
        ) as PlaceRow[];
        return rows.map(mapPlace);
      },
      async listSaved(userId) {
        const rows = (await fetchAllRows((from, to) =>
          supabase
            .from("saved_places")
            .select(`created_at, place:places!saved_places_place_id_fkey(${PLACE_SELECT})`)
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .order("place_id", { ascending: true })
            .range(from, to),
        )) as unknown as { place: PlaceRow | null }[];
        return rows.map((r) => r.place).filter((p): p is PlaceRow => !!p && p.status === "published").map(mapPlace);
      },
      async save(userId, placeId) {
        const res = await supabase.from("saved_places").insert({ user_id: userId, place_id: placeId });
        if (res.error && res.error.code !== "23505") throw translate(res.error);
      },
      async unsave(userId, placeId) {
        unwrap(await supabase.from("saved_places").delete().eq("user_id", userId).eq("place_id", placeId));
      },
      async rate(userId, placeId, score, note) {
        unwrap(
          await supabase
            .from("place_ratings")
            .upsert({ user_id: userId, place_id: placeId, score, note }, { onConflict: "place_id,user_id" }),
        );
        const place = unwrap(await supabase.from("places").select("rating_avg, rating_count").eq("id", placeId).single()) as {
          rating_avg: number | string;
          rating_count: number;
        };
        return { ratingAvg: Number(place.rating_avg), ratingCount: place.rating_count };
      },
      async removeRating(userId, placeId) {
        unwrap(await supabase.from("place_ratings").delete().eq("user_id", userId).eq("place_id", placeId));
        const place = unwrap(await supabase.from("places").select("rating_avg, rating_count").eq("id", placeId).single()) as { rating_avg: number | string; rating_count: number };
        return { ratingAvg: Number(place.rating_avg), ratingCount: place.rating_count };
      },
    },

    events: {
      async search(opts = {}) {
        const filters = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const rows = unwrap(
          await supabase
            .rpc("discover_events", {
              ...discoverArgs(filters),
              p_ends_after: upcomingCutoff(opts.includePast),
              p_starts_before: normalizeTimestamp(opts.startsBefore, "startsBefore"),
              p_after_starts_at: after?.key ?? null,
              p_after_id: after?.id ?? null,
            })
            .select(EVENT_SELECT)
            .order("starts_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(limit + 1),
        ) as EventRow[];
        return toPage(rows, limit, mapEvent, (r) => ({ key: r.starts_at, id: r.id }));
      },
      async count(opts = {}) {
        const { count, error } = await supabase.rpc(
          "discover_events",
          {
            ...discoverArgs(normalizeFilters(opts)),
            p_ends_after: upcomingCutoff(opts.includePast),
            p_starts_before: normalizeTimestamp(opts.startsBefore, "startsBefore"),
          },
          { count: "exact", head: true },
        );
        if (error) throw translate(error);
        return count ?? 0;
      },
      async mapMarkers(opts = {}) {
        const filters = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
        const rows = unwrap(
          await supabase
            .rpc("discover_events", { ...discoverArgs(filters), p_ends_after: upcomingCutoff(opts.includePast) })
            .select(EVENT_MAP_SELECT)
            .order("starts_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(limit + 1),
        ) as { id: string; title: string; category_slug: string; lat: number; lng: number; starts_at: string }[];
        return {
          items: rows.slice(0, limit).map<EventMapRecord>((r) => ({
            id: r.id, title: r.title, categorySlug: r.category_slug, lat: Number(r.lat), lng: Number(r.lng), startsAt: r.starts_at,
          })),
          truncated: rows.length > limit,
          limit,
        };
      },
      async get(id, viewerId = null) {
        const row = unwrap(
          await supabase
            .from("events")
            .select(`${EVENT_SELECT}, attendees:event_attendees(created_at, profile:profiles!event_attendees_user_id_fkey(${PROFILE_SUMMARY}))`)
            .eq("id", id)
            .maybeSingle(),
        ) as (EventRow & { attendees: { created_at: string; profile: ProfileSummaryRow | null }[] }) | null;
        if (!row) return null;
        const attendees = [...row.attendees]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((a) => mapSummary(a.profile))
          .filter((p): p is ProfileSummary => !!p);
        const detail: EventDetail = {
          ...mapEvent(row),
          attendeeCount: row.attendees.length,
          viewerJoined: viewerId ? attendees.some((a) => a.id === viewerId) : false,
          attendees,
        };
        return detail;
      },
      async create(input, creatorId) {
        const row = unwrap(
          await supabase
            .from("events")
            .insert({
              title: input.title,
              description: input.description,
              place_id: input.placeId ?? null,
              location_name: input.locationName,
              address: input.address ?? null,
              lat: input.lat,
              lng: input.lng,
              starts_at: input.startsAt,
              ends_at: input.endsAt ?? null,
              creator_id: creatorId,
              category_slug: input.categorySlug,
              capacity: input.capacity ?? null,
            })
            .select("id")
            .single(),
        ) as { id: string };
        if (input.tags.length) {
          unwrap(await supabase.from("event_tags").insert(input.tags.map((t) => ({ event_id: row.id, interest_slug: t }))));
        }
        // Creator attends by default (also enforced as a default by the join rules).
        await repo.events.join(creatorId, row.id);
        const created = await repo.events.get(row.id, creatorId);
        if (!created) throw new DataError("Event not found after create", "not_found");
        return created;
      },
      async update(id, input, creatorId) {
        const current = unwrap(await supabase.from("events").select("status, starts_at, ends_at").eq("id", id).eq("creator_id", creatorId).maybeSingle()) as { status: Event["status"]; starts_at: string; ends_at: string | null } | null;
        if (!current) throw new DataError("Event not found", "not_found");
        if (current.status !== "published" || new Date(current.ends_at ?? current.starts_at).getTime() <= Date.now()) throw new DataError("Only future published events can be edited", "invalid");
        const attendees = unwrap(await supabase.from("event_attendees").select("user_id", { count: "exact" }).eq("event_id", id)) as { user_id: string }[];
        if (input.capacity !== null && input.capacity !== undefined && input.capacity < attendees.length) throw new DataError("Capacity cannot be below the existing attendee count", "invalid");
        unwrap(
          await supabase.rpc("update_event_with_tags", {
            p_id: id,
            p_title: input.title,
            p_description: input.description,
            p_place_id: input.placeId ?? null,
            p_location_name: input.locationName,
            p_address: input.address ?? null,
            p_lat: input.lat,
            p_lng: input.lng,
            p_starts_at: input.startsAt,
            p_ends_at: input.endsAt ?? null,
            p_category_slug: input.categorySlug,
            p_capacity: input.capacity ?? null,
            p_tags: input.tags,
          }),
        );
        const updated = await repo.events.get(id, creatorId);
        if (!updated) throw new DataError("Event not found after update", "not_found");
        return updated;
      },
      async cancel(id, creatorId) {
        const cancelledRows = unwrap(await supabase.from("events").update({ status: "cancelled" }).eq("id", id).eq("creator_id", creatorId).select("id")) as { id: string }[];
        if (!cancelledRows.length) throw new DataError("You don't have permission to cancel this event", "forbidden");
      },
      async delete(id, creatorId) {
        const deletedRows = unwrap(await supabase.from("events").delete().eq("id", id).eq("creator_id", creatorId).select("id")) as { id: string }[];
        if (!deletedRows.length) throw new DataError("You don't have permission to delete this event", "forbidden");
      },
      async join(userId, eventId) {
        const res = await supabase.from("event_attendees").insert({ user_id: userId, event_id: eventId });
        if (res.error && res.error.code !== "23505") throw translate(res.error);
      },
      async leave(userId, eventId) {
        unwrap(await supabase.from("event_attendees").delete().eq("user_id", userId).eq("event_id", eventId));
      },
      async listByCreator(userId) {
        const rows = unwrap(
          await supabase.from("events").select(EVENT_SELECT).eq("creator_id", userId).neq("status", "removed").order("starts_at", { ascending: true }),
        ) as EventRow[];
        return rows.map(mapEvent);
      },
      async listJoined(userId) {
        const rows = unwrap(
          await supabase.from("event_attendees").select(`event:events!event_attendees_event_id_fkey(${EVENT_SELECT})`).eq("user_id", userId),
        ) as unknown as { event: EventRow | null }[];
        return rows
          .map((r) => r.event)
          .filter((e): e is EventRow => !!e && (e.status === "published" || e.status === "cancelled"))
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
          .map(mapEvent);
      },
      async listForPlace(placeId) {
        const cutoff = new Date().toISOString();
        const rows = unwrap(
          await supabase
            .from("events")
            .select(EVENT_SELECT)
            .eq("place_id", placeId)
            .eq("status", "published")
            .or(`ends_at.gte.${cutoff},and(ends_at.is.null,starts_at.gte.${cutoff})`)
            .order("starts_at", { ascending: true }),
        ) as EventRow[];
        return rows.map(mapEvent);
      },
    },

    tags: {
      async counts() {
        const rows = unwrap(await supabase.rpc("discover_tag_counts", { p_ends_after: upcomingCutoff(false) })) as {
          interest_slug: string;
          place_count: number;
          event_count: number;
        }[];
        return Object.fromEntries(rows.map((r) => [r.interest_slug, { places: r.place_count, events: r.event_count }]));
      },
    },

    savedLists: {
      async list() {
        // RLS and the function's own filter scope this to the signed-in owner.
        const rows = unwrap(await supabase.rpc("saved_list_summaries")) as SavedListRow[];
        return rows.map(mapSavedList);
      },
      async create(ownerId, rawName) {
        const name = normalizeListName(rawName);
        const res = await supabase
          .from("saved_lists")
          .insert({ owner_id: ownerId, name })
          .select("id, name, created_at, updated_at")
          .single();
        if (res.error) throw listError(res.error, name);
        return mapSavedList({ ...(res.data as Omit<SavedListRow, "place_count">), place_count: 0 });
      },
      async rename(ownerId, listId, rawName) {
        const name = normalizeListName(rawName);
        const res = await supabase.from("saved_lists").update({ name }).eq("id", listId).eq("owner_id", ownerId).select("id");
        if (res.error) throw listError(res.error, name);
        if (!res.data?.length) throw new DataError("List not found", "not_found");
      },
      async delete(ownerId, listId) {
        const rows = unwrap(await supabase.from("saved_lists").delete().eq("id", listId).eq("owner_id", ownerId).select("id")) as { id: string }[];
        if (!rows.length) throw new DataError("List not found", "not_found");
      },
      async addPlace(_ownerId, listId, placeId) {
        const res = await supabase.rpc("add_to_saved_list", { p_list_id: listId, p_place_id: placeId });
        if (res.error) throw listError(res.error);
      },
      async removePlace(ownerId, listId, placeId) {
        const lists = unwrap(await supabase.from("saved_lists").select("id").eq("id", listId).eq("owner_id", ownerId)) as { id: string }[];
        if (!lists.length) throw new DataError("List not found", "not_found");
        unwrap(await supabase.from("saved_list_items").delete().eq("list_id", listId).eq("place_id", placeId));
      },
      async get(ownerId, listId) {
        const list = unwrap(
          await supabase.from("saved_lists").select("id, name, created_at, updated_at").eq("id", listId).eq("owner_id", ownerId).maybeSingle(),
        ) as Omit<SavedListRow, "place_count"> | null;
        if (!list) return null;
        // Paged: a list can hold more places than one PostgREST response returns.
        const rows = (await fetchAllRows((from, to) =>
          supabase
            .from("saved_list_items")
            .select(`created_at, place:places!saved_list_items_place_id_fkey(${PLACE_SELECT})`)
            .eq("list_id", listId)
            .order("created_at", { ascending: false })
            .order("place_id", { ascending: true })
            .range(from, to),
        )) as unknown as { place: PlaceRow | null }[];
        // RLS hides places the owner can no longer see; hidden ones are filtered here, as on the Saved page.
        const places = rows.map((r) => r.place).filter((p): p is PlaceRow => !!p && p.status === "published").map(mapPlace);
        return { list: mapSavedList({ ...list, place_count: places.length }), places };
      },
      async memberships(ownerId, placeId) {
        const rows = unwrap(
          await supabase.from("saved_list_items").select("list_id").eq("owner_id", ownerId).eq("place_id", placeId),
        ) as { list_id: string }[];
        return rows.map((r) => r.list_id);
      },
    },

    profiles: {
      async getById(id) {
        const row = unwrap(await supabase.from("profiles").select(PROFILE_SELECT).eq("id", id).maybeSingle()) as ProfileRow | null;
        return row ? mapProfile(row) : null;
      },
      async getByUsername(username) {
        const row = unwrap(
          await supabase.from("profiles").select(PROFILE_SELECT).eq("username", username.toLowerCase()).maybeSingle(),
        ) as ProfileRow | null;
        return row ? mapProfile(row) : null;
      },
      async update(userId, input) {
        // The profiles trigger is the real limit; checking first gives the
        // same message without a round trip that fails.
        const current = await repo.profiles.getById(userId);
        if (current && !sameCity(input.homeCity, current.homeCity)) {
          const next = nextHomeCityChange(current.homeCity, current.homeCityChangedAt);
          if (next) throw new DataError(homeCityCooldownMessage(next), "rate_limited");
        }
        const patch: Record<string, unknown> = {
          username: input.username,
          display_name: input.displayName,
          bio: input.bio,
          home_city: input.homeCity,
        };
        if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl;
        const res = await supabase.from("profiles").update(patch).eq("id", userId);
        if (res.error) {
          if (res.error.code === "23505") throw new DataError("That username is taken", "conflict");
          throw translate(res.error);
        }
        unwrap(await supabase.from("profile_interests").delete().eq("profile_id", userId));
        if (input.interests.length) {
          unwrap(await supabase.from("profile_interests").insert(input.interests.map((i) => ({ profile_id: userId, interest_slug: i }))));
        }
        const updated = await repo.profiles.getById(userId);
        if (!updated) throw new DataError("Profile not found", "not_found");
        return updated;
      },
      async completeOnboarding(userId) {
        unwrap(await supabase.from("profiles").update({ onboarded_at: new Date().toISOString() }).eq("id", userId).is("onboarded_at", null));
      },
      async stats(userId) {
        const [places, events, followers, following] = await Promise.all([
          supabase.from("places").select("*", { count: "exact", head: true }).eq("creator_id", userId).eq("status", "published"),
          supabase.from("events").select("*", { count: "exact", head: true }).eq("creator_id", userId).eq("status", "published"),
          supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", userId),
          supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", userId),
        ]);
        return {
          places: places.count ?? 0,
          events: events.count ?? 0,
          followers: followers.count ?? 0,
          following: following.count ?? 0,
        } satisfies ProfileStats;
      },
      async isFollowing(followerId, followingId) {
        const row = unwrap(
          await supabase.from("follows").select("follower_id").eq("follower_id", followerId).eq("following_id", followingId).maybeSingle(),
        );
        return !!row;
      },
      async follow(followerId, followingId) {
        if (followerId === followingId) throw new DataError("You can't follow yourself");
        const res = await supabase.from("follows").insert({ follower_id: followerId, following_id: followingId });
        if (res.error && res.error.code !== "23505") throw translate(res.error);
      },
      async unfollow(followerId, followingId) {
        unwrap(await supabase.from("follows").delete().eq("follower_id", followerId).eq("following_id", followingId));
      },
      async listFollowing(userId) {
        const rows = unwrap(
          await supabase.from("follows").select(`profile:profiles!follows_following_id_fkey(${PROFILE_SUMMARY})`).eq("follower_id", userId),
        ) as unknown as { profile: ProfileSummaryRow | null }[];
        return rows.map((r) => mapSummary(r.profile)).filter((p): p is ProfileSummary => !!p);
      },
      async connections(userId, kind, viewerId) {
        const [rows, followingRes] = await Promise.all([
          kind === "followers"
            ? supabase.from("follows").select(`profile:profiles!follows_follower_id_fkey(${PROFILE_SELECT})`).eq("following_id", userId)
            : supabase.from("follows").select(`profile:profiles!follows_following_id_fkey(${PROFILE_SELECT})`).eq("follower_id", userId),
          viewerId
            ? supabase.from("follows").select("following_id").eq("follower_id", viewerId)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (followingRes.error) throw translate(followingRes.error);
        const following = new Set(((followingRes.data ?? []) as { following_id: string }[]).map((r) => r.following_id));
        return (unwrap(rows) as unknown as { profile: ProfileRow | null }[])
          .map((r) => r.profile)
          .filter((p): p is ProfileRow => !!p)
          .map<ConnectionEntry>((p) => ({
            profile: mapProfile(p),
            viewerFollows: following.has(p.id),
            isViewer: p.id === viewerId,
          }));
      },
      async isLocalOf(userId, city) {
        if (!userId || !city) return false;
        // Single source of truth: the SQL function the RLS policy also uses.
        const { data, error } = await supabase.rpc("is_local", { target_city: city });
        if (error) throw translate(error);
        return data === true;
      },
      async activity(userId, viewerId = null) {
        const [createdPlaces, createdEvents, joinedEvents, savedPlaces] = await Promise.all([
          repo.places.listByCreator(userId, viewerId),
          repo.events.listByCreator(userId, viewerId),
          repo.events.listJoined(userId, viewerId),
          viewerId === userId ? repo.places.listSaved(userId) : Promise.resolve([]),
        ]);
        return { createdPlaces, createdEvents, joinedEvents, savedPlaces };
      },
      async suggest(userId, limit = 6) {
        const [profilesRes, mineRes, followingRes] = await Promise.all([
          supabase.from("profiles").select(PROFILE_SELECT).order("created_at", { ascending: true }).limit(60),
          userId ? supabase.from("profile_interests").select("interest_slug").eq("profile_id", userId) : Promise.resolve({ data: [], error: null }),
          userId ? supabase.from("follows").select("following_id").eq("follower_id", userId) : Promise.resolve({ data: [], error: null }),
        ]);
        const profiles = (unwrap(profilesRes) as ProfileRow[]).map(mapProfile);
        const mine = new Set(((mineRes.data ?? []) as { interest_slug: string }[]).map((r) => r.interest_slug));
        const following = new Set(((followingRes.data ?? []) as { following_id: string }[]).map((r) => r.following_id));
        return profiles
          .filter((p) => p.id !== userId && !following.has(p.id))
          .map((p) => ({ p, overlap: p.interests.filter((i) => mine.has(i)).length }))
          .sort((a, b) => b.overlap - a.overlap || a.p.createdAt.localeCompare(b.p.createdAt))
          .slice(0, limit)
          .map(({ p }) => p);
      },
      async search(query, limit = 20) {
        // Strip PostgREST filter syntax and LIKE wildcards so the user's text
        // can only ever be a literal substring match.
        const q = query.trim().toLowerCase().replace(/[,()%_\\"]/g, "");
        if (!q) return [];
        const rows = unwrap(
          await supabase
            .from("profiles")
            .select(PROFILE_SELECT)
            .or(`username.ilike.%${q}%,display_name.ilike.%${q}%,home_city.ilike.%${q}%`)
            .limit(Math.max(limit * 3, limit)),
        ) as ProfileRow[];
        const rank = (p: Profile) => {
          const username = p.username.toLowerCase();
          const name = p.displayName.toLowerCase();
          if (username === q || name === q) return 0;
          if (username.startsWith(q) || name.startsWith(q)) return 1;
          if (username.includes(q) || name.includes(q)) return 2;
          return 3;
        };
        return rows
          .map(mapProfile)
          .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName))
          .slice(0, limit);
      },
      async listByInterest(interestSlug, limit = 50) {
        const links = unwrap(
          await supabase.from("profile_interests").select("profile_id").eq("interest_slug", interestSlug).limit(limit),
        ) as { profile_id: string }[];
        if (!links.length) return [];
        const rows = unwrap(
          await supabase
            .from("profiles")
            .select(PROFILE_SELECT)
            .in("id", links.map((l) => l.profile_id))
            .order("created_at", { ascending: false }),
        ) as ProfileRow[];
        return rows.map(mapProfile);
      },
    },

    reports: {
      async create(input, reporterId) {
        const res = await supabase.from("reports").insert({
          reporter_id: reporterId,
          target_type: input.targetType,
          target_id: input.targetId,
          reason: input.reason,
          details: input.details ?? null,
        });
        if (res.error && res.error.code !== "23505") throw translate(res.error);
      },
      async listFiledBy() {
        return readReports(supabase, "reports_i_filed");
      },
      async listAgainstMyContent() {
        return readReports(supabase, "reports_about_my_stuff");
      },
    },

    moderation: {
      async isModerator(userId) {
        if (!userId) return false;
        const { data, error } = await supabase.rpc("is_moderator");
        if (error) throw translate(error);
        return data === true;
      },
      async queue(_viewerId, opts = {}) {
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        // Empty for non-moderators: the function checks is_moderator() itself.
        const rows = unwrap(
          await supabase.rpc("moderation_queue", { p_after_first: after?.key ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 }),
        ) as QueueRow[];
        return toPage(rows, limit, mapQueueRow, (r) => ({ key: r.first_reported_at, id: r.target_id }));
      },
      async target(_viewerId, targetType, targetId) {
        const snapshot = unwrap(await supabase.rpc("moderation_target", { p_target_type: targetType, p_target_id: targetId })) as ModerationSnapshot | null;
        // RLS lets only moderators read reports and history; a non-moderator gets null here and empty lists there.
        if (!snapshot && !(await repo.moderation.isModerator(_viewerId))) return null;
        const [reportRows, historyRows] = await Promise.all([
          fetchAllRows((from, to) =>
            supabase
              .from("reports")
              .select(`id, reason, details, status, created_at, resolved_at, reporter:profiles!reports_reporter_id_fkey(${PROFILE_SUMMARY})`)
              .eq("target_type", targetType)
              .eq("target_id", targetId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(from, to),
          ),
          fetchAllRows((from, to) =>
            supabase
              .from("moderation_actions")
              .select(`id, action, reason, status_before, status_after, resolved_reports, created_at, moderator:profiles!moderation_actions_moderator_id_fkey(${PROFILE_SUMMARY})`)
              .eq("target_type", targetType)
              .eq("target_id", targetId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .range(from, to),
          ),
        ]);
        const reports = (reportRows as unknown as ReportRowWithReporter[]).map<ModerationReport>((r) => ({
          id: r.id, reason: r.reason, details: r.details, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at, reporter: mapSummary(r.reporter),
        })).sort(compareModerationReports);
        const history = (historyRows as unknown as HistoryRow[]).map<ModerationLogEntry>((r) => ({
          id: r.id, action: r.action, reason: r.reason, statusBefore: r.status_before, statusAfter: r.status_after,
          resolvedReports: r.resolved_reports, createdAt: r.created_at, moderator: mapSummary(r.moderator),
        }));
        return { targetType, targetId, snapshot: snapshot ? mapSnapshot(snapshot) : null, reports, history };
      },
      async resolve(_moderatorId, input) {
        const rows = unwrap(
          await supabase.rpc("moderate_target", {
            p_target_type: input.targetType,
            p_target_id: input.targetId,
            p_action: input.action,
            p_reason: input.reason ?? null,
          }),
        ) as { status_after: string | null; resolved_reports: number }[];
        return { statusAfter: rows[0]?.status_after ?? null, resolvedReports: rows[0]?.resolved_reports ?? 0 };
      },
      async setLocalStatus(_moderatorId, userId, revoked, reason) {
        unwrap(await supabase.rpc("set_local_status", { p_user_id: userId, p_revoked: revoked, p_reason: reason }));
      },
      async localRevoked(userId) {
        const rows = unwrap(await supabase.from("local_revocations").select("user_id").eq("user_id", userId)) as { user_id: string }[];
        return rows.length > 0;
      },
      async myRemovedContent() {
        const rows = unwrap(await supabase.rpc("my_removed_content")) as {
          target_type: RemovedContent["targetType"]; target_id: string; label: string; reason: string | null; removed_at: string | null;
        }[];
        return rows.map((r) => ({ targetType: r.target_type, targetId: r.target_id, label: r.label, reason: r.reason, removedAt: r.removed_at }));
      },
    },

    analytics: {
      async track(_userId, name, props = {}) {
        // The database derives the actor from the session and skips opted-out users.
        unwrap(await supabase.rpc("track_event", { p_name: name, p_props: props }));
      },
      async optedOut(userId) {
        const row = unwrap(await supabase.from("profiles").select("analytics_opt_out").eq("id", userId).maybeSingle()) as { analytics_opt_out: boolean } | null;
        return !!row?.analytics_opt_out;
      },
      async setOptOut(userId, optOut) {
        unwrap(await supabase.from("profiles").update({ analytics_opt_out: optOut }).eq("id", userId));
      },
      async funnel(_viewerId, from, to) {
        const rows = unwrap(await supabase.rpc("analytics_funnel", { p_from: from, p_to: to })) as { step: FunnelStep["step"]; actors: number; events: number }[];
        return rows.map((r) => ({ step: r.step, actors: r.actors, events: r.events }));
      },
      async weeklyContributors(_viewerId, weeks) {
        const rows = unwrap(await supabase.rpc("analytics_weekly_contributors", { p_weeks: weeks })) as { week_start: string; contributors: number }[];
        return rows.map((r) => ({ weekStart: r.week_start, contributors: r.contributors }));
      },
      async saveSources(_viewerId, from, to) {
        const rows = unwrap(await supabase.rpc("analytics_save_sources", { p_from: from, p_to: to })) as { source: "community" | "seed"; saves: number }[];
        const out = { community: 0, seed: 0 };
        for (const r of rows) out[r.source] = r.saves;
        return out;
      },
    },

    notifications: {
      async list(_userId, opts = {}) {
        const limit = clampLimit(opts.limit, 30, 100);
        const before = decodeCursor(opts.cursor);
        const rows = unwrap(await supabase.rpc("my_notifications", {
          p_before_at: before?.key ?? null, p_before_id: before?.id ?? null, p_limit: limit + 1,
        })) as NotificationRpcRow[];
        return toPage(rows, limit, mapNotification, (r) => ({ key: r.updated_at, id: r.id }));
      },
      async unreadCount(userId) {
        const res = await supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
        if (res.error) throw translate(res.error);
        return res.count ?? 0;
      },
      async markRead(_userId, ids = null) {
        return Number(unwrap(await supabase.rpc("mark_notifications_read", { p_ids: ids })) ?? 0);
      },
      async settings(userId) {
        const row = unwrap(await supabase.from("notification_settings").select("*").eq("user_id", userId).maybeSingle()) as SettingsRow | null;
        return row ? { mutedTypes: row.muted_types, pushTypes: row.push_types, quietStart: row.quiet_start, quietEnd: row.quiet_end, timeZone: row.time_zone } as NotificationSettings : { ...DEFAULT_NOTIFICATION_SETTINGS };
      },
      async updateSettings(userId, input) {
        const res = await supabase.from("notification_settings").upsert({
          user_id: userId, muted_types: input.mutedTypes, push_types: input.pushTypes,
          quiet_start: input.quietStart, quiet_end: input.quietEnd, time_zone: input.timeZone,
        });
        if (res.error?.code === "22023") throw new DataError("Unknown time zone", "invalid"); // invalid_parameter_value
        if (res.error) throw translate(res.error);
      },
      async addDevice(_userId, device) {
        if (device.kind === "expo") unwrap(await supabase.rpc("save_expo_push_token", { p_token: device.endpoint }));
        else unwrap(await supabase.rpc("save_push_subscription", { p_endpoint: device.endpoint, p_p256dh: device.p256dh, p_auth: device.auth }));
      },
      async removeDevice(userId, endpoint) {
        unwrap(await supabase.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint));
      },
      async deviceCount(userId) {
        const res = await supabase.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", userId);
        if (res.error) throw translate(res.error);
        return res.count ?? 0;
      },
      async tripPlanReady(_userId, title) {
        unwrap(await supabase.rpc("notify_trip_plan_ready", { p_title: title }));
      },
      async scheduleReminders(now) {
        return Number(unwrap(await supabase.rpc("schedule_event_reminders", { p_now: now })) ?? 0);
      },
      async claimPushes(now, limit = 100) {
        const rows = unwrap(await supabase.rpc("claim_push_batch", { p_now: now, p_limit: limit })) as PushClaimRow[];
        return rows.map((r): PushClaim => ({
          notificationId: r.notification_id, userId: r.user_id, type: r.type, actorUsername: r.actor_username,
          subjectType: r.subject_type, subjectId: r.subject_id, label: r.label, detail: r.detail, count: r.count, devices: r.devices,
        }));
      },
      async dropDevice(endpoint) {
        unwrap(await supabase.rpc("drop_push_subscription", { p_endpoint: endpoint }));
      },
      async purge(now) {
        return Number(unwrap(await supabase.rpc("purge_notifications", { p_now: now })) ?? 0);
      },
    },

    messaging: {
      async conversations() {
        return (unwrap(await supabase.rpc("my_conversations")) as ConversationRpcRow[]).map(mapConversation);
      },
      async unreadTotal() {
        return (unwrap(await supabase.rpc("my_conversations")) as ConversationRpcRow[]).reduce((n, r) => n + Number(r.unread), 0);
      },
      async canMessage(_userId, otherId) {
        return Boolean(unwrap(await supabase.rpc("can_message", { p_other: otherId })));
      },
      async startDirect(_userId, otherId) {
        return unwrap(await supabase.rpc("start_direct", { p_other: otherId })) as string;
      },
      async eventConversation(_userId, eventId) {
        // RLS: only members see the conversation row.
        const row = unwrap(await supabase.from("conversations").select("id").eq("event_id", eventId).maybeSingle()) as { id: string } | null;
        return row?.id ?? null;
      },
      async get(userId, conversationId) {
        const all = (unwrap(await supabase.rpc("my_conversations")) as ConversationRpcRow[]).map(mapConversation);
        const summary = all.find((c) => c.id === conversationId);
        if (!summary) return null;
        const rows = unwrap(await supabase
          .from("conversation_members")
          .select(`last_read_at, profile:profiles!conversation_members_user_id_fkey(${PROFILE_SUMMARY})`)
          .eq("conversation_id", conversationId)) as unknown as { last_read_at: string | null; profile: ProfileSummaryRow | null }[];
        const members: ConversationMember[] = rows
          .map((r) => ({ profile: mapSummary(r.profile), lastReadAt: r.last_read_at }))
          .filter((m): m is ConversationMember => !!m.profile)
          .sort((a, b) => (a.profile.username < b.profile.username ? -1 : a.profile.username > b.profile.username ? 1 : 0));
        let canSend: boolean;
        if (summary.kind === "direct") {
          canSend = !!summary.other && !(unwrap(await supabase.rpc("is_blocked_between", { a: userId, b: summary.other.id })) as boolean);
        } else {
          const ev = unwrap(await supabase.from("events").select("status").eq("id", summary.eventId!).maybeSingle()) as { status: string } | null;
          canSend = ev?.status === "published";
        }
        return { ...summary, members, canSend };
      },
      async messages(_userId, conversationId, opts = {}) {
        const limit = clampLimit(opts.limit, MESSAGE_PAGE_SIZE, 100);
        const before = decodeCursor(opts.cursor);
        const rows = unwrap(await supabase.rpc("conversation_messages", {
          p_conversation: conversationId, p_before_at: before?.key ?? null, p_before_id: before?.id ?? null, p_limit: limit + 1,
        })) as { id: string; sender_id: string; body: string; created_at: string }[];
        const senders = await profileSummaries(supabase, [...new Set(rows.map((r) => r.sender_id))]);
        return toPage(rows, limit, (r): Message => ({
          id: r.id, conversationId, senderId: r.sender_id, sender: senders.get(r.sender_id) ?? null, body: r.body, createdAt: r.created_at,
        }), (r) => ({ key: r.created_at, id: r.id }));
      },
      async send(userId, conversationId, body) {
        const text = normalizeMessageBody(body);
        const res = await supabase.from("messages").insert({ conversation_id: conversationId, sender_id: userId, body: text }).select("id, sender_id, body, created_at").single();
        // The insert policy refuses non-members.
        if (res.error?.code === "42501") throw messagingError("not_found");
        const r = unwrap(res) as { id: string; sender_id: string; body: string; created_at: string };
        const senders = await profileSummaries(supabase, [userId]);
        return { id: r.id, conversationId, senderId: r.sender_id, sender: senders.get(userId) ?? null, body: r.body, createdAt: r.created_at };
      },
      async markRead(_userId, conversationId) {
        unwrap(await supabase.rpc("mark_read", { p_conversation: conversationId }));
      },
      async block(userId, otherId) {
        if (userId === otherId) throw messagingError("self");
        const res = await supabase.from("blocks").insert({ blocker_id: userId, blocked_id: otherId });
        if (res.error?.code === "23503") throw new DataError("Profile not found", "not_found");
        if (res.error && res.error.code !== "23505") throw translate(res.error);
      },
      async unblock(userId, otherId) {
        unwrap(await supabase.from("blocks").delete().eq("blocker_id", userId).eq("blocked_id", otherId));
      },
      async blocked(userId) {
        const rows = unwrap(await supabase
          .from("blocks")
          .select(`created_at, blocked_id, profile:profiles!blocks_blocked_id_fkey(${PROFILE_SUMMARY})`)
          .eq("blocker_id", userId)
          .order("created_at", { ascending: false })
          .order("blocked_id", { ascending: true })) as unknown as { profile: ProfileSummaryRow | null }[];
        return rows.map((r) => mapSummary(r.profile)).filter((p): p is ProfileSummary => !!p);
      },
    },

    ads: {
      async create(_advertiserId, input) {
        validateCampaign(input);
        const b = input.bounds;
        return unwrap(await supabase.rpc("create_ad_campaign", {
          p_kind: input.kind, p_target: input.targetId, p_headline: input.headline, p_body: input.body, p_category: input.categorySlug,
          p_north: b?.north ?? null, p_south: b?.south ?? null, p_east: b?.east ?? null, p_west: b?.west ?? null,
          p_starts_at: input.startsAt, p_ends_at: input.endsAt, p_budget_cents: input.budgetCents,
        })) as string;
      },
      async mine(advertiserId) {
        const rows = unwrap(await supabase.from("ad_campaigns").select(CAMPAIGN_SELECT).eq("advertiser_id", advertiserId)
          .order("created_at", { ascending: false }).order("id", { ascending: false })) as unknown as CampaignDbRow[];
        return rows.map(mapCampaign);
      },
      async setPaused(_advertiserId, campaignId, paused) {
        unwrap(await supabase.rpc("set_ad_campaign_paused", { p_campaign: campaignId, p_paused: paused }));
      },
      async reviewQueue() {
        // RLS: admins read every campaign; anyone else only their own (none pending here are theirs to review).
        if (!(unwrap(await supabase.rpc("is_admin")) as boolean)) return [];
        const rows = unwrap(await supabase.from("ad_campaigns").select(CAMPAIGN_SELECT).eq("status", "pending_review")
          .order("created_at", { ascending: true }).order("id", { ascending: true })) as unknown as CampaignDbRow[];
        return rows.map(mapCampaign);
      },
      async review(_adminId, campaignId, approve, note) {
        unwrap(await supabase.rpc("review_ad_campaign", { p_campaign: campaignId, p_approve: approve, p_note: note }));
      },
      async attachCheckout(campaignId, sessionId) {
        unwrap(await supabase.rpc("attach_ad_checkout", { p_campaign: campaignId, p_session: sessionId }));
      },
      async activate(sessionId, amountCents) {
        return unwrap(await supabase.rpc("activate_ad_campaign", { p_session: sessionId, p_amount: amountCents })) as "active" | "duplicate" | "mismatch" | "unknown";
      },
      async serve(slot, context, now = new Date().toISOString()) {
        const b = context.bounds;
        const rows = unwrap(await supabase.rpc("serve_ad", {
          p_slot: slot, p_north: b?.north ?? null, p_south: b?.south ?? null, p_east: b?.east ?? null, p_west: b?.west ?? null,
          p_category: context.categorySlug, p_now: now,
        })) as { campaign_id: string; kind: "place" | "event"; target_id: string; headline: string; body: string | null }[];
        const r = rows[0];
        return r ? { campaignId: r.campaign_id, kind: r.kind, targetId: r.target_id, headline: r.headline, body: r.body } : null;
      },
      async endFinished(now = new Date().toISOString()) {
        return Number(unwrap(await supabase.rpc("end_finished_ad_campaigns", { p_now: now })) ?? 0);
      },
    },

    payments: {
      async isPlus(userId) {
        return Boolean(unwrap(await supabase.rpc("is_plus", { p_user: userId })));
      },
      async entitlement(userId) {
        const row = unwrap(await supabase.from("entitlements").select("status, current_period_end").eq("user_id", userId).maybeSingle()) as { status: Entitlement["status"]; current_period_end: string | null } | null;
        if (!row) return null;
        const active = Boolean(unwrap(await supabase.rpc("is_plus", { p_user: userId })));
        return { plan: "plus", status: row.status, currentPeriodEnd: row.current_period_end, active };
      },
      async canSell(userId) {
        const row = unwrap(await supabase.from("host_accounts").select("charges_enabled").eq("user_id", userId).maybeSingle()) as { charges_enabled: boolean } | null;
        return !!row?.charges_enabled;
      },
      async setEventPrice(_ownerId, eventId, cents) {
        unwrap(await supabase.rpc("set_event_price", { p_event: eventId, p_cents: cents }));
      },
      async reserveTicket(_userId, eventId) {
        const [r] = unwrap(await supabase.rpc("reserve_ticket", { p_event: eventId })) as { ticket_id: string; amount_cents: number; currency: string; expires_at: string; event_title: string; host_account: string | null }[];
        return { ticketId: r.ticket_id, amountCents: r.amount_cents, currency: r.currency, expiresAt: r.expires_at, eventTitle: r.event_title, hostAccount: r.host_account };
      },
      async myTickets(userId) {
        const rows = unwrap(await supabase.from("tickets").select("*, event:events!tickets_event_id_fkey(title, starts_at)").eq("user_id", userId)
          .order("created_at", { ascending: false }).order("id", { ascending: false })) as unknown as TicketDbRow[];
        return rows.map((t): Ticket => ({
          id: t.id, eventId: t.event_id, eventTitle: t.event?.title ?? null, eventStartsAt: t.event?.starts_at ?? null, status: t.status,
          amountCents: t.amount_cents, currency: t.currency, createdAt: t.created_at, expiresAt: t.expires_at, paidAt: t.paid_at, refundedAt: t.refunded_at,
        }));
      },
      async ticketSummary(ownerId, eventId) {
        const [r] = unwrap(await supabase.rpc("event_ticket_summary", { p_event: eventId })) as { paid: number; pending: number; refunded: number; revenue_cents: number }[];
        const ev = unwrap(await supabase.from("events").select("creator_id").eq("id", eventId).maybeSingle()) as { creator_id: string | null } | null;
        if (!r || !ev || ev.creator_id !== ownerId) return null;
        return { paid: r.paid, pending: r.pending, refunded: r.refunded, revenueCents: r.revenue_cents };
      },
      async customerOf(userId) {
        const row = unwrap(await supabase.from("stripe_customers").select("customer_id").eq("user_id", userId).maybeSingle()) as { customer_id: string } | null;
        return row?.customer_id ?? null;
      },
      async hostAccountOf(userId) {
        const row = unwrap(await supabase.from("host_accounts").select("stripe_account_id").eq("user_id", userId).maybeSingle()) as { stripe_account_id: string } | null;
        return row?.stripe_account_id ?? null;
      },
      async attachCheckout(ticketId, sessionId) {
        unwrap(await supabase.rpc("attach_checkout_session", { p_ticket: ticketId, p_session: sessionId }));
      },
      async confirmTicket(sessionId, paymentIntentId, amountCents) {
        return unwrap(await supabase.rpc("confirm_ticket", { p_session: sessionId, p_payment_intent: paymentIntentId, p_amount: amountCents })) as "confirmed" | "duplicate" | "refund" | "unknown";
      },
      async expireCheckout(sessionId) {
        unwrap(await supabase.rpc("expire_checkout", { p_session: sessionId }));
      },
      async ticketsToRefund() {
        return (unwrap(await supabase.rpc("tickets_to_refund")) as { ticket_id: string; payment_intent_id: string }[]).map((r) => ({ ticketId: r.ticket_id, paymentIntentId: r.payment_intent_id }));
      },
      async markRefunded(paymentIntentId) {
        unwrap(await supabase.rpc("mark_ticket_refunded", { p_payment_intent: paymentIntentId }));
      },
      async setEntitlement(userId, status, periodEnd, subscriptionId) {
        unwrap(await supabase.rpc("set_entitlement", { p_user: userId, p_status: status, p_period_end: periodEnd, p_subscription: subscriptionId }));
      },
      async linkCustomer(userId, customerId) {
        unwrap(await supabase.rpc("link_stripe_customer", { p_user: userId, p_customer: customerId }));
      },
      async setHostAccount(userId, accountId, chargesEnabled) {
        unwrap(await supabase.rpc("set_host_account", { p_user: userId, p_account: accountId, p_charges_enabled: chargesEnabled }));
      },
      async recordStripeEvent(id, type, objectId) {
        return Boolean(unwrap(await supabase.rpc("record_stripe_event", { p_id: id, p_type: type, p_object: objectId })));
      },
    },

    limits: {
      async consume(_userId, action) {
        // Its own transaction: the count sticks even though nothing else is written.
        // Trip plans go through consume_trip_plan(), which knows the Plus quota.
        if (action === "trip_plans") unwrap(await supabase.rpc("consume_trip_plan"));
        else unwrap(await supabase.rpc("check_rate_limit", { p_action: action }));
      },
    },

    recommendations: {
      async places(_viewerId, opts = {}) {
        const near = validateNear(opts.near);
        // Ids in order, under RLS; then the full rows (still under RLS) by id.
        const ranked = unwrap(await supabase.rpc("recommend_places", { p_lat: near?.lat ?? null, p_lng: near?.lng ?? null, p_limit: clampLimit(opts.limit, 12, 50) })) as RecRow<"place_id">[];
        if (!ranked.length) return [];
        const rows = unwrap(await supabase.from("places").select(PLACE_SELECT).in("id", ranked.map((r) => r.place_id))) as PlaceRow[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ranked.flatMap((r) => {
          const row = byId.get(r.place_id);
          return row ? [{ item: mapPlace(row), score: Number(r.score), reason: { kind: r.reason_kind, text: r.reason_text, ref: r.reason_ref } }] : [];
        });
      },
      async events(_viewerId, opts = {}) {
        const near = validateNear(opts.near);
        const ranked = unwrap(await supabase.rpc("recommend_events", {
          p_lat: near?.lat ?? null, p_lng: near?.lng ?? null, p_limit: clampLimit(opts.limit, 12, 50), p_now: opts.now ?? new Date().toISOString(),
        })) as RecRow<"event_id">[];
        if (!ranked.length) return [];
        const rows = unwrap(await supabase.from("events").select(EVENT_SELECT).in("id", ranked.map((r) => r.event_id))) as EventRow[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        return ranked.flatMap((r) => {
          const row = byId.get(r.event_id);
          return row ? [{ item: mapEvent(row), score: Number(r.score), reason: { kind: r.reason_kind, text: r.reason_text, ref: r.reason_ref } }] : [];
        });
      },
    },

    reputation: {
      async reset(_moderatorId, userId, reason) {
        unwrap(await supabase.rpc("reset_reputation", { p_user: userId, p_reason: reason }));
      },
      async refreshAll() {
        // Service role only (the cron route uses the admin client).
        const { data, error } = await supabase.rpc("refresh_all_reputation");
        if (error) throw translate(error);
        return Number(data ?? 0);
      },
    },

    admin: {
      async isAdmin(userId) {
        if (!userId) return false;
        const { data, error } = await supabase.rpc("is_admin");
        if (error) throw translate(error);
        return data === true;
      },
      async isSuspended(userId) {
        const rows = unwrap(await supabase.from("suspensions").select("user_id").eq("user_id", userId)) as { user_id: string }[];
        return rows.length > 0;
      },
      async users(_viewerId, opts = {}) {
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const rows = unwrap(await supabase.rpc("admin_users", { p_query: opts.query || null, p_after_created: after?.key ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 })) as {
          id: string; username: string; display_name: string; home_city: string | null; created_at: string; reputation_level: AdminUser["reputationLevel"];
          is_moderator: boolean; is_admin: boolean; suspended: boolean; places: number; events: number; reports_against: number;
        }[];
        return toPage(rows, limit, (r) => ({
          id: r.id, username: r.username, displayName: r.display_name, homeCity: r.home_city, createdAt: r.created_at, reputationLevel: r.reputation_level,
          isModerator: r.is_moderator, isAdmin: r.is_admin, suspended: r.suspended, places: r.places, events: r.events, reportsAgainst: r.reports_against,
        }), (r) => ({ key: r.created_at, id: r.id }));
      },
      async content(_viewerId, opts = {}) {
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const rows = unwrap(await supabase.rpc("admin_content", {
          p_kind: opts.kind ?? "place", p_status: opts.status || null, p_query: opts.query || null, p_creator: opts.creatorId || null,
          p_after_created: after?.key ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1,
        })) as { kind: "place" | "event"; id: string; label: string; status: string; visibility: string | null; city: string | null; creator_id: string | null; creator_username: string | null; created_at: string; open_reports: number; actions: number }[];
        return toPage(rows, limit, (r) => ({
          kind: r.kind, id: r.id, label: r.label, status: r.status, visibility: r.visibility, city: r.city, creatorId: r.creator_id,
          creatorUsername: r.creator_username, createdAt: r.created_at, openReports: r.open_reports, actions: r.actions,
        }), (r) => ({ key: r.created_at, id: r.id }));
      },
      async rateLimitHits() {
        const rows = unwrap(await supabase.rpc("admin_rate_limit_hits")) as { action: string; users_at_limit: number; max_count: number; window_seconds: number }[];
        return rows.map((r) => ({ action: r.action, usersAtLimit: r.users_at_limit, maxCount: r.max_count, windowSeconds: r.window_seconds }));
      },
      async history(_viewerId, target) {
        const all: AdminHistoryEntry[] = [];
        let after: { key: string; id: string } | null = null;
        // Every page, 200 at a time, on (created_at, id).
        for (;;) {
          const rows = unwrap(await supabase.rpc("admin_history", {
            p_target_type: target.type, p_target_id: target.id ?? null, p_target_key: target.key ?? null,
            p_after_created: after?.key ?? null, p_after_id: after?.id ?? null, p_limit: 200,
          })) as { id: string; action: AdminHistoryEntry["action"]; reason: string | null; status_before: string | null; status_after: string | null; created_at: string; moderator_username: string | null }[];
          all.push(...rows.map((r) => ({ id: r.id, action: r.action, reason: r.reason, statusBefore: r.status_before, statusAfter: r.status_after, createdAt: r.created_at, moderatorUsername: r.moderator_username })));
          if (rows.length < 200) return all;
          const last = rows[rows.length - 1];
          after = { key: last.created_at, id: last.id };
        }
      },
      async setSuspended(_adminId, userId, suspended, reason) {
        unwrap(await supabase.rpc("admin_set_suspended", { p_user: userId, p_suspended: suspended, p_reason: reason }));
      },
      async setModerator(_adminId, userId, moderator, reason) {
        unwrap(await supabase.rpc("admin_set_moderator", { p_user: userId, p_moderator: moderator, p_reason: reason }));
      },
      async taxonomy() {
        const [cats, ints] = await Promise.all([
          supabase.from("categories").select("slug, label, emoji, color, scope, sort_order, retired").order("sort_order").order("slug"),
          supabase.from("interests").select("slug, label, emoji, sort_order, retired").order("sort_order").order("slug"),
        ]);
        if (cats.error) throw translate(cats.error);
        if (ints.error) throw translate(ints.error);
        return [
          ...((cats.data ?? []) as { slug: string; label: string; emoji: string; color: string; scope: "place" | "event" | "both"; sort_order: number; retired: boolean }[])
            .map((c) => ({ kind: "category" as const, slug: c.slug, label: c.label, emoji: c.emoji, sortOrder: c.sort_order, retired: c.retired, color: c.color, scope: c.scope })),
          ...((ints.data ?? []) as { slug: string; label: string; emoji: string; sort_order: number; retired: boolean }[])
            .map((t) => ({ kind: "interest" as const, slug: t.slug, label: t.label, emoji: t.emoji, sortOrder: t.sort_order, retired: t.retired })),
        ];
      },
      async upsertTaxonomy(_adminId, entry, reason) {
        unwrap(await supabase.rpc("admin_upsert_taxonomy", {
          p_kind: entry.kind, p_slug: entry.slug, p_label: entry.label, p_emoji: entry.emoji, p_sort_order: entry.sortOrder,
          p_color: entry.color ?? null, p_scope: entry.scope ?? null, p_reason: reason,
        }));
      },
      async setTaxonomyRetired(_adminId, kind, slug, retired, reason) {
        unwrap(await supabase.rpc("admin_set_taxonomy_retired", { p_kind: kind, p_slug: slug, p_retired: retired, p_reason: reason }));
      },
    },

    storage: {
      async uploadImage(image, folder, ownerId) {
        const bucket = folder === "avatars" ? "avatars" : PLACE_PHOTO_BUCKET;
        // Everything stored has been through the image pipeline, which emits WebP.
        const objectPath = `${ownerId}/${crypto.randomUUID()}.webp`;
        const objects: [string, Uint8Array<ArrayBuffer>][] = [[objectPath, image.main]];
        for (const size of ["md", "sm"] as const) {
          const bytes = image.variants?.[size];
          if (bytes) objects.push([photoVariantPath(objectPath, size), bytes]);
        }
        const stored: string[] = [];
        for (const [path, bytes] of objects) {
          const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType: "image/webp", upsert: false });
          if (error) {
            // No half-stored photo: a missing size would fall back to the full-size object forever.
            if (stored.length) await supabase.storage.from(bucket).remove(stored);
            throw new DataError(`Upload failed: ${error.message}`, "unavailable");
          }
          stored.push(path);
        }
        const url = folder === "avatars"
          ? supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl
          : placePhotoReference(objectPath);
        return { url, storagePath: objectPath };
      },
      async deliverPlacePhoto(objectPath) {
        // Bytes are delivered through the authorized route, so revocation is
        // immediate: no reusable signed URL outlives a visibility change. The
        // download itself runs under the viewer's session, so the
        // storage.objects policy re-applies place visibility independently of
        // the route's row lookup.
        const { data, error } = await supabase.storage.from(PLACE_PHOTO_BUCKET).download(objectPath);
        if (error || !data) return null;
        const body = new Uint8Array(await data.arrayBuffer());
        return { kind: "bytes", body, contentType: sniffImageType(body) };
      },
      async removeImage(folder, storagePath) {
        const bucket = folder === "avatars" ? "avatars" : PLACE_PHOTO_BUCKET;
        const paths = folder === "places" ? photoObjectPaths(storagePath) : [storagePath];
        // Storage ignores paths that do not exist, so legacy photos without sizes are fine.
        const { error } = await supabase.storage.from(bucket).remove(paths);
        if (error) throw new DataError(`Image removal failed: ${error.message}`, "unavailable");
      },
    },
  };
  return repo;
}
