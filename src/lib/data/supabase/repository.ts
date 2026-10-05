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
} from "../types";
import { LIST_LIMIT_ERROR, duplicateListName, normalizeListName } from "../savedLists";
import {
  DEFAULT_MAP_MARKERS,
  DEFAULT_PAGE_SIZE,
  MAX_MAP_MARKERS,
  MAX_PAGE_SIZE,
  UPCOMING_GRACE_MS,
  clampLimit,
  decodeCursor,
  normalizeFilters,
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
  };
}

/** Translate Postgres errors into user-facing DataErrors. */
function translate(error: PostgrestError): DataError {
  switch (error.code) {
    case "23505":
      return new DataError("That already exists", "conflict");
    case "23503":
      return new DataError("Related record not found", "not_found");
    case "42501":
      return new DataError("You don't have permission to do that", "forbidden");
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return new DataError("Invalid date or time", "invalid");
    case "P0001": // raise exception from our triggers
      if (/full/i.test(error.message)) return new DataError("This event is full", "full");
      if (/ended|past/i.test(error.message)) return new DataError("This event has already ended", "invalid");
      return new DataError(error.message, "invalid");
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
  if (error.code === "P0001" && error.message.includes("at most")) return new DataError(LIST_LIMIT_ERROR, "full");
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
    targetLabel: labels.get(r.target_id) ?? null,
  }));
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

const PLACE_MAP_SELECT = "id, name, category_slug, lat, lng, rating_avg, rating_count";
const EVENT_MAP_SELECT = "id, title, category_slug, lat, lng, starts_at";

export function createSupabaseRepository(supabase: SupabaseClient): DataRepository {
  const repo: DataRepository = {
    places: {
      async search(opts = {}) {
        const filters = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
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
