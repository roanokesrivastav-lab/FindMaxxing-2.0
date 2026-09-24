import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSeedState, createIsolatedStore, loadStateFile, migrateDemoState, STATE_VERSION, StoreLoadError } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { placePhotoUrl } from "../src/lib/data/photos";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const jules = SEED_USERS.find((u) => u.username === "jules")!;
const nina = SEED_USERS.find((u) => u.username === "nina")!;
const ridgeline = stableId("place:Ridgeline Loop");
const UPLOAD = "places-0a1b2c3d-11111111-2222-4333-8444-555555555555.jpg";

describe("private place photos (demo mode)", () => {
  function withRidgelinePhoto() {
    const store = createIsolatedStore();
    store.state.placePhotos.push({
      id: "9f0e0a52-4c7e-4a8e-9d8c-2f1b3c4d5e6f",
      placeId: ridgeline,
      url: `storage:place-photos/${UPLOAD}`,
      storagePath: UPLOAD,
      uploaderId: jules.id,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    });
    return { store, repo: createDemoRepository(store), photoId: "9f0e0a52-4c7e-4a8e-9d8c-2f1b3c4d5e6f" };
  }

  it("never exposes a storage object URL; photos render through the authorized route", async () => {
    const { repo, photoId } = withRidgelinePhoto();
    const place = await repo.places.get(ridgeline, jules.id);
    expect(place?.photos.map((p) => p.url)).toEqual([`/api/photos/${photoId}`]);
  });

  it("keeps externally hosted images on their own URL", () => {
    expect(placePhotoUrl({ id: "x", url: "https://images.example/a.jpg", storagePath: null })).toBe("https://images.example/a.jpg");
  });

  it("resolves the object for a local and refuses non-locals and anonymous viewers", async () => {
    const { repo, photoId } = withRidgelinePhoto();
    expect(await repo.places.getPhotoObject(photoId, jules.id)).toEqual({ storagePath: UPLOAD });
    expect(await repo.places.getPhotoObject(photoId, nina.id)).toBeNull();
    expect(await repo.places.getPhotoObject(photoId, null)).toBeNull();
  });

  it("follows hide and visibility changes", async () => {
    const { store, repo, photoId } = withRidgelinePhoto();
    const place = store.state.places.find((p) => p.id === ridgeline)!;
    place.visibility = "public";
    expect(await repo.places.getPhotoObject(photoId, null)).not.toBeNull();
    place.status = "hidden";
    expect(await repo.places.getPhotoObject(photoId, null)).toBeNull();
    expect(await repo.places.getPhotoObject(photoId, jules.id)).not.toBeNull(); // owner
  });

  it("returns null for unknown photos and refuses to deliver non-photo names", async () => {
    const { repo } = withRidgelinePhoto();
    expect(await repo.places.getPhotoObject("00000000-0000-4000-8000-000000000000", jules.id)).toBeNull();
    expect(await repo.storage.deliverPlacePhoto("../demo-store.json")).toBeNull();
    expect(await repo.storage.deliverPlacePhoto("avatars-0a1b2c3d-11111111-2222-4333-8444-555555555555.jpg")).toBeNull();
  });
});

describe("demo store migrations", () => {
  /** A v1 file as written before this change: public upload URLs, no reports collection. */
  function v1File() {
    const state = buildSeedState() as unknown as Record<string, unknown>;
    state.version = 1;
    delete state.reports;
    (state.placePhotos as unknown[]).push({
      id: "photo-1", placeId: ridgeline, url: `/api/uploads/${UPLOAD}`, storagePath: null,
      uploaderId: jules.id, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    (state.authUsers as { email: string }[]).push({ email: "kept@example.com" } as never);
    return state;
  }

  it("carries a v1 store forward without losing user data", () => {
    const result = migrateDemoState(v1File());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.state.version).toBe(STATE_VERSION);
    expect(result.state.reports).toEqual([]);
    expect(result.state.authUsers.some((u) => u.email === "kept@example.com")).toBe(true);
    const photo = result.state.placePhotos.find((p) => p.id === "photo-1")!;
    expect(photo.storagePath).toBe(UPLOAD);
    expect(photo.url).toBe(`storage:place-photos/${UPLOAD}`);
  });

  it("is a no-op for a current store", () => {
    const result = migrateDemoState(buildSeedState());
    expect(result).toMatchObject({ ok: true, migratedFrom: null });
  });

  it("refuses files from a newer version or with an unknown shape", () => {
    expect(migrateDemoState({ ...buildSeedState(), version: STATE_VERSION + 1 })).toEqual({ ok: false, reason: "newer" });
    expect(migrateDemoState({ version: "1" })).toEqual({ ok: false, reason: "invalid" });
    expect(migrateDemoState([])).toEqual({ ok: false, reason: "invalid" });
    expect(migrateDemoState({ ...buildSeedState(), places: null })).toEqual({ ok: false, reason: "invalid" });
  });

  describe("on disk", () => {
    const dir = () => mkdtempSync(path.join(tmpdir(), "fm-demo-store-"));

    it("keeps a backup of the pre-migration file", () => {
      const d = dir();
      const file = path.join(d, "demo-store.json");
      const original = JSON.stringify(v1File());
      writeFileSync(file, original);
      const loaded = loadStateFile(file);
      expect(loaded?.migratedFrom).toBe(1);
      const backups = readdirSync(d).filter((f) => f.startsWith("demo-store.v1-"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(d, backups[0]), "utf8")).toBe(original);
    });

    it("backs up unreadable and newer files and throws instead of reseeding over them", () => {
      const d = dir();
      const file = path.join(d, "demo-store.json");

      writeFileSync(file, "{ not json");
      expect(() => loadStateFile(file)).toThrow(StoreLoadError);
      expect(readFileSync(file, "utf8")).toBe("{ not json");

      writeFileSync(file, JSON.stringify({ ...buildSeedState(), version: STATE_VERSION + 1 }));
      expect(() => loadStateFile(file)).toThrow(StoreLoadError);
      // The original file survives untouched — no reseed overwrote it.
      const reread = JSON.parse(readFileSync(file, "utf8")) as { version: number };
      expect(reread.version).toBe(STATE_VERSION + 1);

      const names = readdirSync(d);
      expect(names.some((f) => f.startsWith("demo-store.unreadable-"))).toBe(true);
      expect(names.some((f) => f.startsWith("demo-store.newer-"))).toBe(true);
    });

    it("returns null with no file and no backup", () => {
      const d = dir();
      expect(loadStateFile(path.join(d, "demo-store.json"))).toBeNull();
      expect(readdirSync(d)).toEqual([]);
    });
  });
});
