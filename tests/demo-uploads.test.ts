/**
 * Demo-mode storage of pipeline output: every size is written, delivered and
 * removed together. Runs in a temporary directory, since the demo store keeps
 * uploads under the working directory's .data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const cwd = process.cwd();
const dir = mkdtempSync(path.join(tmpdir(), "findmaxxing-uploads-"));
let repo: DataRepository;
let processPlacePhoto: typeof import("../src/lib/images/pipeline").processPlacePhoto;
const jules = SEED_USERS.find((u) => u.username === "jules")!.id;

beforeAll(async () => {
  process.chdir(dir);
  // Imported after chdir: the upload directory is resolved at module load.
  const [{ createIsolatedStore }, { createDemoRepository }, pipeline] = await Promise.all([
    import("../src/lib/data/demo/store"),
    import("../src/lib/data/demo/repository"),
    import("../src/lib/images/pipeline"),
  ]);
  repo = createDemoRepository(createIsolatedStore());
  processPlacePhoto = pipeline.processPlacePhoto;
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const uploads = () => readdirSync(path.join(dir, ".data", "uploads")).sort();

describe("demo storage of processed photos", () => {
  it("stores, delivers and removes every size of a photo", async () => {
    const photo = await processPlacePhoto(await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#468" } }).jpeg().toBuffer());
    const stored = await repo.storage.uploadImage(photo, "places", jules);
    expect(stored.storagePath).toMatch(/^places-[0-9a-f]{8}-[0-9a-f-]{36}\.webp$/);
    const stem = stored.storagePath!.replace(/\.webp$/, "");
    expect(uploads()).toEqual([`${stem}.md.webp`, `${stem}.sm.webp`, `${stem}.webp`]);

    const sm = await repo.storage.deliverPlacePhoto(`${stem}.sm.webp`);
    expect(sm?.contentType).toBe("image/webp");
    expect(sm?.body.byteLength).toBe(photo.variants.sm.byteLength);

    await repo.storage.removeImage("places", stored.storagePath!);
    expect(uploads()).toEqual([]);
  });

  it("removes every size when the place itself is deleted", async () => {
    const photo = await processPlacePhoto(await sharp({ create: { width: 800, height: 600, channels: 3, background: "#864" } }).png().toBuffer());
    const stored = await repo.storage.uploadImage(photo, "places", jules);
    const ridgeline = stableId("place:Ridgeline Loop");
    await repo.places.addPhotos(ridgeline, [stored], jules);
    expect(uploads()).toHaveLength(3);
    await repo.places.delete(ridgeline, jules);
    expect(uploads()).toEqual([]);
    expect(existsSync(path.join(dir, ".data", "demo-store.json"))).toBe(false); // isolated store never persists
  });
});
