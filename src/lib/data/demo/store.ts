/**
 * Demo-mode data store.
 *
 * A normalized, in-memory mirror of the Postgres schema, seeded from
 * src/lib/seed/seed-data.ts and persisted to .data/demo-store.json so edits
 * survive dev-server restarts. It exists so the app is fully usable without
 * Supabase credentials; it is not intended for production.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEMO_PASSWORD,
  SEED_EVENTS,
  SEED_FOLLOWS,
  SEED_PLACES,
  SEED_RATINGS,
  SEED_REPORTS,
  SEED_SAVES,
  SEED_USERS,
  seedEventTimes,
  seedPlaceByName,
  seedUserByName,
} from "@/lib/seed/seed-data";
import type { EventStatus, PlaceStatus, ReportReason, ReportTargetType, Visibility } from "../types";
import { newId } from "@/lib/utils/ids";

export interface AuthUserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}
export interface ProfileRow {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  homeCity: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PlaceRow {
  id: string;
  name: string;
  description: string;
  localTip: string | null;
  categorySlug: string;
  lat: number;
  lng: number;
  address: string | null;
  neighborhood: string | null;
  city: string;
  creatorId: string | null;
  ratingAvg: number;
  ratingCount: number;
  status: PlaceStatus;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}
export interface PlacePhotoRow {
  id: string;
  placeId: string;
  url: string;
  storagePath: string | null;
  uploaderId: string | null;
  sortOrder: number;
  createdAt: string;
}
export interface PlaceRatingRow {
  id: string;
  placeId: string;
  userId: string;
  score: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EventRow {
  id: string;
  title: string;
  description: string;
  placeId: string | null;
  locationName: string;
  address: string | null;
  lat: number;
  lng: number;
  startsAt: string;
  endsAt: string | null;
  creatorId: string | null;
  categorySlug: string;
  capacity: number | null;
  status: EventStatus;
  createdAt: string;
  updatedAt: string;
}
export interface ReportRow {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  status: "open" | "reviewed" | "dismissed";
  createdAt: string;
}

export interface DemoState {
  version: number;
  authUsers: AuthUserRow[];
  profiles: ProfileRow[];
  profileInterests: { profileId: string; interestSlug: string }[];
  places: PlaceRow[];
  placeTags: { placeId: string; interestSlug: string }[];
  placePhotos: PlacePhotoRow[];
  placeRatings: PlaceRatingRow[];
  savedPlaces: { userId: string; placeId: string; createdAt: string }[];
  events: EventRow[];
  eventTags: { eventId: string; interestSlug: string }[];
  eventAttendees: { eventId: string; userId: string; createdAt: string }[];
  follows: { followerId: string; followingId: string; createdAt: string }[];
  reports: ReportRow[];
}

const STATE_VERSION = 1;
const DATA_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "demo-store.json");

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function buildSeedState(now = new Date()): DemoState {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const sharedHash = hashPassword(DEMO_PASSWORD);

  const state: DemoState = {
    version: STATE_VERSION,
    authUsers: [],
    profiles: [],
    profileInterests: [],
    places: [],
    placeTags: [],
    placePhotos: [],
    placeRatings: [],
    savedPlaces: [],
    events: [],
    eventTags: [],
    eventAttendees: [],
    follows: [],
    reports: [],
  };

  SEED_USERS.forEach((u, i) => {
    state.authUsers.push({ id: u.id, email: u.email, passwordHash: sharedHash, createdAt: daysAgo(90 - i) });
    state.profiles.push({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: null,
      bio: u.bio,
      homeCity: u.homeCity,
      createdAt: daysAgo(90 - i),
      updatedAt: daysAgo(90 - i),
    });
    for (const interest of u.interests) state.profileInterests.push({ profileId: u.id, interestSlug: interest });
  });

  SEED_PLACES.forEach((p, i) => {
    const created = daysAgo(60 - i);
    state.places.push({
      id: p.id,
      name: p.name,
      description: p.description,
      localTip: p.localTip,
      categorySlug: p.categorySlug,
      lat: p.lat,
      lng: p.lng,
      address: p.address,
      neighborhood: p.neighborhood,
      city: p.city,
      creatorId: seedUserByName(p.creator).id,
      ratingAvg: 0,
      ratingCount: 0,
      status: "published",
      visibility: p.visibility ?? "public",
      createdAt: created,
      updatedAt: created,
    });
    for (const t of p.tags) state.placeTags.push({ placeId: p.id, interestSlug: t });
  });

  SEED_RATINGS.forEach((r, i) => {
    const created = daysAgo(40 - (i % 30));
    state.placeRatings.push({
      id: newId(),
      placeId: seedPlaceByName(r.place).id,
      userId: seedUserByName(r.user).id,
      score: r.score,
      note: r.note,
      createdAt: created,
      updatedAt: created,
    });
  });
  for (const place of state.places) recomputeRating(state, place.id);

  SEED_SAVES.forEach((s, i) => {
    state.savedPlaces.push({
      userId: seedUserByName(s.user).id,
      placeId: seedPlaceByName(s.place).id,
      createdAt: daysAgo(30 - (i % 20)),
    });
  });

  SEED_EVENTS.forEach((ev, i) => {
    const { startsAt, endsAt } = seedEventTimes(ev, now);
    state.events.push({
      id: ev.id,
      title: ev.title,
      description: ev.description,
      placeId: ev.place ? seedPlaceByName(ev.place).id : null,
      locationName: ev.locationName,
      address: ev.address,
      lat: ev.lat,
      lng: ev.lng,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt ? endsAt.toISOString() : null,
      creatorId: seedUserByName(ev.creator).id,
      categorySlug: ev.categorySlug,
      capacity: ev.capacity,
      status: "published",
      createdAt: daysAgo(14 - (i % 10)),
      updatedAt: daysAgo(14 - (i % 10)),
    });
    for (const t of ev.tags) state.eventTags.push({ eventId: ev.id, interestSlug: t });
    for (const a of ev.attendees) {
      state.eventAttendees.push({ eventId: ev.id, userId: seedUserByName(a).id, createdAt: daysAgo(7) });
    }
  });

  SEED_REPORTS.forEach((r, i) => {
    const target = r.targetKind === "place" ? seedPlaceByName(r.target).id : r.target;
    state.reports.push({
      id: newId(),
      reporterId: seedUserByName(r.reporter).id,
      targetType: r.targetKind,
      targetId: target,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: daysAgo(10 - (i % 8)),
    });
  });

  SEED_FOLLOWS.forEach((f, i) => {
    state.follows.push({
      followerId: seedUserByName(f.follower).id,
      followingId: seedUserByName(f.following).id,
      createdAt: daysAgo(20 - (i % 15)),
    });
  });

  return state;
}

/**
 * Mirrors public.is_local(text) from 0003_tier2_community_layer.sql.
 *
 * A viewer is a local of a city when their home city matches, or when they have
 * contributed at least one published place there. Kept beside the store so the
 * demo and Supabase paths cannot drift apart silently.
 */
export function isLocalOfCity(state: DemoState, userId: string | null, city: string): boolean {
  if (!userId || !city) return false;
  const norm = (v: string) => v.trim().toLowerCase();
  const target = norm(city);
  const profile = state.profiles.find((p) => p.id === userId);
  if (profile?.homeCity && norm(profile.homeCity) === target) return true;
  return state.places.some(
    (p) => p.creatorId === userId && p.status === "published" && norm(p.city) === target,
  );
}

/** Mirrors the Postgres trigger that maintains places.rating_avg / rating_count. */
export function recomputeRating(state: DemoState, placeId: string) {
  const ratings = state.placeRatings.filter((r) => r.placeId === placeId);
  const place = state.places.find((p) => p.id === placeId);
  if (!place) return;
  place.ratingCount = ratings.length;
  place.ratingAvg = ratings.length
    ? Math.round((ratings.reduce((s, r) => s + r.score, 0) / ratings.length) * 100) / 100
    : 0;
}

export interface StoreHandle {
  state: DemoState;
  persist(): void;
}

declare global {
  var __findmaxxingDemoStore: StoreHandle | undefined;
}

function loadFromDisk(): DemoState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState;
    if (parsed.version !== STATE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createHandle(initial?: DemoState): StoreHandle {
  const state = initial ?? loadFromDisk() ?? buildSeedState();
  let timer: NodeJS.Timeout | null = null;
  const handle: StoreHandle = {
    state,
    persist() {
      if (process.env.FINDMAXXING_DEMO_NO_PERSIST === "1") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          mkdirSync(DATA_DIR, { recursive: true });
          writeFileSync(STATE_FILE, JSON.stringify(handle.state));
        } catch (err) {
          console.warn("[demo-store] failed to persist", err);
        }
      }, 150);
    },
  };
  if (!initial && !existsSync(STATE_FILE)) handle.persist();
  return handle;
}

/** Process-wide singleton (kept on globalThis to survive HMR in dev). */
export function getDemoStore(): StoreHandle {
  if (!globalThis.__findmaxxingDemoStore) {
    globalThis.__findmaxxingDemoStore = createHandle();
  }
  return globalThis.__findmaxxingDemoStore;
}

/** For tests: an isolated, non-persisting store. */
export function createIsolatedStore(now = new Date()): StoreHandle {
  const state = buildSeedState(now);
  return { state, persist() {} };
}
