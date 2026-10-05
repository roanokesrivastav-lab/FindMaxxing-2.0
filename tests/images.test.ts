/**
 * The image pipeline: what it accepts, what it strips, what it produces, and
 * whether a six-photo place page fits the mobile transfer budget, both for new
 * uploads and for legacy originals once migrated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import {
  AVATAR_EDGE,
  ImageRejectedError,
  MAX_CONCURRENT_IMAGES,
  withImageSlot,
  MIN_PLACE_PHOTO_EDGE,
  PLACE_PHOTO_EDGE,
  processAvatar,
  processPlacePhoto,
} from "../src/lib/images/pipeline";
import {
  BUDGET_VIEWPORT,
  PHOTO_LAYOUT_SIZES,
  SIX_PHOTO_PAGE_BUDGET_BYTES,
  parsePhotoSize,
  photoObjectPaths,
  photoSrc,
  photoSrcSet,
  photoVariantPath,
  pickPhotoSize,
} from "../src/lib/images/sizes";
import { migrateImages, type ImageBucket, type ImageMigrationStore } from "../src/lib/images/migrate";
import { sniffImageType } from "../src/lib/data/photos";

/**
 * A phone-like photo: detail at every scale (as in real scenes), saved as a
 * high-quality JPEG the size phones produce. A 4032×3024 one is ~4MB, and its
 * pipeline output is at the heavy end of real photos, so the budget is not met
 * by accident. Pure noise would be an unrealistic worst case, a flat color an
 * unrealistic best case.
 */
async function phonePhoto(seed: number, width = 4032, height = 3024): Promise<Buffer> {
  const layer = (w: number, sigma: number) =>
    sharp({ create: { width: w, height: Math.round((w * height) / width), channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma } } })
      .resize(width, height, { kernel: "cubic" })
      .png()
      .toBuffer();
  const base = { r: 80 + ((seed * 37) % 60), g: 100 + ((seed * 23) % 50), b: 150 - ((seed * 17) % 60) };
  const layers = await Promise.all(
    ([[60, 60], [240, 25], [800, 25], [1600, 20]] as const).map(([w, sigma]) => layer(Math.min(w, width), sigma)),
  );
  return sharp({ create: { width, height, channels: 3, background: base } })
    .composite(layers.map((input) => ({ input, blend: "overlay" as const })))
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ImageRejectedError);
    return (err as Error).message;
  }
  throw new Error("expected the image to be rejected");
}

describe("image pipeline: validation", () => {
  it("decides the format from the bytes, not the name or declared type", async () => {
    expect(await rejection(processPlacePhoto(new TextEncoder().encode("definitely not a jpeg")))).toMatch(/isn't an image/);
    const gif = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#f00" } }).gif().toBuffer();
    expect(await rejection(processPlacePhoto(gif))).toMatch(/JPG, PNG or WebP/);
  });

  it("refuses images too small to show", async () => {
    const tiny = await sharp({ create: { width: MIN_PLACE_PHOTO_EDGE - 1, height: 800, channels: 3, background: "#0a0" } }).png().toBuffer();
    expect(await rejection(processPlacePhoto(tiny))).toMatch(/too small/);
  });

  it("refuses decompression bombs before decoding them", async () => {
    // 48 megapixels of one color: a small file that would expand to ~140MB of pixels.
    const bomb = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "#123" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.byteLength).toBeLessThan(2_000_000);
    expect(await rejection(processPlacePhoto(bomb))).toMatch(/40 megapixels/);
  });

  it("refuses animated images", async () => {
    const frame = (c: string) => sharp({ create: { width: 300, height: 300, channels: 3, background: c } }).png().toBuffer();
    const animated = await sharp([await frame("#f00"), await frame("#00f")], { join: { animated: true } }).webp().toBuffer();
    expect(await rejection(processPlacePhoto(animated))).toMatch(/Animated/);
  });
});

describe("image pipeline: output", () => {
  it("applies EXIF orientation and strips every piece of metadata", async () => {
    // Stored landscape, tagged "rotate 90°": it displays as portrait.
    const tagged = await sharp(await phonePhoto(1, 1200, 800))
      .withExif({ IFD0: { Copyright: "home address", Artist: "someone" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const out = await processPlacePhoto(tagged);
    for (const bytes of [out.main, out.variants.md, out.variants.sm]) {
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.height).toBeGreaterThan(meta.width!);
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
  });

  it("produces every size at its long edge, never enlarging", async () => {
    const out = await processPlacePhoto(await phonePhoto(2));
    const dims = async (b: Uint8Array) => {
      const m = await sharp(b).metadata();
      return Math.max(m.width!, m.height!);
    };
    expect(await dims(out.main)).toBe(PLACE_PHOTO_EDGE.lg);
    expect(await dims(out.variants.md)).toBe(PLACE_PHOTO_EDGE.md);
    expect(await dims(out.variants.sm)).toBe(PLACE_PHOTO_EDGE.sm);
    expect([out.width, out.height]).toEqual([1600, 1200]);

    const small = await processPlacePhoto(await phonePhoto(3, 640, 480));
    expect(await dims(small.main)).toBe(640);
    expect(await dims(small.variants.md)).toBe(640);
    expect(await dims(small.variants.sm)).toBe(480);
  });

  it("makes square avatars", async () => {
    const { main } = await processAvatar(await phonePhoto(4, 1200, 900));
    const meta = await sharp(main).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", AVATAR_EDGE, AVATAR_EDGE]);
    expect(main.byteLength).toBeLessThan(30 * 1024);
  });

  it("sniffs the stored content type from the bytes", async () => {
    const { main } = await processAvatar(await phonePhoto(5, 400, 400));
    expect(sniffImageType(main)).toBe("image/webp");
    expect(sniffImageType(await sharp(main).jpeg().toBuffer())).toBe("image/jpeg");
    expect(sniffImageType(await sharp(main).png().toBuffer())).toBe("image/png");
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
  });
});

describe("image processing concurrency", () => {
  it("never runs more than MAX_CONCURRENT_IMAGES jobs at once, and runs them all", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        withImageSlot(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(MAX_CONCURRENT_IMAGES);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("frees the slot when a job fails", async () => {
    await expect(withImageSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(Promise.all(Array.from({ length: MAX_CONCURRENT_IMAGES }, () => withImageSlot(async () => 1)))).resolves.toHaveLength(MAX_CONCURRENT_IMAGES);
  });
});

describe("photo sizes and paths", () => {
  it("derives every size's object from the photo's storage path", () => {
    expect(photoVariantPath("u/abc.webp", "lg")).toBe("u/abc.webp");
    expect(photoVariantPath("u/abc.webp", "md")).toBe("u/abc.md.webp");
    expect(photoVariantPath("u/abc.JPG", "sm")).toBe("u/abc.sm.webp");
    expect(photoObjectPaths("places-0a1b2c3d-x.webp")).toEqual(["places-0a1b2c3d-x.sm.webp", "places-0a1b2c3d-x.md.webp", "places-0a1b2c3d-x.webp"]);
    expect(parsePhotoSize("md")).toBe("md");
    expect(parsePhotoSize("xl")).toBe("lg");
    expect(parsePhotoSize(null)).toBe("lg");
  });

  it("offers a srcSet only for photos served by the authorized route", () => {
    expect(photoSrc("/api/photos/1", "sm")).toBe("/api/photos/1?size=sm");
    expect(photoSrcSet("/api/photos/1")).toBe("/api/photos/1?size=sm 480w, /api/photos/1?size=md 960w, /api/photos/1?size=lg 1600w");
    expect(photoSrc("https://images.example/a.jpg", "sm")).toBe("https://images.example/a.jpg");
    expect(photoSrcSet("https://images.example/a.jpg")).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// The done-when check: a six-photo place page on a phone.
// ----------------------------------------------------------------------------

/** CSS width of the no-media-query (phone) slot in a `sizes` value, at a viewport width. */
function phoneSlotWidth(sizes: string, viewport: number): number {
  const slot = sizes.split(",").at(-1)!.trim();
  const calc = /^calc\((\d+)vw - (\d+)px\)$/.exec(slot);
  if (calc) return (viewport * Number(calc[1])) / 100 - Number(calc[2]);
  const vw = /^(\d+)vw$/.exec(slot);
  if (vw) return (viewport * Number(vw[1])) / 100;
  const px = /^(\d+)px$/.exec(slot);
  if (px) return Number(px[1]);
  throw new Error(`unhandled sizes slot: ${slot}`);
}

/** Bytes a phone downloads for the page: the hero plus all six gallery images. */
function pageBytes(photos: { lg: number; md: number; sm: number }[]) {
  const hero = pickPhotoSize(phoneSlotWidth(PHOTO_LAYOUT_SIZES.hero, BUDGET_VIEWPORT.width), BUDGET_VIEWPORT.dpr);
  const gallery = pickPhotoSize(phoneSlotWidth(PHOTO_LAYOUT_SIZES.gallery, BUDGET_VIEWPORT.width), BUDGET_VIEWPORT.dpr);
  return { hero, gallery, total: photos[0][hero] + photos.reduce((n, p) => n + p[gallery], 0) };
}

describe("six-photo mobile page budget", () => {
  let originals: Buffer[];
  beforeAll(async () => {
    originals = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => phonePhoto(10 + i)));
  });

  it("picks the sizes the budget assumes", () => {
    expect(phoneSlotWidth(PHOTO_LAYOUT_SIZES.hero, 412)).toBe(412);
    expect(phoneSlotWidth(PHOTO_LAYOUT_SIZES.gallery, 412)).toBe(186);
    expect(pickPhotoSize(412, 1.75)).toBe("md");
    expect(pickPhotoSize(186, 1.75)).toBe("sm");
  });

  it("keeps new uploads within the budget", async () => {
    const processed = await Promise.all(originals.map((b) => processPlacePhoto(b)));
    const { hero, gallery, total } = pageBytes(
      processed.map((p) => ({ lg: p.main.byteLength, md: p.variants.md.byteLength, sm: p.variants.sm.byteLength })),
    );
    expect([hero, gallery]).toEqual(["md", "sm"]);
    expect(total).toBeLessThanOrEqual(SIX_PHOTO_PAGE_BUDGET_BYTES);
  }, 30_000);

  it("brings legacy originals within the budget once migrated", async () => {
    const legacy = originals.map((bytes, i) => ({ id: `photo-${i}`, storagePath: `owner/legacy-${i}.jpg`, bytes }));
    const unmigrated = pageBytes(legacy.map((l) => ({ lg: l.bytes.byteLength, md: l.bytes.byteLength, sm: l.bytes.byteLength })));
    // Before: every size falls back to the full original, far over budget.
    expect(unmigrated.total).toBeGreaterThan(SIX_PHOTO_PAGE_BUDGET_BYTES * 4);

    const store = memoryStore(legacy.map((l) => ({ id: l.id, storagePath: l.storagePath })), []);
    for (const l of legacy) store.objects.set(`places:${l.storagePath}`, new Uint8Array(l.bytes));
    const report = await migrateImages(store);
    expect(report).toMatchObject({ migrated: 6, failed: [] });

    const sizeOf = (p: string) => store.objects.get(`places:${p}`)!.byteLength;
    const after = pageBytes(
      store.photos.map((p) => ({ lg: sizeOf(p.storagePath), md: sizeOf(photoVariantPath(p.storagePath, "md")), sm: sizeOf(photoVariantPath(p.storagePath, "sm")) })),
    );
    expect(after.total).toBeLessThanOrEqual(SIX_PHOTO_PAGE_BUDGET_BYTES);
  }, 30_000);
});

// ----------------------------------------------------------------------------
// Migration
// ----------------------------------------------------------------------------
function memoryStore(photos: { id: string; storagePath: string }[], avatars: { profileId: string; storagePath: string }[]) {
  const objects = new Map<string, Uint8Array>();
  const key = (b: ImageBucket, p: string) => `${b}:${p}`;
  let n = 0;
  const store: ImageMigrationStore & {
    objects: typeof objects;
    photos: typeof photos;
    avatars: typeof avatars;
    failRepoint: boolean;
    failCommit: boolean;
    /** Order of commits and removals, to check originals go only after a commit. */
    events: string[];
  } = {
    objects,
    photos,
    avatars,
    failRepoint: false,
    failCommit: false,
    events: [],
    async listPlacePhotos() {
      return photos.map((p) => ({ ...p }));
    },
    async listAvatars() {
      return avatars.map((a) => ({ ...a }));
    },
    async exists(b, p) {
      return objects.has(key(b, p));
    },
    async read(b, p) {
      return objects.get(key(b, p)) ?? null;
    },
    async write(b, p, bytes) {
      if (objects.has(key(b, p))) throw new Error(`would overwrite ${p}`);
      objects.set(key(b, p), bytes);
    },
    async remove(b, paths) {
      for (const p of paths) {
        store.events.push(`remove ${b}:${p}`);
        objects.delete(key(b, p));
      }
    },
    newPath(_b, oldPath) {
      return `${oldPath.split("/")[0]}/new-${++n}.webp`;
    },
    async repointPlacePhoto(id, storagePath) {
      if (store.failRepoint) throw new Error("database unavailable");
      photos.find((p) => p.id === id)!.storagePath = storagePath;
    },
    async repointAvatar(profileId, storagePath) {
      avatars.find((a) => a.profileId === profileId)!.storagePath = storagePath;
    },
    async commit() {
      if (store.failCommit) throw new Error("disk full");
      store.events.push("commit");
    },
  };
  return store;
}

describe("image migration", () => {
  it("writes new objects, repoints rows, keeps originals, and is idempotent", async () => {
    const original = new Uint8Array(await phonePhoto(20, 2000, 1500));
    const avatar = new Uint8Array(await phonePhoto(21, 900, 900));
    const store = memoryStore([{ id: "p1", storagePath: "u1/old.jpg" }], [{ profileId: "a1", storagePath: "u1/me.png" }]);
    store.objects.set("places:u1/old.jpg", original);
    store.objects.set("avatars:u1/me.png", avatar);

    const dry = await migrateImages(store, { dryRun: true });
    expect(dry.migrated).toBe(2);
    expect(store.photos[0].storagePath).toBe("u1/old.jpg"); // dry run changes nothing
    expect(store.objects.size).toBe(2);

    const first = await migrateImages(store);
    expect(first).toMatchObject({ migrated: 2, current: 0, failed: [] });
    expect(first.bytesAfter).toBeLessThan(first.bytesBefore);
    const moved = store.photos[0].storagePath;
    expect(moved).toMatch(/^u1\/new-\d+\.webp$/);
    for (const path of photoObjectPaths(moved)) expect(store.objects.has(`places:${path}`)).toBe(true);
    expect(store.objects.get("places:u1/old.jpg")).toBe(original); // backup kept
    const newAvatar = await sharp(store.objects.get(`avatars:${store.avatars[0].storagePath}`)!).metadata();
    expect([newAvatar.format, newAvatar.width]).toEqual(["webp", AVATAR_EDGE]);

    const second = await migrateImages(store);
    expect(second).toMatchObject({ migrated: 0, current: 2, failed: [] });
  }, 30_000);

  it("removes originals only when asked, and only after the repoints are committed", async () => {
    const store = memoryStore([{ id: "p1", storagePath: "u1/old.jpg" }, { id: "p2", storagePath: "u1/old2.png" }], []);
    store.objects.set("places:u1/old.jpg", new Uint8Array(await phonePhoto(22, 1000, 800)));
    store.objects.set("places:u1/old2.png", new Uint8Array(await sharp(await phonePhoto(24, 800, 600)).png().toBuffer()));
    await migrateImages(store, { deleteOriginals: true });
    expect(store.objects.has("places:u1/old.jpg")).toBe(false);
    expect(store.objects.has("places:u1/old2.png")).toBe(false);
    expect(store.events).toEqual(["commit", "remove places:u1/old.jpg", "remove places:u1/old2.png"]);
  });

  it("keeps every original when the repoints cannot be committed", async () => {
    const store = memoryStore([{ id: "p1", storagePath: "u1/old.jpg" }], []);
    const original = new Uint8Array(await phonePhoto(25, 1000, 800));
    store.objects.set("places:u1/old.jpg", original);
    store.failCommit = true;
    await expect(migrateImages(store, { deleteOriginals: true })).rejects.toThrow("disk full");
    expect(store.objects.get("places:u1/old.jpg")).toBe(original);
    expect(store.events.filter((e) => e.startsWith("remove"))).toEqual([]);
  });

  it("does not commit when nothing was migrated", async () => {
    const store = memoryStore([], []);
    await migrateImages(store);
    expect(store.events).toEqual([]);
  });

  it("re-migrates a photo whose medium size is missing, even with the small one present", async () => {
    const photo = await processPlacePhoto(await phonePhoto(26, 1200, 900));
    const store = memoryStore([{ id: "p1", storagePath: "u1/half.webp" }], []);
    store.objects.set("places:u1/half.webp", photo.main);
    store.objects.set("places:u1/half.sm.webp", photo.variants.sm);
    const report = await migrateImages(store);
    expect(report).toMatchObject({ migrated: 1, current: 0 });
    for (const path of photoObjectPaths(store.photos[0].storagePath)) expect(store.objects.has(`places:${path}`)).toBe(true);
  });

  it("cleans up its own writes when repointing fails, leaving the photo as it was", async () => {
    const store = memoryStore([{ id: "p1", storagePath: "u1/old.jpg" }], []);
    store.objects.set("places:u1/old.jpg", new Uint8Array(await phonePhoto(23, 1000, 800)));
    store.failRepoint = true;
    const report = await migrateImages(store);
    expect(report.failed).toEqual([{ path: "places/u1/old.jpg", reason: "database unavailable" }]);
    expect([...store.objects.keys()]).toEqual(["places:u1/old.jpg"]);
    expect(store.photos[0].storagePath).toBe("u1/old.jpg");
  });

  it("skips images the pipeline refuses and reports missing objects", async () => {
    const store = memoryStore(
      [{ id: "tiny", storagePath: "u1/tiny.png" }, { id: "gone", storagePath: "u1/gone.jpg" }],
      [],
    );
    store.objects.set("places:u1/tiny.png", new Uint8Array(await sharp({ create: { width: 50, height: 50, channels: 3, background: "#000" } }).png().toBuffer()));
    const report = await migrateImages(store);
    expect(report).toMatchObject({ migrated: 0, skipped: 1 });
    expect(report.failed).toEqual([{ path: "places/u1/gone.jpg", reason: "object missing" }]);
    expect(store.photos[0].storagePath).toBe("u1/tiny.png");
  });
});
