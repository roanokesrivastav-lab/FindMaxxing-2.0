import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import {
  DataError,
  MAX_PLACE_PHOTOS,
  type Event,
  type EventDetail,
  type EventListOptions,
  type Place,
  type PlaceDetail,
  type PlaceListOptions,
  type Profile,
  type ProfileStats,
  type ProfileSummary,
  type PlaceRating,
  type ReportEntry,
  type ConnectionEntry,
} from "../types";

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
    photos: [...(r.place_photos ?? [])].sort((a, b) => a.sort_order - b.sort_order).map((p) => ({ id: p.id, url: p.url, storagePath: p.storage_path, uploaderId: p.uploader_id })),
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
    case "P0001": // raise exception from our triggers
      if (/full/i.test(error.message)) return new DataError("This event is full", "full");
      if (/ended|past/i.test(error.message)) return new DataError("This event has already ended", "invalid");
      return new DataError(error.message, "invalid");
    default:
      return new DataError(error.message || "Something went wrong", "unavailable");
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

const UPCOMING_GRACE_MS = 60 * 60_000;

export function createSupabaseRepository(supabase: SupabaseClient): DataRepository {
  const repo: DataRepository = {
    places: {
      async list(opts: PlaceListOptions = {}) {
        const rows = unwrap(
          await supabase
            .from("places")
            .select(PLACE_SELECT)
            .eq("status", "published")
            .order("created_at", { ascending: false })
            .limit(opts.limit ?? 500),
        ) as PlaceRow[];
        return rows.map(mapPlace);
      },
      async get(id, viewerId = null) {
        const row = unwrap(await supabase.from("places").select(PLACE_SELECT).eq("id", id).maybeSingle()) as PlaceRow | null;
        if (!row) return null;
        const [saveCountRes, viewerSaveRes, viewerRatingRes] = await Promise.all([
          supabase.from("saved_places").select("*", { count: "exact", head: true }).eq("place_id", id),
          viewerId
            ? supabase.from("saved_places").select("place_id").eq("place_id", id).eq("user_id", viewerId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          viewerId
            ? supabase.from("place_ratings").select("score, note").eq("place_id", id).eq("user_id", viewerId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        const detail: PlaceDetail = {
          ...mapPlace(row),
          saveCount: saveCountRes.count ?? 0,
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
      async listByCreator(userId) {
        const rows = unwrap(
          await supabase.from("places").select(PLACE_SELECT).eq("creator_id", userId).neq("status", "removed").order("created_at", { ascending: false }),
        ) as PlaceRow[];
        return rows.map(mapPlace);
      },
      async listSaved(userId) {
        const rows = unwrap(
          await supabase
            .from("saved_places")
            .select(`created_at, place:places!saved_places_place_id_fkey(${PLACE_SELECT})`)
            .eq("user_id", userId)
            .order("created_at", { ascending: false }),
        ) as unknown as { place: PlaceRow | null }[];
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
      async list(opts: EventListOptions = {}) {
        let q = supabase.from("events").select(EVENT_SELECT).eq("status", "published").order("starts_at", { ascending: true }).limit(opts.limit ?? 500);
        if (!opts.includePast) {
          const cutoff = new Date(Date.now() - UPCOMING_GRACE_MS).toISOString();
          q = q.or(`ends_at.gte.${cutoff},and(ends_at.is.null,starts_at.gte.${cutoff})`);
        }
        return (unwrap(await q) as EventRow[]).map(mapEvent);
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
      async uploadImage(file, folder, ownerId) {
        const bucket = folder === "avatars" ? "avatars" : "place-photos";
        const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        const objectPath = `${ownerId}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from(bucket).upload(objectPath, file, { contentType: file.type, upsert: false });
        if (error) throw new DataError(`Upload failed: ${error.message}`, "unavailable");
        return { url: supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl, storagePath: objectPath };
      },
      async removeImage(folder, storagePath) {
        const bucket = folder === "avatars" ? "avatars" : "place-photos";
        const { error } = await supabase.storage.from(bucket).remove([storagePath]);
        if (error) throw new DataError(`Image removal failed: ${error.message}`, "unavailable");
      },
    },
  };
  return repo;
}
