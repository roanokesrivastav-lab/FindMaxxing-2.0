/**
 * Demo-mode data store.
 *
 * A normalized, in-memory mirror of the Postgres schema, seeded from
 * src/lib/seed/seed-data.ts and persisted to .data/demo-store.json so edits
 * survive dev-server restarts. It exists so the app is fully usable without
 * Supabase credentials; it is not intended for production.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
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
import { placePhotoReference } from "../photos";

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
  savedLists: SavedListRow[];
  /** Mirrors saved_list_items: always one of the owner's savedPlaces, in one of the owner's lists. */
  savedListItems: { listId: string; ownerId: string; placeId: string; createdAt: string }[];
  events: EventRow[];
  eventTags: { eventId: string; interestSlug: string }[];
  eventAttendees: { eventId: string; userId: string; createdAt: string }[];
  follows: { followerId: string; followingId: string; createdAt: string }[];
  reports: ReportRow[];
}

export interface SavedListRow {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const STATE_VERSION = 3;
const DATA_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "demo-store.json");

// ----------------------------------------------------------------------------
// Persisted-state migrations
//
// The file on disk is user data: sign-ups, places, saves. A version bump must
// carry it forward, never silently reseed. Each entry upgrades from version N
// to N + 1 in place; add one whenever DemoState changes shape or meaning.
// ----------------------------------------------------------------------------
type LooseState = Record<string, unknown> & { version?: unknown };

const COLLECTIONS = [
  "authUsers", "profiles", "profileInterests", "places", "placeTags", "placePhotos",
  "placeRatings", "savedPlaces", "savedLists", "savedListItems", "events", "eventTags", "eventAttendees", "follows", "reports",
] as const;

const LEGACY_PLACE_UPLOAD = /^\/api\/uploads\/(places-[^/]+)$/;

const MIGRATIONS: Record<number, (state: LooseState) => void> = {
  // v1 → v2: place photos became private.
  //   * Collections added after v1 shipped (e.g. reports) may be missing.
  //   * Photos stored as public /api/uploads URLs get their storage path
  //     recovered and a non-public reference, so they are served only through
  //     the visibility-checked /api/photos/[id] route.
  //   * Places written before trust tiers get the default visibility.
  1(state) {
    for (const key of COLLECTIONS) if (!Array.isArray(state[key])) state[key] = [];
    for (const photo of state.placePhotos as Partial<PlacePhotoRow>[]) {
      const legacy = typeof photo.url === "string" ? LEGACY_PLACE_UPLOAD.exec(photo.url) : null;
      if (legacy && !photo.storagePath) photo.storagePath = legacy[1];
      photo.storagePath ??= null;
      photo.uploaderId ??= null;
      if (photo.storagePath && typeof photo.url === "string" && photo.url.startsWith("/api/uploads/")) {
        photo.url = placePhotoReference(photo.storagePath);
      }
    }
    for (const place of state.places as Partial<PlaceRow>[]) place.visibility ??= "public";
    for (const rating of state.placeRatings as Partial<PlaceRatingRow>[]) rating.note ??= null;
  },
  // v2 → v3: saved lists. Bookmarks (savedPlaces) stay exactly as they are;
  // every one of them is simply in no list yet.
  2(state) {
    state.savedLists ??= [];
    state.savedListItems ??= [];
  },
};

export type MigrationResult =
  | { ok: true; state: DemoState; migratedFrom: number | null }
  | { ok: false; reason: "invalid" | "newer" };

/** Upgrades a parsed store file to STATE_VERSION. Pure: no disk access. */
export function migrateDemoState(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const state = raw as LooseState;
  const from = state.version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) return { ok: false, reason: "invalid" };
  if (from > STATE_VERSION) return { ok: false, reason: "newer" };
  for (let v = from; v < STATE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: "invalid" };
    step(state);
    state.version = v + 1;
  }
  for (const key of COLLECTIONS) if (!Array.isArray(state[key])) return { ok: false, reason: "invalid" };
  return { ok: true, state: state as unknown as DemoState, migratedFrom: from === STATE_VERSION ? null : from };
}

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
    savedLists: [],
    savedListItems: [],
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

/** Keeps a copy of the store file before anything replaces or rewrites it. */
function backupStateFile(file: string, label: string): string {
  const backup = file.replace(/\.json$/, `.${label}-${Date.now()}.bak.json`);
  copyFileSync(file, backup);
  return backup;
}

/**
 * Raised by loadStateFile when the store file exists but cannot be used —
 * invalid JSON, an unknown shape, or a file from a newer STATE_VERSION. The
 * file is user data (sign-ups, places, saves), so startup fails rather than
 * reseeding over it; the original is left untouched for manual recovery.
 */
export class StoreLoadError extends Error {
  constructor(
    message: string,
    public readonly reason: "invalid" | "newer",
  ) {
    super(message);
    this.name = "StoreLoadError";
  }
}

/**
 * Reads the persisted store, migrating it forward if needed.
 *
 * Returns null only when no store file exists (first run — seed as usual).
 * When a file exists but cannot be used, the original stays in place (a dated
 * backup copy is kept alongside for inspection) and a StoreLoadError is
 * thrown, so a reseed can never overwrite the user's data.
 */
export function loadStateFile(file: string): { state: DemoState; migratedFrom: number | null } | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    const backup = backupStateFile(file, "unreadable");
    throw new StoreLoadError(
      `[demo-store] ${file} is not valid JSON; original kept in place, copy at ${backup}. ` +
        "Restore or delete the file, then restart.",
      "invalid",
    );
  }
  const result = migrateDemoState(parsed);
  if (!result.ok) {
    const backup = backupStateFile(file, result.reason);
    throw new StoreLoadError(
      `[demo-store] ${file} could not be loaded (${result.reason}); original kept in place, copy at ${backup}. ` +
        "Restore or delete the file, then restart.",
      result.reason,
    );
  }
  if (result.migratedFrom !== null) {
    const backup = backupStateFile(file, `v${result.migratedFrom}`);
    console.info(`[demo-store] migrated ${file} from v${result.migratedFrom} to v${STATE_VERSION}; previous copy at ${backup}`);
  }
  return { state: result.state, migratedFrom: result.migratedFrom };
}

function createHandle(initial?: DemoState): StoreHandle {
  // A missing file seeds; an unusable one throws and takes startup down —
  // it is user data, never silently replaced (see loadStateFile).
  const loaded = initial ? null : loadStateFile(STATE_FILE);
  const state = initial ?? loaded?.state ?? buildSeedState();
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
  // Write a fresh seed, or persist a migrated file.
  if (!initial && (!loaded || loaded.migratedFrom !== null)) handle.persist();
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
