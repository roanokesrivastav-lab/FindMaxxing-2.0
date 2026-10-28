/**
 * Data access for the app: the same tables and RPCs the web app's Supabase
 * repository uses (src/lib/data/supabase/repository.ts), under the user's
 * session. Nothing here can do more than RLS allows the signed-in person.
 */
import type { AppNotification, ConversationSummary, Event, Place, SavedList } from "@findmaxxing/shared/types";
import { stripJpegMetadata } from "./jpegMetadata";
import { requireSupabase } from "./supabase";

const PROFILE = "id, username, display_name, avatar_url";
const PLACE = `*, creator:profiles!places_creator_id_fkey(${PROFILE}), place_tags(interest_slug)`;
const EVENT = `*, creator:profiles!events_creator_id_fkey(${PROFILE}), place:places!events_place_id_fkey(name), event_tags(interest_slug), attendee_count:event_attendees(count)`;

type Row = Record<string, unknown>;
const summary = (r: Row | null | undefined) => (r ? { id: r.id as string, username: r.username as string, displayName: r.display_name as string, avatarUrl: (r.avatar_url as string | null) ?? null } : null);

function check<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export function toPlace(r: Row): Place {
  return {
    id: r.id as string, name: r.name as string, description: r.description as string, localTip: (r.local_tip as string | null) ?? null,
    categorySlug: r.category_slug as string, lat: Number(r.lat), lng: Number(r.lng), address: (r.address as string | null) ?? null,
    neighborhood: (r.neighborhood as string | null) ?? null, city: r.city as string, creatorId: (r.creator_id as string | null) ?? null,
    creator: summary(r.creator as Row), ratingAvg: Number(r.rating_avg ?? 0), ratingCount: Number(r.rating_count ?? 0),
    tags: ((r.place_tags as { interest_slug: string }[]) ?? []).map((t) => t.interest_slug), photos: [],
    status: r.status as Place["status"], visibility: r.visibility as Place["visibility"], createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export function toEvent(r: Row): Event {
  return {
    id: r.id as string, title: r.title as string, description: r.description as string, placeId: (r.place_id as string | null) ?? null,
    placeName: ((r.place as Row | null)?.name as string | undefined) ?? null, locationName: r.location_name as string, address: (r.address as string | null) ?? null,
    lat: Number(r.lat), lng: Number(r.lng), startsAt: r.starts_at as string, endsAt: (r.ends_at as string | null) ?? null,
    creatorId: (r.creator_id as string | null) ?? null, creator: summary(r.creator as Row), categorySlug: r.category_slug as string,
    capacity: (r.capacity as number | null) ?? null, attendeeCount: (r.attendee_count as { count: number }[] | undefined)?.[0]?.count ?? 0,
    tags: ((r.event_tags as { interest_slug: string }[]) ?? []).map((t) => t.interest_slug), status: r.status as Event["status"],
    createdAt: r.created_at as string, priceCents: (r.price_cents as number | null) ?? null,
  };
}

export interface Bounds { north: number; south: number; east: number; west: number }

/** Visible places in the map area, newest first (discover_places applies every visibility rule). */
export async function placesIn(bounds: Bounds, text: string | null = null): Promise<Place[]> {
  const rows = check(await requireSupabase()
    .rpc("discover_places", { p_north: bounds.north, p_south: bounds.south, p_east: bounds.east, p_west: bounds.west, p_text: text })
    .select(PLACE).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(60)) as Row[];
  return rows.map(toPlace);
}

export async function upcomingEvents(): Promise<Event[]> {
  const rows = check(await requireSupabase().from("events").select(EVENT).eq("status", "published")
    .gte("starts_at", new Date(Date.now() - 3600_000).toISOString()).order("starts_at").limit(50)) as Row[];
  return rows.map(toEvent);
}

export async function place(id: string): Promise<Place | null> {
  const row = check(await requireSupabase().from("places").select(PLACE).eq("id", id).maybeSingle()) as Row | null;
  return row ? toPlace(row) : null;
}

export async function event(id: string): Promise<(Event & { going: boolean }) | null> {
  const sb = requireSupabase();
  const row = check(await sb.from("events").select(EVENT).eq("id", id).maybeSingle()) as Row | null;
  if (!row) return null;
  const me = (await sb.auth.getUser()).data.user?.id;
  const going = me ? !!check(await sb.from("event_attendees").select("user_id").eq("event_id", id).eq("user_id", me).maybeSingle()) : false;
  return { ...toEvent(row), going };
}

export async function join(eventId: string, userId: string) {
  check(await requireSupabase().from("event_attendees").insert({ event_id: eventId, user_id: userId }));
}
export async function leave(eventId: string, userId: string) {
  check(await requireSupabase().from("event_attendees").delete().eq("event_id", eventId).eq("user_id", userId));
}

export async function lists(): Promise<SavedList[]> {
  return (check(await requireSupabase().rpc("saved_list_summaries")) as Row[]).map((r) => ({
    id: r.id as string, name: r.name as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string, placeCount: Number(r.place_count),
  }));
}
export async function savedPlaces(userId: string): Promise<Place[]> {
  const rows = check(await requireSupabase().from("saved_places").select(`created_at, place:places(${PLACE})`).eq("user_id", userId).order("created_at", { ascending: false })) as unknown as { place: Row | null }[];
  return rows.filter((r) => r.place).map((r) => toPlace(r.place!));
}
export async function save(placeId: string, userId: string) {
  const res = await requireSupabase().from("saved_places").insert({ user_id: userId, place_id: placeId });
  if (res.error && res.error.code !== "23505") throw new Error(res.error.message);
}
/** Bookmarks and adds in one transaction (add_to_saved_list). */
export async function addToList(listId: string, placeId: string) {
  check(await requireSupabase().rpc("add_to_saved_list", { p_list_id: listId, p_place_id: placeId }));
}

/**
 * A photo from the camera, stored under the user's own folder as the storage
 * policy requires, with its location and other metadata stripped first.
 */
export async function uploadPlacePhoto(userId: string, uri: string): Promise<{ url: string; storagePath: string }> {
  const sb = requireSupabase();
  const path = `${userId}/${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}.jpg`;
  const body = stripJpegMetadata(new Uint8Array(await (await fetch(uri)).arrayBuffer()));
  check(await sb.storage.from("place-photos").upload(path, body, { contentType: "image/jpeg", upsert: false }));
  return { url: `storage:place-photos/${path}`, storagePath: path };
}

export async function createPlace(input: {
  name: string; description: string; localTip: string | null; categorySlug: string; lat: number; lng: number; city: string;
  neighborhood: string | null; tags: string[]; photos: { url: string; storagePath: string }[];
}): Promise<string> {
  return check(await requireSupabase().rpc("create_place_with_details", {
    p_name: input.name, p_description: input.description, p_local_tip: input.localTip, p_category_slug: input.categorySlug,
    p_lat: input.lat, p_lng: input.lng, p_address: null, p_neighborhood: input.neighborhood, p_city: input.city,
    p_visibility: "public", p_tags: input.tags, p_photos: input.photos,
  })) as string;
}

/** Event, tags and your attendance in one transaction (0036_create_event_with_details.sql). */
export async function createEvent(input: {
  title: string; description: string; locationName: string; lat: number; lng: number; startsAt: string; categorySlug: string; capacity: number | null; tags: string[];
}): Promise<string> {
  return check(await requireSupabase().rpc("create_event_with_details", {
    p_title: input.title, p_description: input.description, p_place_id: null, p_location_name: input.locationName, p_address: null,
    p_lat: input.lat, p_lng: input.lng, p_starts_at: input.startsAt, p_ends_at: null, p_category_slug: input.categorySlug,
    p_capacity: input.capacity, p_tags: input.tags,
  })) as string;
}

export async function conversations(): Promise<ConversationSummary[]> {
  return (check(await requireSupabase().rpc("my_conversations")) as Row[]).map((r) => ({
    id: r.id as string, kind: r.kind as "direct" | "group", eventId: (r.event_id as string | null) ?? null, eventTitle: (r.event_title as string | null) ?? null,
    other: r.other_id ? { id: r.other_id as string, username: r.other_username as string, displayName: r.other_display_name as string, avatarUrl: (r.other_avatar_url as string | null) ?? null } : null,
    lastMessageAt: (r.last_message_at as string | null) ?? null, lastBody: (r.last_body as string | null) ?? null,
    lastSenderId: (r.last_sender_id as string | null) ?? null, unread: Number(r.unread),
  }));
}
export async function messages(conversationId: string): Promise<{ id: string; senderId: string; body: string; createdAt: string }[]> {
  const rows = check(await requireSupabase().rpc("conversation_messages", { p_conversation: conversationId, p_limit: 50 })) as Row[];
  return rows.map((r) => ({ id: r.id as string, senderId: r.sender_id as string, body: r.body as string, createdAt: r.created_at as string })).reverse();
}
export async function sendMessage(conversationId: string, userId: string, body: string) {
  check(await requireSupabase().from("messages").insert({ conversation_id: conversationId, sender_id: userId, body: body.trim() }));
}
export async function markRead(conversationId: string) {
  check(await requireSupabase().rpc("mark_read", { p_conversation: conversationId }));
}

export async function notifications(): Promise<AppNotification[]> {
  return (check(await requireSupabase().rpc("my_notifications", { p_limit: 50 })) as Row[]).map((r) => ({
    id: r.id as string, type: r.type as AppNotification["type"],
    actor: r.actor_id && r.actor_username ? { id: r.actor_id as string, username: r.actor_username as string, displayName: r.actor_display_name as string, avatarUrl: (r.actor_avatar_url as string | null) ?? null } : null,
    subjectType: r.subject_type as AppNotification["subjectType"], subjectId: (r.subject_id as string | null) ?? null, label: (r.label as string | null) ?? null,
    detail: (r.detail as string | null) ?? null, count: Number(r.count), createdAt: r.created_at as string, updatedAt: r.updated_at as string, readAt: (r.read_at as string | null) ?? null,
  }));
}
export async function markNotificationsRead() {
  check(await requireSupabase().rpc("mark_notifications_read", { p_ids: null }));
}

/** The phone's Expo push token, into the same table as web push (0024_expo_push.sql). */
export async function savePushToken(token: string) {
  check(await requireSupabase().rpc("save_expo_push_token", { p_token: token }));
}
/** This phone's token out of push_subscriptions, before signing out (RLS: only your own devices). */
export async function removePushToken(token: string) {
  check(await requireSupabase().from("push_subscriptions").delete().eq("kind", "expo").eq("endpoint", token));
}

export async function profile(userId: string) {
  return check(await requireSupabase().from("profiles").select("id, username, display_name, avatar_url, bio, home_city, supporter").eq("id", userId).maybeSingle()) as Row | null;
}
