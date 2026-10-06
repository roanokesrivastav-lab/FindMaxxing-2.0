import type { DataRepository } from "../repository";
import {
  DataError,
  MAX_PLACE_PHOTOS,
  type Event,
  type EventDetail,
  type Place,
  type PlaceDetail,
  type Profile,
  type ProfileStats,
  type ProfileSummary,
  type ReportEntry,
  type TagCounts,
  type UserActivity,
  type SavedList,
  type ModerationQueueItem,
  type ReportReason,
  type RemovedContent,
  FUNNEL_STEPS,
} from "../types";
import { getDemoStore, isLocalOfCity, isModeratorIn, recomputeRating, type DemoState, type EventRow, type ModerationActionRow, type PlaceRow, type ProfileRow, type ReportRow, type SavedListRow, type StoreHandle } from "./store";
import { RATE_LIMITS, rateLimitError, windowStart, type RateLimitAction } from "@/lib/rateLimits";
import { MAX_MODERATION_REASON, MODERATION_ACTIONS, REPORT_TARGET_TYPES, SUSPENDED_MESSAGE, compareModerationReports, moderationError, normalizeReason } from "../moderation";
import { homeCityCooldownMessage, nextHomeCityChange, sameCity } from "../localTier";
import { createHash } from "node:crypto";
import { LEVEL_RANK, refreshDemoReputation } from "./reputation";
import { LIST_LIMIT_ERROR, MAX_SAVED_LISTS, duplicateListName, listNameKey, normalizeListName } from "../savedLists";
import { newId } from "@/lib/utils/ids";
import { neighborhoodKey } from "@/lib/utils/neighborhoods";
import {
  DEFAULT_MAP_MARKERS,
  DEFAULT_PAGE_SIZE,
  MAX_MAP_MARKERS,
  MAX_PAGE_SIZE,
  UPCOMING_GRACE_MS,
  clampLimit,
  compareTimestamps,
  decodeCursor,
  decodeDistanceCursor,
  discoveryDistance,
  encodeDistanceCursor,
  inBounds,
  validateNear,
  normalizeFilters,
  normalizeTimestamp,
  textMatches,
  toPage,
  type NormalizedFilters,
} from "../discovery";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { placePhotoReference, placePhotoUrl, sniffImageType } from "../photos";
import { photoObjectPaths, photoVariantPath } from "@/lib/images/sizes";
import path from "node:path";

import { UPLOAD_DIR } from "./uploads";
/** Generated upload names (and their .sm/.md size siblings) only; anything else is refused before touching disk. */
export const DEMO_UPLOAD_NAME = /^(places|avatars)-[0-9a-f]{8}-[0-9a-f-]{36}(\.(sm|md))?\.(jpg|png|webp)$/;

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
    homeCityChangedAt: p.homeCityChangedAt,
    onboardedAt: p.onboardedAt,
    reputationLevel: p.reputationLevel,
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
      .map((ph) => ({ id: ph.id, url: placePhotoUrl(ph), storagePath: ph.storagePath, uploaderId: ph.uploaderId })),
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
 * Whether a viewer may see a place. Mirrors can_view_place(): creators see
 * their own unless moderators removed it; everyone else needs a published row
 * that is public, locals-only with the viewer a local, trusted-only with the
 * viewer a trusted local, or followers-only with a mutual follow.
 */
function canViewPlace(state: DemoState, p: PlaceRow, viewerId: string | null): boolean {
  if (viewerId && p.creatorId === viewerId && p.status !== "removed") return true;
  if (p.status !== "published") return false;
  if (p.visibility === "public") return true;
  if (p.visibility === "locals") return isLocalOfCity(state, viewerId, p.city);
  if (p.visibility === "trusted") {
    return isLocalOfCity(state, viewerId, p.city) && state.profiles.find((x) => x.id === viewerId)?.reputationLevel === "trusted";
  }
  if (p.visibility === "followers") {
    return !!viewerId && !!p.creatorId &&
      state.follows.some((f) => f.followerId === viewerId && f.followingId === p.creatorId) &&
      state.follows.some((f) => f.followerId === p.creatorId && f.followingId === viewerId);
  }
  return false;
}

/**
 * Resolves a report row for display, without exposing who filed it. The
 * owner-side view (reports_about_my_stuff) carries no resolution time.
 */
function toReportEntry(state: DemoState, r: ReportRow, withResolution = true): ReportEntry {
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
    resolvedAt: withResolution ? r.resolvedAt : null,
    targetLabel: label,
  };
}

/** Owners may edit only what they could set themselves: not removed or pending places. */
const ownerEditable = (p: PlaceRow) => p.status === "published" || p.status === "hidden";

const visiblePlace = (p: PlaceRow) => p.status === "published" && p.visibility === "public";
const visibleEvent = (e: EventRow) => e.status === "published";

function canViewEvent(state: DemoState, event: EventRow, viewerId: string | null): boolean {
  if (viewerId && event.creatorId === viewerId && event.status !== "removed") return true;
  if (event.status === "cancelled") {
    return !!viewerId && state.eventAttendees.some((a) => a.eventId === event.id && a.userId === viewerId);
  }
  if (event.status !== "published") return false;
  if (!event.placeId) return true;
  const place = state.places.find((p) => p.id === event.placeId);
  return !!place && canViewPlace(state, place, viewerId);
}

// ----------------------------------------------------------------------------
// Discovery: mirrors public.discover_places / public.discover_events
// ----------------------------------------------------------------------------
function placeMatches(state: DemoState, p: PlaceRow, f: NormalizedFilters, viewerId: string | null): boolean {
  if (p.status !== "published" || !canViewPlace(state, p, viewerId)) return false;
  if (!inBounds(p, f.bounds)) return false;
  if (f.category && p.categorySlug !== f.category) return false;
  if (f.neighborhood && neighborhoodKey(p.neighborhood ?? "") !== f.neighborhood) return false;
  if (f.createdAfter && compareTimestamps(p.createdAt, f.createdAfter) < 0) return false;
  const tags = state.placeTags.filter((t) => t.placeId === p.id).map((t) => t.interestSlug);
  if (f.tags.length && !tags.some((t) => f.tags.includes(t))) return false;
  const { text, categories, tags: textTags } = f.search;
  return (
    !text ||
    textMatches([p.name, p.description, p.localTip, p.neighborhood], text) ||
    categories.includes(p.categorySlug) ||
    tags.some((t) => textTags.includes(t))
  );
}

function eventMatches(
  state: DemoState,
  e: EventRow,
  f: NormalizedFilters,
  viewerId: string | null,
  cutoff: number | null,
  startsBefore: string | null = null,
): boolean {
  if (e.status !== "published" || !canViewEvent(state, e, viewerId)) return false;
  if (cutoff !== null && eventEndOrStart(e) < cutoff) return false;
  if (startsBefore && compareTimestamps(e.startsAt, startsBefore) >= 0) return false;
  if (f.createdAfter && compareTimestamps(e.createdAt, f.createdAfter) < 0) return false;
  if (!inBounds(e, f.bounds)) return false;
  if (f.category && e.categorySlug !== f.category) return false;
  if (f.neighborhood) {
    // Through the linked place, which must be published and visible to the viewer.
    const place = e.placeId ? state.places.find((p) => p.id === e.placeId) : null;
    if (!place || place.status !== "published" || !canViewPlace(state, place, viewerId) || neighborhoodKey(place.neighborhood ?? "") !== f.neighborhood) return false;
  }
  const tags = state.eventTags.filter((t) => t.eventId === e.id).map((t) => t.interestSlug);
  if (f.tags.length && !tags.some((t) => f.tags.includes(t))) return false;
  const { text, categories, tags: textTags } = f.search;
  return (
    !text ||
    textMatches([e.title, e.description, e.locationName], text) ||
    categories.includes(e.categorySlug) ||
    tags.some((t) => textTags.includes(t))
  );
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** created_at desc, id desc — the places list order. */
const newestFirst = (a: PlaceRow, b: PlaceRow) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id);
/** starts_at asc, id asc — the events list order. */
const soonestFirst = (a: EventRow, b: EventRow) => compareTimestamps(a.startsAt, b.startsAt) || compareIds(a.id, b.id);

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

  /**
   * Mirrors check_rate_limit(): refuses when the user has used up the current
   * window, and returns the increment to apply once the write succeeds (the
   * database's increment rolls back with a failed insert).
   */
  const rateLimit = (userId: string, action: RateLimitAction) => {
    const now = Date.now();
    const start = windowStart(action, now);
    const rule = RATE_LIMITS[action];
    state.rateLimits = state.rateLimits.filter((r) => !(r.userId === userId && r.action === action && r.windowStart < start));
    const row = state.rateLimits.find((r) => r.userId === userId && r.action === action && r.windowStart === start);
    if ((row?.count ?? 0) >= rule.max) {
      throw rateLimitError(action, Math.max(1, Math.ceil((start + rule.windowSeconds * 1000 - now) / 1000)));
    }
    return () => {
      if (row) row.count += 1;
      else state.rateLimits.push({ userId, action, windowStart: start, count: 1 });
    };
  };

  /** Deletes list items, touching each affected list like the database trigger. */
  const removeListItems = (match: (item: DemoState["savedListItems"][number]) => boolean) => {
    const now = new Date().toISOString();
    const touched = new Set(state.savedListItems.filter(match).map((i) => i.listId));
    state.savedListItems = state.savedListItems.filter((i) => !match(i));
    for (const list of state.savedLists) if (touched.has(list.id)) list.updatedAt = now;
  };
  const ownList = (ownerId: string, listId: string) => {
    const list = state.savedLists.find((l) => l.id === listId && l.ownerId === ownerId);
    if (!list) throw new DataError("List not found", "not_found");
    return list;
  };
  /** Places in a list the owner can open, newest membership first. */
  const listPlaces = (list: SavedListRow) =>
    state.savedListItems
      .filter((i) => i.listId === list.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || compareIds(a.placeId, b.placeId))
      .map((i) => state.places.find((p) => p.id === i.placeId))
      .filter((p): p is PlaceRow => !!p && p.status === "published" && canViewPlace(state, p, list.ownerId));
  const isAdmin = (userId: string | null) => !!userId && state.admins.some((a) => a.userId === userId);
  /** Mirrors block_suspended_writes(): a suspended account cannot write anything. */
  const assertActive = (userId: string) => {
    if (state.suspensions.some((x) => x.userId === userId)) throw new DataError(SUSPENDED_MESSAGE, "forbidden");
  };
  const requireAdmin = (adminId: string, reason: string) => {
    if (!isAdmin(adminId)) throw new DataError("Admins only", "forbidden");
    const why = normalizeReason(reason);
    if (!why) throw moderationError("reason_required");
    if (why.length > MAX_MODERATION_REASON) throw moderationError("reason_too_long");
    return why;
  };
  const audit = (adminId: string, action: ModerationActionRow["action"], targetType: ModerationActionRow["targetType"], target: { id?: string; key?: string }, reason: string, before: string | null, after: string | null) => {
    state.moderationActions.push({
      id: newId(), moderatorId: adminId, action, targetType, targetId: target.id ?? null, targetKey: target.key ?? null,
      reason, statusBefore: before, statusAfter: after, resolvedReports: 0, createdAt: new Date().toISOString(),
    });
  };

  const targetLabel = (type: ReportRow["targetType"], id: string): string | null =>
    type === "place" ? (state.places.find((p) => p.id === id)?.name ?? null)
      : type === "event" ? (state.events.find((e) => e.id === id)?.title ?? null)
        : (state.profiles.find((p) => p.id === id)?.displayName ?? null);
  const targetStatus = (type: ReportRow["targetType"], id: string): string | null =>
    type === "place" ? (state.places.find((p) => p.id === id)?.status ?? null)
      : type === "event" ? (state.events.find((e) => e.id === id)?.status ?? null)
        : state.profiles.some((p) => p.id === id) ? (state.localRevocations.some((r) => r.userId === id) ? "revoked" : "active") : null;
  /** Mirrors moderation_target(). */
  const snapshotOf = (type: ReportRow["targetType"], id: string) => {
    const ownerName = (ownerId: string | null) => (ownerId ? (state.profiles.find((p) => p.id === ownerId)?.username ?? null) : null);
    if (type === "place") {
      const p = state.places.find((x) => x.id === id);
      return p ? { label: p.name, status: p.status, visibility: p.visibility, city: p.city, neighborhood: p.neighborhood, body: p.description, extra: p.localTip, ownerId: p.creatorId, ownerUsername: ownerName(p.creatorId), createdAt: p.createdAt } : null;
    }
    if (type === "event") {
      const e = state.events.find((x) => x.id === id);
      return e ? { label: e.title, status: e.status, visibility: null, city: null, neighborhood: null, body: e.description, extra: e.locationName, ownerId: e.creatorId, ownerUsername: ownerName(e.creatorId), createdAt: e.createdAt } : null;
    }
    const pr = state.profiles.find((x) => x.id === id);
    return pr ? { label: pr.displayName, status: targetStatus("profile", id)!, visibility: null, city: pr.homeCity, neighborhood: null, body: pr.bio, extra: null, ownerId: pr.id, ownerUsername: pr.username, createdAt: pr.createdAt } : null;
  };

  const toSavedList = (list: SavedListRow): SavedList => ({
    id: list.id,
    name: list.name,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    placeCount: listPlaces(list).length,
  });

  const repo: DataRepository = {
    places: {
      async search(opts = {}) {
        const f = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const viewerId = opts.viewerId ?? null;
        const near = validateNear(opts.near);
        if (near) {
          // Mirrors discover_places_nearest: (distance, id) ascending, keyset on both.
          const afterNear = decodeDistanceCursor(opts.cursor);
          const ranked = state.places
            .filter((p) => placeMatches(state, p, f, viewerId))
            .map((p) => ({ p, d: discoveryDistance(p, near) }))
            .filter(({ p, d }) => !afterNear || d > afterNear.distance || (d === afterNear.distance && p.id > afterNear.id))
            .sort((a, b) => a.d - b.d || compareIds(a.p.id, b.p.id));
          const items = ranked.slice(0, limit);
          const last = items.at(-1);
          return {
            items: items.map(({ p }) => toPlace(state, p)),
            nextCursor: ranked.length > limit && last ? encodeDistanceCursor(last.d, last.p.id) : null,
          };
        }
        const after = decodeCursor(opts.cursor);
        const rows = state.places
          .filter((p) => placeMatches(state, p, f, viewerId))
          .filter((p) => !after || compareTimestamps(p.createdAt, after.key) < 0 || (compareTimestamps(p.createdAt, after.key) === 0 && p.id < after.id))
          .sort(newestFirst);
        return toPage(rows, limit, (p) => toPlace(state, p), (p) => ({ key: p.createdAt, id: p.id }));
      },
      async count(opts = {}) {
        const f = normalizeFilters(opts);
        const viewerId = opts.viewerId ?? null;
        return state.places.filter((p) => placeMatches(state, p, f, viewerId)).length;
      },
      async neighborhoods(opts = {}) {
        const viewerId = opts.viewerId ?? null;
        const all = normalizeFilters({});
        const groups = new Map<string, { name: string; city: string; count: number; cats: Map<string, number>; lat: number; lng: number }>();
        for (const p of state.places) {
          const key = neighborhoodKey(p.neighborhood ?? "");
          if (!key || !placeMatches(state, p, all, viewerId)) continue;
          const name = (p.neighborhood ?? "").trim();
          const g = groups.get(key) ?? { name, city: p.city, count: 0, cats: new Map(), lat: 0, lng: 0 };
          // Alphabetically first spelling and city, the same tie-break as the SQL min().
          if (compareIds(name, g.name) < 0) g.name = name;
          if (compareIds(p.city, g.city) < 0) g.city = p.city;
          g.count += 1;
          g.cats.set(p.categorySlug, (g.cats.get(p.categorySlug) ?? 0) + 1);
          g.lat += p.lat;
          g.lng += p.lng;
          groups.set(key, g);
        }
        return [...groups.entries()]
          .map(([key, g]) => ({
            key,
            name: g.name,
            city: g.city,
            placeCount: g.count,
            topCategories: [...g.cats.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0])).map(([slug]) => slug),
            lat: g.lat / g.count,
            lng: g.lng / g.count,
          }))
          .sort((a, b) => b.placeCount - a.placeCount || compareIds(a.name, b.name) || compareIds(a.key, b.key));
      },
      async mapMarkers(opts = {}) {
        const f = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
        const viewerId = opts.viewerId ?? null;
        const saves = (id: string) => state.savedPlaces.filter((s) => s.placeId === id).length;
        const rows = state.places
          .filter((p) => placeMatches(state, p, f, viewerId))
          .map((p) => ({ p, saves: saves(p.id) }))
          // Ratings, then saves, then the creator's reputation, then id: reputation is one input, never the only one.
          .sort((a, b) => b.p.ratingCount - a.p.ratingCount || b.saves - a.saves || b.p.creatorReputation - a.p.creatorReputation || compareIds(a.p.id, b.p.id));
        return {
          items: rows.slice(0, limit).map(({ p }) => ({
            id: p.id, name: p.name, categorySlug: p.categorySlug, lat: p.lat, lng: p.lng, ratingAvg: p.ratingAvg, ratingCount: p.ratingCount,
          })),
          truncated: rows.length > limit,
          limit,
        };
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
        assertActive(creatorId);
        requireProfile(creatorId);
        if ((input.photos?.length ?? 0) > MAX_PLACE_PHOTOS) {
          throw new DataError(`A place can have at most ${MAX_PLACE_PHOTOS} photos`, "invalid");
        }
        const counted = rateLimit(creatorId, "places");
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
          source: "community",
          creatorReputation: LEVEL_RANK[requireProfile(creatorId).reputationLevel],
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
        counted();
        persist();
        return toPlace(state, row);
      },
      async update(id, input, creatorId) {
        assertActive(creatorId);
        const place = state.places.find((p) => p.id === id);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== creatorId) throw new DataError("You don't have permission to edit this place", "forbidden");
        if (!ownerEditable(place)) throw new DataError("You don't own this place", "forbidden");
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
        assertActive(creatorId);
        const place = state.places.find((p) => p.id === id);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== creatorId) throw new DataError("You don't have permission to delete this place", "forbidden");
        const photos = state.placePhotos.filter((p) => p.placeId === id);
        for (const photo of photos) {
          if (photo.storagePath) await repo.storage.removeImage("places", photo.storagePath);
        }
        state.places = state.places.filter((p) => p.id !== id);
        state.placeTags = state.placeTags.filter((t) => t.placeId !== id);
        state.placePhotos = state.placePhotos.filter((p) => p.placeId !== id);
        state.placeRatings = state.placeRatings.filter((r) => r.placeId !== id);
        state.savedPlaces = state.savedPlaces.filter((s) => s.placeId !== id);
        removeListItems((i) => i.placeId === id);
        // Match ON DELETE SET NULL for linked events while preserving their snapshot location fields.
        for (const event of state.events) if (event.placeId === id) event.placeId = null;
        persist();
      },
      async addPhotos(placeId, images, uploaderId) {
        assertActive(uploaderId);
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
        assertActive(ownerId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== ownerId || !ownerEditable(place)) throw new DataError("You don't own this place", "forbidden");
        if (status !== "published" && status !== "hidden") throw new DataError("Invalid status", "invalid");
        place.status = status;
        place.updatedAt = new Date().toISOString();
        persist();
      },
      async setVisibility(placeId, visibility, ownerId) {
        assertActive(ownerId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place) throw new DataError("Place not found", "not_found");
        if (place.creatorId !== ownerId || !ownerEditable(place)) throw new DataError("You don't own this place", "forbidden");
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
        assertActive(uploaderId);
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
      async getPhotoObject(photoId, viewerId) {
        const photo = state.placePhotos.find((p) => p.id === photoId);
        if (!photo?.storagePath) return null;
        const place = state.places.find((p) => p.id === photo.placeId);
        if (!place || !canViewPlace(state, place, viewerId)) return null;
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
          // created_at desc, place_id asc: the order the Supabase repository pages in.
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || compareIds(a.placeId, b.placeId));
        return saved
          .map((s) => state.places.find((p) => p.id === s.placeId))
          .filter((p): p is PlaceRow => !!p && canViewPlace(state, p, userId))
          .map((p) => toPlace(state, p));
      },
      async save(userId, placeId) {
        assertActive(userId);
        requireProfile(userId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        // Unique (user_id, place_id): idempotent.
        if (state.savedPlaces.some((s) => s.userId === userId && s.placeId === placeId)) return;
        state.savedPlaces.push({ userId, placeId, createdAt: new Date().toISOString() });
        persist();
      },
      async unsave(userId, placeId) {
        assertActive(userId);
        const idx = state.savedPlaces.findIndex((s) => s.userId === userId && s.placeId === placeId);
        if (idx >= 0) {
          state.savedPlaces.splice(idx, 1);
          // saved_list_items cascade from the bookmark: unsaving leaves every list.
          removeListItems((i) => i.ownerId === userId && i.placeId === placeId);
          persist();
        }
      },
      async rate(userId, placeId, score, note) {
        assertActive(userId);
        requireProfile(userId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        if (!Number.isInteger(score) || score < 1 || score > 5) throw new DataError("Rating must be 1–5");
        // The upsert's insert fires the trigger even when it ends up updating.
        const counted = rateLimit(userId, "ratings");
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
        counted();
        persist();
        return { ratingAvg: place.ratingAvg, ratingCount: place.ratingCount };
      },
      async removeRating(userId, placeId) {
        assertActive(userId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, userId)) throw new DataError("Place not found", "not_found");
        state.placeRatings = state.placeRatings.filter((r) => !(r.placeId === placeId && r.userId === userId));
        recomputeRating(state, placeId);
        persist();
        return { ratingAvg: place.ratingAvg, ratingCount: place.ratingCount };
      },
    },

    events: {
      async search(opts = {}) {
        const f = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const viewerId = opts.viewerId ?? null;
        const cutoff = opts.includePast ? null : Date.now() - UPCOMING_GRACE_MS;
        const startsBefore = normalizeTimestamp(opts.startsBefore, "startsBefore");
        const rows = state.events
          .filter((e) => eventMatches(state, e, f, viewerId, cutoff, startsBefore))
          .filter((e) => !after || compareTimestamps(e.startsAt, after.key) > 0 || (compareTimestamps(e.startsAt, after.key) === 0 && e.id > after.id))
          .sort(soonestFirst);
        return toPage(rows, limit, (e) => toEvent(state, e), (e) => ({ key: e.startsAt, id: e.id }));
      },
      async count(opts = {}) {
        const f = normalizeFilters(opts);
        const cutoff = opts.includePast ? null : Date.now() - UPCOMING_GRACE_MS;
        const startsBefore = normalizeTimestamp(opts.startsBefore, "startsBefore");
        return state.events.filter((e) => eventMatches(state, e, f, opts.viewerId ?? null, cutoff, startsBefore)).length;
      },
      async mapMarkers(opts = {}) {
        const f = normalizeFilters(opts);
        const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
        const cutoff = opts.includePast ? null : Date.now() - UPCOMING_GRACE_MS;
        const rows = state.events.filter((e) => eventMatches(state, e, f, opts.viewerId ?? null, cutoff)).sort(soonestFirst);
        return {
          items: rows.slice(0, limit).map((e) => ({ id: e.id, title: e.title, categorySlug: e.categorySlug, lat: e.lat, lng: e.lng, startsAt: e.startsAt })),
          truncated: rows.length > limit,
          limit,
        };
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
        assertActive(creatorId);
        requireProfile(creatorId);
        if (input.placeId && !state.places.some((p) => p.id === input.placeId && canViewPlace(state, p, creatorId))) {
          throw new DataError("Linked place not found", "not_found");
        }
        const counted = rateLimit(creatorId, "events");
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
        counted();
        persist();
        return toEvent(state, row);
      },
      async update(id, input, creatorId) {
        assertActive(creatorId);
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
        assertActive(creatorId);
        const ev = state.events.find((e) => e.id === id);
        if (!ev) throw new DataError("Event not found", "not_found");
        if (ev.creatorId !== creatorId) throw new DataError("You don't have permission to cancel this event", "forbidden");
        if (ev.status !== "published" || eventEndOrStart(ev) <= Date.now()) throw new DataError("Only future published events can be cancelled", "invalid");
        ev.status = "cancelled";
        ev.updatedAt = new Date().toISOString();
        persist();
      },
      async delete(id, creatorId) {
        assertActive(creatorId);
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
        assertActive(userId);
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
        assertActive(userId);
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

    tags: {
      async counts(opts = {}) {
        const viewerId = opts.viewerId ?? null;
        const all = normalizeFilters({});
        const cutoff = Date.now() - UPCOMING_GRACE_MS;
        const visiblePlaces = new Set(state.places.filter((p) => placeMatches(state, p, all, viewerId)).map((p) => p.id));
        const upcomingEvents = new Set(state.events.filter((e) => eventMatches(state, e, all, viewerId, cutoff)).map((e) => e.id));
        const counts: TagCounts = {};
        const bump = (slug: string, key: "places" | "events") => {
          counts[slug] ??= { places: 0, events: 0 };
          counts[slug][key] += 1;
        };
        for (const t of state.placeTags) if (visiblePlaces.has(t.placeId)) bump(t.interestSlug, "places");
        for (const t of state.eventTags) if (upcomingEvents.has(t.eventId)) bump(t.interestSlug, "events");
        return counts;
      },
    },

    savedLists: {
      async list(ownerId) {
        return state.savedLists
          .filter((l) => l.ownerId === ownerId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || compareIds(a.id, b.id))
          .map(toSavedList);
      },
      async create(ownerId, rawName) {
        assertActive(ownerId);
        requireProfile(ownerId);
        const name = normalizeListName(rawName);
        const mine = state.savedLists.filter((l) => l.ownerId === ownerId);
        // Same order as the database: the cap trigger runs before the unique index.
        if (mine.length >= MAX_SAVED_LISTS) throw new DataError(LIST_LIMIT_ERROR, "full");
        // Then the rate limit (triggers fire in name order), then the unique index.
        const counted = rateLimit(ownerId, "lists");
        if (mine.some((l) => listNameKey(l.name) === listNameKey(name))) throw duplicateListName(name);
        const now = new Date().toISOString();
        const row: SavedListRow = { id: newId(), ownerId, name, createdAt: now, updatedAt: now };
        state.savedLists.push(row);
        counted();
        persist();
        return toSavedList(row);
      },
      async rename(ownerId, listId, rawName) {
        assertActive(ownerId);
        const list = ownList(ownerId, listId);
        const name = normalizeListName(rawName);
        const clash = state.savedLists.some((l) => l.ownerId === ownerId && l.id !== listId && listNameKey(l.name) === listNameKey(name));
        if (clash) throw duplicateListName(name);
        list.name = name;
        list.updatedAt = new Date().toISOString();
        persist();
      },
      async delete(ownerId, listId) {
        assertActive(ownerId);
        ownList(ownerId, listId);
        state.savedLists = state.savedLists.filter((l) => l.id !== listId);
        state.savedListItems = state.savedListItems.filter((i) => i.listId !== listId);
        persist();
      },
      async addPlace(ownerId, listId, placeId) {
        assertActive(ownerId);
        const list = ownList(ownerId, listId);
        const place = state.places.find((p) => p.id === placeId);
        if (!place || !canViewPlace(state, place, ownerId)) throw new DataError("Place not found", "not_found");
        const now = new Date().toISOString();
        // The bookmark first: an item is always one of the owner's saved places.
        if (!state.savedPlaces.some((s) => s.userId === ownerId && s.placeId === placeId)) {
          state.savedPlaces.push({ userId: ownerId, placeId, createdAt: now });
        }
        if (!state.savedListItems.some((i) => i.listId === listId && i.placeId === placeId)) {
          state.savedListItems.push({ listId, ownerId, placeId, createdAt: now });
          list.updatedAt = now;
        }
        persist();
      },
      async removePlace(ownerId, listId, placeId) {
        assertActive(ownerId);
        ownList(ownerId, listId);
        removeListItems((i) => i.listId === listId && i.placeId === placeId);
        persist();
      },
      async get(ownerId, listId) {
        const list = state.savedLists.find((l) => l.id === listId && l.ownerId === ownerId);
        if (!list) return null;
        return { list: toSavedList(list), places: listPlaces(list).map((p) => toPlace(state, p)) };
      },
      async memberships(ownerId, placeId) {
        return state.savedListItems.filter((i) => i.ownerId === ownerId && i.placeId === placeId).map((i) => i.listId);
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
        assertActive(userId);
        const p = requireProfile(userId);
        const taken = state.profiles.some((x) => x.username === input.username && x.id !== userId);
        if (taken) throw new DataError("That username is taken", "conflict");
        // Mirrors guard_profile_trust_columns(): one real change per 30 days.
        if (!sameCity(input.homeCity, p.homeCity)) {
          const next = nextHomeCityChange(p.homeCity, p.homeCityChangedAt);
          if (next) throw new DataError(homeCityCooldownMessage(next), "rate_limited");
          p.homeCityChangedAt = new Date().toISOString();
        }
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
      async completeOnboarding(userId) {
        assertActive(userId);
        const p = requireProfile(userId);
        if (p.onboardedAt) return;
        p.onboardedAt = new Date().toISOString();
        persist();
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
        assertActive(followerId);
        if (followerId === followingId) throw new DataError("You can't follow yourself");
        requireProfile(followerId);
        requireProfile(followingId);
        if (await repo.profiles.isFollowing(followerId, followingId)) return;
        state.follows.push({ followerId, followingId, createdAt: new Date().toISOString() });
        persist();
      },
      async unfollow(followerId, followingId) {
        assertActive(followerId);
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
      async search(query, limit = 20) {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const rank = (p: ProfileRow) => {
          const username = p.username.toLowerCase();
          const name = p.displayName.toLowerCase();
          if (username === q || name === q) return 0;
          if (username.startsWith(q) || name.startsWith(q)) return 1;
          if (username.includes(q) || name.includes(q)) return 2;
          if (p.homeCity?.toLowerCase().includes(q)) return 3;
          return null;
        };
        return state.profiles
          .map((p) => ({ p, rank: rank(p) }))
          .filter((x): x is { p: ProfileRow; rank: number } => x.rank !== null)
          .sort((a, b) => a.rank - b.rank || a.p.displayName.localeCompare(b.p.displayName))
          .slice(0, limit)
          .map(({ p }) => toProfile(state, p));
      },
      async listByInterest(interestSlug, limit = 50) {
        const ids = new Set(state.profileInterests.filter((x) => x.interestSlug === interestSlug).map((x) => x.profileId));
        return state.profiles
          .filter((p) => ids.has(p.id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((p) => toProfile(state, p));
      },
    },

    reports: {
      async create(input, reporterId) {
        assertActive(reporterId);
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
        const counted = rateLimit(reporterId, "reports");
        state.reports.push({
          id: newId(),
          reporterId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          details: input.details ?? null,
          status: "open",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        });
        counted();
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
          .map((r) => toReportEntry(state, r, false));
      },
    },

    moderation: {
      async isModerator(userId) {
        return isModeratorIn(state, userId);
      },
      async queue(viewerId, opts = {}) {
        if (!isModeratorIn(state, viewerId)) return { items: [], nextCursor: null };
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const groups = new Map<string, ReportRow[]>();
        for (const r of state.reports) {
          if (r.status !== "open") continue;
          const key = `${r.targetType}:${r.targetId}`;
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        const items = [...groups.values()]
          .map((rows): ModerationQueueItem => {
            const times = rows.map((r) => r.createdAt).sort(compareTimestamps);
            const { targetType, targetId } = rows[0];
            return {
              targetType,
              targetId,
              reportCount: rows.length,
              firstReportedAt: times[0],
              lastReportedAt: times.at(-1)!,
              reasons: [...new Set(rows.map((r) => r.reason))].sort() as ReportReason[],
              targetLabel: targetLabel(targetType, targetId),
              targetStatus: targetStatus(targetType, targetId),
            };
          })
          .filter((i) => !after || compareTimestamps(i.firstReportedAt, after.key) > 0 || (compareTimestamps(i.firstReportedAt, after.key) === 0 && i.targetId > after.id))
          .sort((a, b) => compareTimestamps(a.firstReportedAt, b.firstReportedAt) || compareIds(a.targetId, b.targetId));
        return toPage(items, limit, (i) => i, (i) => ({ key: i.firstReportedAt, id: i.targetId }));
      },
      async target(viewerId, targetType, targetId) {
        if (!isModeratorIn(state, viewerId)) return null;
        const reports = state.reports
          .filter((r) => r.targetType === targetType && r.targetId === targetId)
          .map((r) => ({
            id: r.id,
            reason: r.reason,
            details: r.details,
            status: r.status,
            createdAt: r.createdAt,
            resolvedAt: r.resolvedAt,
            reporter: profileOf(state, r.reporterId),
          }))
          .sort(compareModerationReports);
        const history = state.moderationActions
          .filter((a) => a.targetType === targetType && a.targetId === targetId)
          .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id))
          .map((a) => ({
            id: a.id,
            action: a.action,
            reason: a.reason,
            statusBefore: a.statusBefore,
            statusAfter: a.statusAfter,
            resolvedReports: a.resolvedReports,
            createdAt: a.createdAt,
            moderator: profileOf(state, a.moderatorId),
          }));
        return { targetType, targetId, snapshot: snapshotOf(targetType, targetId), reports, history };
      },
      async resolve(moderatorId, { targetType, targetId, action, reason }) {
        if (!isModeratorIn(state, moderatorId)) throw new DataError("Moderators only", "forbidden");
        if (!REPORT_TARGET_TYPES.includes(targetType)) throw moderationError("invalid_target");
        if (!MODERATION_ACTIONS.includes(action)) throw moderationError("invalid_action");
        const why = normalizeReason(reason);
        if (why && why.length > MAX_MODERATION_REASON) throw moderationError("reason_too_long");
        const content = targetType === "place"
          ? state.places.find((p) => p.id === targetId)
          : targetType === "event" ? state.events.find((e) => e.id === targetId) : null;
        if (targetType === "profile" ? !state.profiles.some((p) => p.id === targetId) : !content) throw moderationError("not_found");
        const before: string | null = content?.status ?? null;
        let after = before;
        let reportStatus: ReportRow["status"];
        if (action === "remove") {
          if (targetType === "profile") throw moderationError("cannot_remove_profile");
          if (before === "removed") throw moderationError("already_removed");
          if (!why) throw moderationError("reason_required");
          after = "removed";
          reportStatus = "reviewed";
        } else if (action === "restore") {
          if (before !== "removed") throw moderationError("not_removed");
          after = "published";
          reportStatus = "dismissed";
        } else {
          reportStatus = action === "dismiss" ? "dismissed" : "reviewed";
        }
        const open = state.reports.filter((r) => r.targetType === targetType && r.targetId === targetId && r.status === "open");
        if ((action === "dismiss" || action === "review") && !open.length) throw moderationError("nothing_open");
        const now = new Date().toISOString();
        for (const r of open) {
          r.status = reportStatus;
          r.resolvedAt = now;
        }
        if (content && after !== before) {
          content.status = after as typeof content.status;
          content.updatedAt = now;
        }
        state.moderationActions.push({
          id: newId(), moderatorId, action, targetType, targetId, reason: why,
          statusBefore: before, statusAfter: after, resolvedReports: open.length, createdAt: now,
        });
        persist();
        return { statusAfter: after, resolvedReports: open.length };
      },
      async setLocalStatus(moderatorId, userId, revoked, reason) {
        if (!isModeratorIn(state, moderatorId)) throw new DataError("Moderators only", "forbidden");
        const why = normalizeReason(reason);
        if (!why) throw moderationError("reason_required");
        if (why.length > MAX_MODERATION_REASON) throw moderationError("reason_too_long");
        if (!state.profiles.some((p) => p.id === userId)) throw moderationError("not_found");
        const wasRevoked = state.localRevocations.some((r) => r.userId === userId);
        if (wasRevoked === revoked) throw moderationError("no_change");
        const now = new Date().toISOString();
        if (revoked) state.localRevocations.push({ userId, revokedBy: moderatorId, reason: why, revokedAt: now });
        else state.localRevocations = state.localRevocations.filter((r) => r.userId !== userId);
        state.moderationActions.push({
          id: newId(), moderatorId, action: revoked ? "revoke_local" : "restore_local", targetType: "profile", targetId: userId,
          reason: why, statusBefore: wasRevoked ? "revoked" : "eligible", statusAfter: revoked ? "revoked" : "eligible",
          resolvedReports: 0, createdAt: now,
        });
        persist();
      },
      async localRevoked(userId) {
        return state.localRevocations.some((r) => r.userId === userId);
      },
      async myRemovedContent(userId) {
        const mine: Omit<RemovedContent, "reason" | "removedAt">[] = [
          ...state.places.filter((p) => p.creatorId === userId && p.status === "removed").map((p) => ({ targetType: "place" as const, targetId: p.id, label: p.name })),
          ...state.events.filter((e) => e.creatorId === userId && e.status === "removed").map((e) => ({ targetType: "event" as const, targetId: e.id, label: e.title })),
        ];
        return mine
          .map((m) => {
            const latest = state.moderationActions
              .filter((a) => a.targetType === m.targetType && a.targetId === m.targetId && a.action === "remove")
              .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id))[0];
            return { ...m, reason: latest?.reason ?? null, removedAt: latest?.createdAt ?? null };
          })
          .sort((a, b) =>
            (a.removedAt === null ? 1 : 0) - (b.removedAt === null ? 1 : 0) ||
            (a.removedAt && b.removedAt ? compareTimestamps(b.removedAt, a.removedAt) : 0) ||
            compareIds(a.targetId, b.targetId));
      },
    },

    analytics: {
      async track(userId, name, props = {}) {
        const profile = state.profiles.find((p) => p.id === userId);
        // Mirrors track_event(): silent without a profile or when opted out.
        if (!profile || profile.analyticsOptOut) return;
        const counted = rateLimit(userId, "analytics");
        const actor = createHash("sha256").update(`${state.analyticsSalt}:${userId}`).digest("hex");
        const id = (state.analyticsEvents.at(-1)?.id ?? 0) + 1;
        state.analyticsEvents.push({ id, actor, name, props, createdAt: new Date().toISOString() });
        counted();
        persist();
      },
      async optedOut(userId) {
        return !!state.profiles.find((p) => p.id === userId)?.analyticsOptOut;
      },
      async setOptOut(userId, optOut) {
        assertActive(userId);
        requireProfile(userId).analyticsOptOut = optOut;
        persist();
      },
      async funnel(viewerId, from, to) {
        if (!isAdmin(viewerId)) return [];
        const inWindow = state.analyticsEvents.filter((e) => compareTimestamps(e.createdAt, from) >= 0 && compareTimestamps(e.createdAt, to) < 0);
        return FUNNEL_STEPS.map((step) => {
          const events = inWindow.filter((e) => e.name === step);
          return { step, actors: new Set(events.map((e) => e.actor)).size, events: events.length };
        });
      },
      async weeklyContributors(viewerId, weeks) {
        if (!isAdmin(viewerId)) return [];
        // ISO weeks (Monday) in UTC, like date_trunc('week', now()) in Postgres.
        const now = new Date();
        const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
        const contributing = state.analyticsEvents.filter((e) => e.name === "contribute_place" || e.name === "create_event" || e.name === "rate_place");
        return Array.from({ length: weeks }, (_, i) => {
          const start = monday - (weeks - 1 - i) * 7 * 86_400_000;
          const actors = new Set(contributing.filter((e) => {
            const t = new Date(e.createdAt).getTime();
            return t >= start && t < start + 7 * 86_400_000;
          }).map((e) => e.actor));
          return { weekStart: new Date(start).toISOString().slice(0, 10), contributors: actors.size };
        });
      },
      async saveSources(viewerId, from, to) {
        if (!isAdmin(viewerId)) return { community: 0, seed: 0 };
        const out = { community: 0, seed: 0 };
        for (const s of state.savedPlaces) {
          if (compareTimestamps(s.createdAt, from) < 0 || compareTimestamps(s.createdAt, to) >= 0) continue;
          const place = state.places.find((p) => p.id === s.placeId);
          if (place) out[place.source] += 1;
        }
        return out;
      },
    },

    admin: {
      async isAdmin(userId) {
        return isAdmin(userId);
      },
      async isSuspended(userId) {
        return state.suspensions.some((x) => x.userId === userId);
      },
      async users(viewerId, opts = {}) {
        if (!isAdmin(viewerId)) return { items: [], nextCursor: null };
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const q = (opts.query ?? "").trim().toLowerCase();
        const rows = state.profiles
          .filter((p) => !q || p.username.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q))
          .filter((p) => !after || compareTimestamps(p.createdAt, after.key) < 0 || (compareTimestamps(p.createdAt, after.key) === 0 && p.id < after.id))
          .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id));
        return toPage(rows, limit, (p) => {
          const mine = new Set(state.places.filter((x) => x.creatorId === p.id).map((x) => x.id));
          return {
            id: p.id, username: p.username, displayName: p.displayName, homeCity: p.homeCity, createdAt: p.createdAt,
            reputationLevel: p.reputationLevel, isModerator: state.moderators.some((m) => m.userId === p.id), isAdmin: isAdmin(p.id),
            suspended: state.suspensions.some((x) => x.userId === p.id),
            places: mine.size, events: state.events.filter((e) => e.creatorId === p.id).length,
            reportsAgainst: state.reports.filter((r) => (r.targetType === "profile" && r.targetId === p.id) || (r.targetType === "place" && mine.has(r.targetId))).length,
          };
        }, (p) => ({ key: p.createdAt, id: p.id }));
      },
      async content(viewerId, opts = {}) {
        if (!isAdmin(viewerId)) return { items: [], nextCursor: null };
        const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
        const after = decodeCursor(opts.cursor);
        const kind = opts.kind ?? "place";
        const q = (opts.query ?? "").trim().toLowerCase();
        const username = (id: string | null) => (id ? (state.profiles.find((p) => p.id === id)?.username ?? null) : null);
        const rows = (kind === "place"
          ? state.places.map((p) => ({ kind: "place" as const, id: p.id, label: p.name, status: p.status, visibility: p.visibility as string | null, city: p.city as string | null, creatorId: p.creatorId, createdAt: p.createdAt }))
          : state.events.map((e) => ({ kind: "event" as const, id: e.id, label: e.title, status: e.status, visibility: null, city: null, creatorId: e.creatorId, createdAt: e.createdAt })))
          .filter((c) => (!opts.status || c.status === opts.status) && (!opts.creatorId || c.creatorId === opts.creatorId) && (!q || c.label.toLowerCase().includes(q)))
          .filter((c) => !after || compareTimestamps(c.createdAt, after.key) < 0 || (compareTimestamps(c.createdAt, after.key) === 0 && c.id < after.id))
          .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id));
        return toPage(rows, limit, (c) => ({
          ...c, creatorUsername: username(c.creatorId),
          openReports: state.reports.filter((r) => r.targetType === c.kind && r.targetId === c.id && r.status === "open").length,
          actions: state.moderationActions.filter((a) => a.targetType === c.kind && a.targetId === c.id).length,
        }), (c) => ({ key: c.createdAt, id: c.id }));
      },
      async rateLimitHits(viewerId) {
        if (!isAdmin(viewerId)) return [];
        const now = Date.now();
        return (Object.keys(RATE_LIMITS) as RateLimitAction[]).sort().map((action) => ({
          action,
          usersAtLimit: state.rateLimits.filter((r) => r.action === action && r.count >= RATE_LIMITS[action].max && r.windowStart === windowStart(action, now)).length,
          maxCount: RATE_LIMITS[action].max,
          windowSeconds: RATE_LIMITS[action].windowSeconds,
        }));
      },
      async history(viewerId, target) {
        if (!isAdmin(viewerId)) return [];
        return state.moderationActions
          .filter((a) => a.targetType === target.type && (!target.id || a.targetId === target.id) && (!target.key || a.targetKey === target.key))
          .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id))
          .map((a) => ({ id: a.id, action: a.action, reason: a.reason, statusBefore: a.statusBefore, statusAfter: a.statusAfter, createdAt: a.createdAt, moderatorUsername: a.moderatorId ? (state.profiles.find((p) => p.id === a.moderatorId)?.username ?? null) : null }));
      },
      async setSuspended(adminId, userId, suspended, reason) {
        const why = requireAdmin(adminId, reason);
        if (!state.profiles.some((p) => p.id === userId)) throw moderationError("not_found");
        if (userId === adminId) throw moderationError("self");
        const was = state.suspensions.some((x) => x.userId === userId);
        if (was === suspended) throw moderationError("no_change");
        if (suspended) state.suspensions.push({ userId, reason: why, suspendedBy: adminId, suspendedAt: new Date().toISOString() });
        else state.suspensions = state.suspensions.filter((x) => x.userId !== userId);
        audit(adminId, suspended ? "suspend" : "unsuspend", "profile", { id: userId }, why, was ? "suspended" : "active", suspended ? "suspended" : "active");
        persist();
      },
      async setModerator(adminId, userId, moderator, reason) {
        const why = requireAdmin(adminId, reason);
        if (!state.profiles.some((p) => p.id === userId)) throw moderationError("not_found");
        const was = state.moderators.some((m) => m.userId === userId);
        if (was === moderator) throw moderationError("no_change");
        if (moderator) state.moderators.push({ userId, grantedAt: new Date().toISOString(), grantedBy: adminId });
        else state.moderators = state.moderators.filter((m) => m.userId !== userId);
        audit(adminId, moderator ? "grant_moderator" : "revoke_moderator", "profile", { id: userId }, why, was ? "moderator" : "member", moderator ? "moderator" : "member");
        persist();
      },
      async taxonomy(viewerId) {
        if (!isAdmin(viewerId)) return [];
        return [...state.taxonomy].sort((a, b) => a.kind.localeCompare(b.kind) || a.sortOrder - b.sortOrder || compareIds(a.slug, b.slug)).map((t) => ({ ...t }));
      },
      async upsertTaxonomy(adminId, entry, reason) {
        const why = requireAdmin(adminId, reason);
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.slug) || entry.slug.length > 40) throw moderationError("bad_slug");
        const label = entry.label.trim();
        const emoji = entry.emoji.trim();
        if (label.length < 1 || label.length > 40 || emoji.length < 1 || emoji.length > 8) throw moderationError("bad_label");
        if (entry.kind === "category" && (!/^#[0-9a-fA-F]{6}$/.test(entry.color ?? "") || !["place", "event", "both"].includes(entry.scope ?? ""))) throw moderationError("bad_label");
        const existing = state.taxonomy.find((t) => t.kind === entry.kind && t.slug === entry.slug);
        const before = existing?.label ?? null;
        const row = { kind: entry.kind, slug: entry.slug, label, emoji, sortOrder: entry.sortOrder, retired: existing?.retired ?? false, ...(entry.kind === "category" ? { color: entry.color!.toLowerCase(), scope: entry.scope } : {}) };
        if (existing) Object.assign(existing, row);
        else state.taxonomy.push(row);
        audit(adminId, "taxonomy_upsert", entry.kind, { key: entry.slug }, why, before, label);
        persist();
      },
      async setTaxonomyRetired(adminId, kind, slug, retired, reason) {
        const why = requireAdmin(adminId, reason);
        const row = state.taxonomy.find((t) => t.kind === kind && t.slug === slug);
        if (!row) throw moderationError("not_found");
        if (row.retired === retired) throw moderationError("no_change");
        const was = row.retired;
        row.retired = retired;
        audit(adminId, retired ? "taxonomy_retire" : "taxonomy_restore", kind, { key: slug }, why, was ? "retired" : "active", retired ? "retired" : "active");
        persist();
      },
    },

    reputation: {
      async reset(moderatorId, userId, reason) {
        if (!isModeratorIn(state, moderatorId)) throw new DataError("Moderators only", "forbidden");
        const why = normalizeReason(reason);
        if (!why) throw moderationError("reason_required");
        if (why.length > MAX_MODERATION_REASON) throw moderationError("reason_too_long");
        const profile = state.profiles.find((p) => p.id === userId);
        if (!profile) throw moderationError("not_found");
        const before = profile.reputationLevel;
        const now = new Date().toISOString();
        state.reputationResets = [...state.reputationResets.filter((r) => r.userId !== userId), { userId, resetAt: now, resetBy: moderatorId }];
        refreshDemoReputation(state, userId);
        state.moderationActions.push({
          id: newId(), moderatorId, action: "reset_reputation", targetType: "profile", targetId: userId, reason: why,
          statusBefore: before, statusAfter: profile.reputationLevel, resolvedReports: 0, createdAt: now,
        });
        persist();
      },
      async refreshAll() {
        const n = refreshDemoReputation(state);
        persist();
        return n;
      },
    },

    storage: {
      async uploadImage(image, folder, ownerId) {
        assertActive(ownerId);
        // The storage insert policy counts the main object only, not its sizes.
        const counted = rateLimit(ownerId, folder === "avatars" ? "avatars" : "photos");
        // Everything stored has been through the image pipeline, which emits WebP.
        const name = `${folder}-${ownerId.slice(0, 8)}-${newId()}.webp`;
        mkdirSync(UPLOAD_DIR, { recursive: true });
        writeFileSync(path.join(UPLOAD_DIR, name), image.main);
        for (const size of ["md", "sm"] as const) {
          const bytes = image.variants?.[size];
          if (bytes) writeFileSync(path.join(UPLOAD_DIR, photoVariantPath(name, size)), bytes);
        }
        // Avatars are public profile data; place photos are served only through
        // the authorized /api/photos/[id] route.
        const url = folder === "avatars" ? `/api/uploads/${name}` : placePhotoReference(name);
        counted();
        persist();
        return { url, storagePath: name };
      },
      async deliverPlacePhoto(objectPath) {
        const name = path.basename(objectPath);
        if (!DEMO_UPLOAD_NAME.test(name) || !name.startsWith("places-")) return null;
        try {
          const body = new Uint8Array(readFileSync(path.join(UPLOAD_DIR, name)));
          return { kind: "bytes", body, contentType: sniffImageType(body) };
        } catch {
          return null;
        }
      },
      async removeImage(folder, storagePath) {
        const filename = path.basename(storagePath);
        if (!filename.startsWith(`${folder}-`)) return;
        for (const name of folder === "places" ? photoObjectPaths(filename) : [filename]) {
          try { unlinkSync(path.join(UPLOAD_DIR, name)); } catch { /* already removed */ }
        }
      },
    },
  };

  return repo;
}
