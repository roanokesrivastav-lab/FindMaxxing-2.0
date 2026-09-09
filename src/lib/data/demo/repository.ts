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
  type ReportEntry,
  type UserActivity,
} from "../types";
import { getDemoStore, isLocalOfCity, recomputeRating, type DemoState, type EventRow, type PlaceRow, type ProfileRow, type ReportRow, type StoreHandle } from "./store";
import { newId } from "@/lib/utils/ids";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const UPLOAD_DIR = path.join(process.cwd(), ".data", "uploads");

function summary(p: ProfileRow): ProfileSummary {
  return { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl };
}

function profileOf(state: DemoState, id: string | null): ProfileSummary | null {
  if (!id) return null;
  const p = state.profiles.find((x) => x.id === id);
  return p ? summary(p) : null;
}

function toProfile(state: DemoState, p: ProfileRow): Profile {
  return {
    ...summary(p),
    bio: p.bio,
    homeCity: p.homeCity,
    interests: state.profileInterests.filter((x) => x.profileId === p.id).map((x) => x.interestSlug),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function toPlace(state: DemoState, row: PlaceRow): Place {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    localTip: row.localTip,
    categorySlug: row.categorySlug,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    neighborhood: row.neighborhood,
    city: row.city,
    creatorId: row.creatorId,
    creator: profileOf(state, row.creatorId),
    ratingAvg: row.ratingAvg,
    ratingCount: row.ratingCount,
    tags: state.placeTags.filter((t) => t.placeId === row.id).map((t) => t.interestSlug),
    photos: state.placePhotos
      .filter((ph) => ph.placeId === row.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((ph) => ({ id: ph.id, url: ph.url, storagePath: ph.storagePath, uploaderId: ph.uploaderId })),
    status: row.status,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvent(state: DemoState, row: EventRow): Event {
  const place = row.placeId ? state.places.find((p) => p.id === row.placeId) : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    placeId: row.placeId,
    placeName: place?.name ?? null,
    locationName: row.locationName,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    creatorId: row.creatorId,
    creator: profileOf(state, row.creatorId),
    categorySlug: row.categorySlug,
    capacity: row.capacity,
    attendeeCount: state.eventAttendees.filter((a) => a.eventId === row.id).length,
    tags: state.eventTags.filter((t) => t.eventId === row.id).map((t) => t.interestSlug),
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Whether a viewer may see a place. Mirrors the "visible places" RLS policy:
 * creators always see their own; everyone else needs a published row that is
 * either public, or locals-only with the viewer qualifying as a local.
 */
function canViewPlace(state: DemoState, p: PlaceRow, viewerId: string | null): boolean {
  if (viewerId && p.creatorId === viewerId) return true;
  if (p.status !== "published") return false;
  if (p.visibility === "public") return true;
  if (p.visibility === "locals") return isLocalOfCity(state, viewerId, p.city);
  return false;
}

/** Public-only gate, for paths with no viewer context (counts, link targets). */
/** Resolves a report row for display, without exposing who filed it. */
function toReportEntry(state: DemoState, r: ReportRow): ReportEntry {
  const label =
    r.targetType === "place"
      ? (state.places.find((p) => p.id === r.targetId)?.name ?? null)
      : r.targetType === "event"
        ? (state.events.find((e) => e.id === r.targetId)?.title ?? null)
        : (state.profiles.find((p) => p.id === r.targetId)?.displayName ?? null);
  return {
    id: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    details: r.details,
    status: r.status,
    createdAt: r.createdAt,
    targetLabel: label,
  };
}

const visiblePlace = (p: PlaceRow) => p.status === "published" && p.visibility === "public";
const visibleEvent = (e: EventRow) => e.status === "published";

function canViewEvent(state: DemoState, event: EventRow, viewerId: string | null): boolean {
  if (viewerId && event.creatorId === viewerId) return true;
  if (event.status === "cancelled") {
    return !!viewerId && state.eventAttendees.some((a) => a.eventId === event.id && a.userId === viewerId);
  }
  if (event.status !== "published") return false;
  if (!event.placeId) return true;
  const place = state.places.find((p) => p.id === event.placeId);
  return !!place && canViewPlace(state, place, viewerId);
}

function eventEndOrStart(e: EventRow) {
  return new Date(e.endsAt ?? e.startsAt).getTime();
}

function byStart(a: EventRow, b: EventRow) {
  return a.startsAt.localeCompare(b.startsAt);
}

export function createDemoRepository(handle: StoreHandle = getDemoStore()): DataRepository {
  const { state, persist } = handle;

  const requireProfile = (id: string) => {
    const p = state.profiles.find((x) => x.id === id);
    if (!p) throw new DataError("Profile not found", "not_found");
    return p;
  };

  const repo: DataRepository = {
    places: {
      async list(opts: PlaceListOptions = {}) {
        const limit = opts.limit ?? 500;
        const viewerId = opts.viewerId ?? null;
        return state.places
          .filter((p) => canViewPlace(state, p, viewerId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((p) => toPlace(state, p));
      },
      async get(id, viewerId = null) {
        const row = state.places.find((p) => p.id === id);
        if (!row) return null;
        if (!canViewPlace(state, row, viewerId)) return null;
        const place = toPlace(state, row);
        const mine = viewerId
          ? (state.placeRatings.find((r) => r.placeId === id && r.userId === viewerId) ?? null)
          : null;
        const detail: PlaceDetail = {
          ...place,
          viewerSaved: viewerId ? state.savedPlaces.some((s) => s.placeId === id && s.userId === viewerId) : false,
          viewerRating: mine?.score ?? null,
          viewerRatingNote: mine?.note ?? null,
          saveCount: state.savedPlaces.filter((s) => s.placeId === id).length,
          viewerIsLocal: isLocalOfCity(state, viewerId, row.city),
        };
        return detail;
      },
      async create(input, creatorId) {
        requireProfile(creatorId);
        if ((input.photos?.length ?? 0) > MAX_PLACE_PHOTOS) {
          throw new DataError(`A place can have at most ${MAX_PLACE_PHOTOS} photos`, "invalid");
        }
        const now = new Date().toISOString();
        const row: PlaceRow = {
          id: newId(),
          name: input.name,
          description: input.description,
          localTip: input.localTip ?? null,
          categorySlug: input.categorySlug,
          lat: input.lat,
          lng: input.lng,
          address: input.address ?? null,
          neighborhood: input.neighborhood ?? null,
          city: input.city,
          creatorId,
          ratingAvg: 0,
          ratingCount: 0,
          status: "published",
          visibility: input.visibility ?? "public",
          createdAt: now,
          updatedAt: now,
        };
        state.places.push(row);
        for (const t of input.tags) state.placeTags.push({ placeId: row.id, interestSlug: t });
        (input.photos ?? []).forEach((image, i) => {
          state.placePhotos.push({
            id: newId(),
            placeId: row.id,
            url: image.url,
            storagePath: image.storagePath ?? null,
            uploaderId: creatorId,
            sortOrder: i,
            createdAt: now,
          });
        });
        persist();
        return toPlace(state, row);
      },
      async update(id, input, creatorId) {
        const place = state.places.find((p) => p.id === id);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== creatorId) throw new DataError("You don't have permission to edit this place", "forbidden");
        Object.assign(place, {
          name: input.name,
          description: input.description,
          localTip: input.localTip ?? null,
          categorySlug: input.categorySlug,
          lat: input.lat,
          lng: input.lng,
          address: input.address ?? null,
          neighborhood: input.neighborhood ?? null,
          city: input.city,
          ...(input.visibility ? { visibility: input.visibility } : {}),
          updatedAt: new Date().toISOString(),
        });
        state.placeTags = state.placeTags.filter((t) => t.placeId !== id);
        for (const tag of input.tags) state.placeTags.push({ placeId: id, interestSlug: tag });
        persist();
        return toPlace(state, place);
      },
      async delete(id, creatorId) {
        const place = state.places.find((p) => p.id === id);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== creatorId) throw new DataError("You don't have permission to delete this place", "forbidden");
        const photos = state.placePhotos.filter((p) => p.placeId === id);
        for (const photo of photos) {
          if (photo.storagePath) {
            try { unlinkSync(path.join(UPLOAD_DIR, path.basename(photo.storagePath))); } catch { /* already removed */ }
          }
        }
        state.places = state.places.filter((p) => p.id !== id);
        state.placeTags = state.placeTags.filter((t) => t.placeId !== id);
        state.placePhotos = state.placePhotos.filter((p) => p.placeId !== id);
        state.placeRatings = state.placeRatings.filter((r) => r.placeId !== id);
        state.savedPlaces = state.savedPlaces.filter((s) => s.placeId !== id);
        // Match ON DELETE SET NULL for linked events while preserving their snapshot location fields.
        for (const event of state.events) if (event.placeId === id) event.placeId = null;
        persist();
      },
      async addPhotos(placeId, images, uploaderId) {
        if (!images.length) return;
        requireProfile(uploaderId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place) throw new DataError("Place not found", "not_found");
        if (!canViewPlace(state, place, uploaderId)) throw new DataError("Place not found", "not_found");
        const existing = state.placePhotos.filter((p) => p.placeId === placeId).length;
        if (existing + images.length > MAX_PLACE_PHOTOS) {
          throw new DataError(
            `A place can have at most ${MAX_PLACE_PHOTOS} photos (${MAX_PLACE_PHOTOS - existing} slot(s) left)`,
            "invalid",
          );
        }
        const now = new Date().toISOString();
        images.forEach((image, i) => {
          state.placePhotos.push({
            id: newId(),
            placeId,
            url: image.url,
            storagePath: image.storagePath ?? null,
            uploaderId,
            sortOrder: existing + i,
            createdAt: now,
          });
        });
        persist();
      },
      async setStatus(placeId, status, ownerId) {
        const place = state.places.find((p) => p.id === placeId);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== ownerId) throw new DataError("You don't own this place", "forbidden");
        if (status !== "published" && status !== "hidden") throw new DataError("Invalid status", "invalid");
        place.status = status;
        place.updatedAt = new Date().toISOString();
        persist();
      },
      async setVisibility(placeId, visibility, ownerId) {
        const place = state.places.find((p) => p.id === placeId);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== ownerId) throw new DataError("You don't own this place", "forbidden");
        place.visibility = visibility;
        place.updatedAt = new Date().toISOString();
        persist();
      },
      async listRatings(placeId, viewerId = null) {
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, viewerId)) return [];
        return state.placeRatings
          .filter((r) => r.placeId === placeId && r.note && r.note.trim().length > 0)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((r) => ({
            id: r.id,
            score: r.score,
            note: r.note,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            user: profileOf(state, r.userId),
          }));
      },
      async removePhoto(placeId, photoId, uploaderId) {
        const photo = state.placePhotos.find((p) => p.id === photoId && p.placeId === placeId);
        if (!photo) throw new DataError("Photo not found", "not_found");
        const place = state.places.find((p) => p.id === placeId);
        if (photo.uploaderId !== uploaderId && place?.creatorId !== uploaderId) {
          throw new DataError("Only the uploader or place owner can remove this photo", "forbidden");
        }
        state.placePhotos = state.placePhotos.filter((p) => p.id !== photoId);
        persist();
        return { storagePath: photo.storagePath };
      },
      async listByCreator(userId, viewerId = null) {
        return state.places
          .filter((p) => p.creatorId === userId && p.status !== "removed" && canViewPlace(state, p, viewerId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((p) => toPlace(state, p));
      },
      async listSaved(userId) {
        const saved = state.savedPlaces
          .filter((s) => s.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return saved
          .map((s) => state.places.find((p) => p.id === s.placeId))
          .filter((p): p is PlaceRow => !!p && canViewPlace(state, p, userId))
          .map((p) => toPlace(state, p));
      },
      async save(userId, placeId) {
        requireProfile(userId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        // Unique (user_id, place_id): idempotent.
        if (state.savedPlaces.some((s) => s.userId === userId && s.placeId === placeId)) return;
        state.savedPlaces.push({ userId, placeId, createdAt: new Date().toISOString() });
        persist();
      },
      async unsave(userId, placeId) {
        const idx = state.savedPlaces.findIndex((s) => s.userId === userId && s.placeId === placeId);
        if (idx >= 0) {
          state.savedPlaces.splice(idx, 1);
          persist();
        }
      },
      async rate(userId, placeId, score, note) {
        requireProfile(userId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        if (!Number.isInteger(score) || score < 1 || score > 5) throw new DataError("Rating must be 1–5");
        const now = new Date().toISOString();
        const existing = state.placeRatings.find((r) => r.placeId === placeId && r.userId === userId);
        if (existing) {
          existing.score = score;
          existing.note = note;
          existing.updatedAt = now;
        } else {
          state.placeRatings.push({ id: newId(), placeId, userId, score, note, createdAt: now, updatedAt: now });
        }
        recomputeRating(state, placeId);
        persist();
        return { ratingAvg: place.ratingAvg, ratingCount: place.ratingCount };
      },
      async removeRating(userId, placeId) {
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        state.placeRatings = state.placeRatings.filter((r) => !(r.placeId === placeId && r.userId === userId));
        recomputeRating(state, placeId);
        persist();
        return { ratingAvg: place.ratingAvg, ratingCount: place.ratingCount };
      },
    },

    events: {
      async list(opts: EventListOptions = {}) {
        const now = Date.now();
        const limit = opts.limit ?? 500;
        const viewerId = opts.viewerId ?? null;
        return state.events
          .filter((event) => canViewEvent(state, event, viewerId) && event.status === "published")
          .filter((e) => opts.includePast || eventEndOrStart(e) >= now - 60 * 60_000)
          .sort(byStart)
          .slice(0, limit)
          .map((e) => toEvent(state, e));
      },
      async get(id, viewerId = null) {
        const row = state.events.find((e) => e.id === id);
        if (!row) return null;
        if (!canViewEvent(state, row, viewerId)) return null;
        const attendees = state.eventAttendees
          .filter((a) => a.eventId === id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((a) => profileOf(state, a.userId))
          .filter((p): p is ProfileSummary => !!p);
        const detail: EventDetail = {
          ...toEvent(state, row),
          viewerJoined: viewerId ? state.eventAttendees.some((a) => a.eventId === id && a.userId === viewerId) : false,
          attendees,
        };
        return detail;
      },
      async create(input, creatorId) {
        requireProfile(creatorId);
        if (input.placeId && !state.places.some((p) => p.id === input.placeId && canViewPlace(state, p, creatorId))) {
          throw new DataError("Linked place not found", "not_found");
        }
        const now = new Date().toISOString();
        const row: EventRow = {
          id: newId(),
          title: input.title,
          description: input.description,
          placeId: input.placeId ?? null,
          locationName: input.locationName,
          address: input.address ?? null,
          lat: input.lat,
          lng: input.lng,
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          creatorId,
          categorySlug: input.categorySlug,
          capacity: input.capacity ?? null,
          status: "published",
          createdAt: now,
          updatedAt: now,
        };
        state.events.push(row);
        for (const t of input.tags) state.eventTags.push({ eventId: row.id, interestSlug: t });
        // Creators attend their own events by default.
        state.eventAttendees.push({ eventId: row.id, userId: creatorId, createdAt: now });
        persist();
        return toEvent(state, row);
      },
      async update(id, input, creatorId) {
        const ev = state.events.find((e) => e.id === id);
        if (!ev) throw new DataError("Event not found", "not_found");
        if (ev.creatorId !== creatorId) throw new DataError("You don't have permission to edit this event", "forbidden");
        if (ev.status !== "published" || eventEndOrStart(ev) <= Date.now()) throw new DataError("Only future published events can be edited", "invalid");
        if (input.placeId && !state.places.some((p) => p.id === input.placeId && canViewPlace(state, p, creatorId))) throw new DataError("Linked place not found", "not_found");
        const attendeeCount = state.eventAttendees.filter((a) => a.eventId === id).length;
        if (input.capacity !== null && input.capacity !== undefined && input.capacity < attendeeCount) {
          throw new DataError("capacity cannot be below the existing attendee count", "invalid");
        }
        Object.assign(ev, {
          title: input.title,
          description: input.description,
          placeId: input.placeId ?? null,
          locationName: input.locationName,
          address: input.address ?? null,
          lat: input.lat,
          lng: input.lng,
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? null,
          categorySlug: input.categorySlug,
          capacity: input.capacity ?? null,
          updatedAt: new Date().toISOString(),
        });
        state.eventTags = state.eventTags.filter((t) => t.eventId !== id);
        for (const tag of input.tags) state.eventTags.push({ eventId: id, interestSlug: tag });
        persist();
        return toEvent(state, ev);
      },
      async cancel(id, creatorId) {
        const ev = state.events.find((e) => e.id === id);
        if (!ev) throw new DataError("Event not found", "not_found");
        if (ev.creatorId !== creatorId) throw new DataError("You don't have permission to cancel this event", "forbidden");
        if (ev.status !== "published" || eventEndOrStart(ev) <= Date.now()) throw new DataError("Only future published events can be cancelled", "invalid");
        ev.status = "cancelled";
        ev.updatedAt = new Date().toISOString();
        persist();
      },
      async delete(id, creatorId) {
        const ev = state.events.find((e) => e.id === id);
        if (!ev) throw new DataError("Event not found", "not_found");
        if (ev.creatorId !== creatorId) throw new DataError("You don't have permission to delete this event", "forbidden");
        const otherAttendees = state.eventAttendees.filter((a) => a.eventId === id && a.userId !== creatorId).length;
        if (otherAttendees) throw new DataError("Events with other attendees must be cancelled instead", "conflict");
        state.events = state.events.filter((e) => e.id !== id);
        state.eventTags = state.eventTags.filter((t) => t.eventId !== id);
        state.eventAttendees = state.eventAttendees.filter((a) => a.eventId !== id);
        persist();
      },
      async join(userId, eventId) {
        requireProfile(userId);
        const ev = state.events.find((e) => e.id === eventId);
        if (!ev || !canViewEvent(state, ev, userId) || ev.status !== "published") throw new DataError("Event not found", "not_found");
        if (eventEndOrStart(ev) < Date.now()) throw new DataError("This event has already ended", "invalid");
        if (state.eventAttendees.some((a) => a.eventId === eventId && a.userId === userId)) return;
        const count = state.eventAttendees.filter((a) => a.eventId === eventId).length;
        if (ev.capacity !== null && count >= ev.capacity) throw new DataError("This event is full", "full");
        state.eventAttendees.push({ eventId, userId, createdAt: new Date().toISOString() });
        persist();
      },
      async leave(userId, eventId) {
        const idx = state.eventAttendees.findIndex((a) => a.eventId === eventId && a.userId === userId);
        if (idx >= 0) {
          state.eventAttendees.splice(idx, 1);
          persist();
        }
      },
      async listByCreator(userId, viewerId = null) {
        return state.events
          .filter((e) => e.creatorId === userId && e.status !== "removed" && canViewEvent(state, e, viewerId))
          .sort(byStart)
          .map((e) => toEvent(state, e));
      },
      async listJoined(userId, viewerId = null) {
        const ids = new Set(state.eventAttendees.filter((a) => a.userId === userId).map((a) => a.eventId));
        // A caller asking for its own activity may omit the viewer context.
        // Treat the subject as the viewer so cancelled and private activity
        // follows the same access rules as the Supabase session.
        const viewer = viewerId ?? userId;
        return state.events
          .filter((e) => ids.has(e.id) && canViewEvent(state, e, viewer))
          .sort(byStart)
          .map((e) => toEvent(state, e));
      },
      async listForPlace(placeId) {
        const now = Date.now();
        return state.events
          .filter((e) => e.placeId === placeId && visibleEvent(e) && eventEndOrStart(e) >= now)
          .sort(byStart)
          .map((e) => toEvent(state, e));
      },
    },

    profiles: {
      async getById(id) {
        const p = state.profiles.find((x) => x.id === id);
        return p ? toProfile(state, p) : null;
      },
      async getByUsername(username) {
        const p = state.profiles.find((x) => x.username === username.toLowerCase());
        return p ? toProfile(state, p) : null;
      },
      async update(userId, input) {
        const p = requireProfile(userId);
        const taken = state.profiles.some((x) => x.username === input.username && x.id !== userId);
        if (taken) throw new DataError("That username is taken", "conflict");
        p.username = input.username;
        p.displayName = input.displayName;
        p.bio = input.bio;
        p.homeCity = input.homeCity;
        if (input.avatarUrl !== undefined) p.avatarUrl = input.avatarUrl;
        p.updatedAt = new Date().toISOString();
        state.profileInterests = state.profileInterests.filter((x) => x.profileId !== userId);
        for (const i of input.interests) state.profileInterests.push({ profileId: userId, interestSlug: i });
        persist();
        return toProfile(state, p);
      },
      async stats(userId) {
        return {
          places: state.places.filter((p) => p.creatorId === userId && visiblePlace(p)).length,
          events: state.events.filter((e) => e.creatorId === userId && visibleEvent(e)).length,
          followers: state.follows.filter((f) => f.followingId === userId).length,
          following: state.follows.filter((f) => f.followerId === userId).length,
        } satisfies ProfileStats;
      },
      async isFollowing(followerId, followingId) {
        return state.follows.some((f) => f.followerId === followerId && f.followingId === followingId);
      },
      async follow(followerId, followingId) {
        if (followerId === followingId) throw new DataError("You can't follow yourself");
        requireProfile(followerId);
        requireProfile(followingId);
        if (await repo.profiles.isFollowing(followerId, followingId)) return;
        state.follows.push({ followerId, followingId, createdAt: new Date().toISOString() });
        persist();
      },
      async unfollow(followerId, followingId) {
        const idx = state.follows.findIndex((f) => f.followerId === followerId && f.followingId === followingId);
        if (idx >= 0) {
          state.follows.splice(idx, 1);
          persist();
        }
      },
      async listFollowing(userId) {
        return state.follows
          .filter((f) => f.followerId === userId)
          .map((f) => profileOf(state, f.followingId))
          .filter((p): p is ProfileSummary => !!p);
      },
      async connections(userId, kind, viewerId) {
        const ids =
          kind === "followers"
            ? state.follows.filter((f) => f.followingId === userId).map((f) => f.followerId)
            : state.follows.filter((f) => f.followerId === userId).map((f) => f.followingId);
        return ids
          .map((id) => state.profiles.find((p) => p.id === id))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({
            profile: toProfile(state, p),
            viewerFollows: viewerId
              ? state.follows.some((f) => f.followerId === viewerId && f.followingId === p.id)
              : false,
            isViewer: p.id === viewerId,
          }));
      },
      async isLocalOf(userId, city) {
        return isLocalOfCity(state, userId, city);
      },
      async activity(userId, viewerId = null) {
        const [createdPlaces, createdEvents, joinedEvents, savedPlaces] = await Promise.all([
          repo.places.listByCreator(userId, viewerId),
          repo.events.listByCreator(userId, viewerId),
          repo.events.listJoined(userId, viewerId),
          viewerId === userId ? repo.places.listSaved(userId) : Promise.resolve([]),
        ]);
        return { createdPlaces, createdEvents, joinedEvents, savedPlaces } satisfies UserActivity;
      },
      async suggest(userId, limit = 6) {
        const mine = new Set(
          userId ? state.profileInterests.filter((x) => x.profileId === userId).map((x) => x.interestSlug) : [],
        );
        const following = new Set(
          userId ? state.follows.filter((f) => f.followerId === userId).map((f) => f.followingId) : [],
        );
        return state.profiles
          .filter((p) => p.id !== userId && !following.has(p.id))
          .map((p) => {
            const theirs = state.profileInterests.filter((x) => x.profileId === p.id).map((x) => x.interestSlug);
            const overlap = theirs.filter((i) => mine.has(i)).length;
            return { p, overlap };
          })
          .sort((a, b) => b.overlap - a.overlap || a.p.createdAt.localeCompare(b.p.createdAt))
          .slice(0, limit)
          .map(({ p }) => toProfile(state, p));
      },
    },

    reports: {
      async create(input, reporterId) {
        requireProfile(reporterId);
        const exists =
          input.targetType === "place"
            ? state.places.some((p) => p.id === input.targetId)
            : input.targetType === "event"
              ? state.events.some((e) => e.id === input.targetId)
              : state.profiles.some((p) => p.id === input.targetId);
        if (!exists) throw new DataError("Target not found", "not_found");
        // One open report per (reporter, target).
        const dup = state.reports.some(
          (r) => r.reporterId === reporterId && r.targetType === input.targetType && r.targetId === input.targetId && r.status === "open",
        );
        if (dup) return;
        state.reports.push({
          id: newId(),
          reporterId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          details: input.details ?? null,
          status: "open",
          createdAt: new Date().toISOString(),
        });
        persist();
      },
      async listFiledBy(userId) {
        return state.reports
          .filter((r) => r.reporterId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((r) => toReportEntry(state, r));
      },
      async listAgainstMyContent(userId) {
        return state.reports
          .filter((r) => {
            if (r.targetType === "place") {
              return state.places.some((p) => p.id === r.targetId && p.creatorId === userId);
            }
            if (r.targetType === "event") {
              return state.events.some((e) => e.id === r.targetId && e.creatorId === userId);
            }
            return false;
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((r) => toReportEntry(state, r));
      },
    },

    storage: {
      async uploadImage(file, folder, ownerId) {
        const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
        const name = `${folder}-${ownerId.slice(0, 8)}-${newId()}.${ext}`;
        mkdirSync(UPLOAD_DIR, { recursive: true });
        writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(await file.arrayBuffer()));
        return { url: `/api/uploads/${name}`, storagePath: name };
      },
      async removeImage(folder, storagePath) {
        const filename = path.basename(storagePath);
        if (!filename.startsWith(`${folder}-`)) return;
        try { unlinkSync(path.join(UPLOAD_DIR, filename)); } catch { /* already removed */ }
      },
    },
  };

  return repo;
}
