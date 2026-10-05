/**
 * Brings images stored before the pipeline existed up to its output: legacy
 * place photos (full-size originals, no smaller sizes) and oversized avatars.
 *
 * Each image is re-encoded and written to a NEW path, then its row is repointed.
 * Nothing is overwritten, so a browser holding the old bytes never revalidates
 * into a stale copy (the photo route's ETag is keyed on the path). Originals
 * stay in Storage as a backup unless the run passes `deleteOriginals`; once a
 * row is repointed, a later run no longer sees its original.
 *
 * The storage and database access is behind ImageMigrationStore so the same
 * logic runs against Supabase, the demo store, and an in-memory test double.
 */
import sharp from "sharp";
import { AVATAR_EDGE, ImageRejectedError, processAvatar, processPlacePhoto } from "./pipeline";
import { photoVariantPath } from "./sizes";

export type ImageBucket = "places" | "avatars";

export interface ImageMigrationStore {
  listPlacePhotos(): Promise<{ id: string; storagePath: string }[]>;
  listAvatars(): Promise<{ profileId: string; storagePath: string }[]>;
  exists(bucket: ImageBucket, path: string): Promise<boolean>;
  read(bucket: ImageBucket, path: string): Promise<Uint8Array | null>;
  write(bucket: ImageBucket, path: string, bytes: Uint8Array): Promise<void>;
  remove(bucket: ImageBucket, paths: string[]): Promise<void>;
  /** A fresh path in the same owner's space as `oldPath`, ending in .webp. */
  newPath(bucket: ImageBucket, oldPath: string): string;
  repointPlacePhoto(photoId: string, storagePath: string): Promise<void>;
  repointAvatar(profileId: string, storagePath: string): Promise<void>;
  /**
   * Makes every repoint so far durable. Originals are deleted only after this
   * succeeds, so a crash can never leave a row pointing at a deleted object.
   * A no-op where each repoint is already its own committed write (Supabase).
   */
  commit(): Promise<void>;
}

export interface MigrationOptions {
  dryRun?: boolean;
  /** Remove the originals once every replacement is stored, repointed and committed. */
  deleteOriginals?: boolean;
  log?: (line: string) => void;
}

export interface MigrationReport {
  migrated: number;
  skipped: number;
  /** Already pipeline output. */
  current: number;
  failed: { path: string; reason: string }[];
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * A place photo is current once both smaller sizes exist beside it. With either
 * missing, requests for it would fall back to the full-size object every time.
 */
async function placePhotoIsCurrent(store: ImageMigrationStore, storagePath: string) {
  if (!storagePath.endsWith(".webp")) return false;
  const [md, sm] = await Promise.all(
    (["md", "sm"] as const).map((size) => store.exists("places", photoVariantPath(storagePath, size))),
  );
  return md && sm;
}

/** An avatar is current when it is WebP and no larger than the pipeline makes it. */
async function avatarIsCurrent(bytes: Uint8Array) {
  const meta = await sharp(bytes).metadata().catch(() => null);
  return !!meta && meta.format === "webp" && (meta.width ?? 0) <= AVATAR_EDGE && (meta.height ?? 0) <= AVATAR_EDGE;
}

export async function migrateImages(store: ImageMigrationStore, opts: MigrationOptions = {}): Promise<MigrationReport> {
  const log = opts.log ?? (() => {});
  const report: MigrationReport = { migrated: 0, skipped: 0, current: 0, failed: [], bytesBefore: 0, bytesAfter: 0 };
  // Deleted only after commit(); see ImageMigrationStore.commit.
  const replacedOriginals: { bucket: ImageBucket; path: string }[] = [];

  const replace = async (
    bucket: ImageBucket,
    oldPath: string,
    original: Uint8Array,
    produce: () => Promise<{ main: Uint8Array; variants?: Partial<Record<"sm" | "md", Uint8Array>> }>,
    repoint: (path: string) => Promise<void>,
  ) => {
    let out;
    try {
      out = await produce();
    } catch (err) {
      if (err instanceof ImageRejectedError) {
        // Too small or not really an image: leave it as it is, the route still serves it.
        report.skipped += 1;
        log(`skip ${bucket}/${oldPath}: ${err.message}`);
        return;
      }
      throw err;
    }
    const after = out.main.byteLength + Object.values(out.variants ?? {}).reduce((n, b) => n + (b?.byteLength ?? 0), 0);
    report.bytesBefore += original.byteLength;
    report.bytesAfter += after;
    if (opts.dryRun) {
      report.migrated += 1;
      log(`would migrate ${bucket}/${oldPath}: ${original.byteLength} → ${out.main.byteLength} bytes`);
      return;
    }
    const newPath = store.newPath(bucket, oldPath);
    const written: string[] = [];
    try {
      for (const size of ["sm", "md"] as const) {
        const bytes = out.variants?.[size];
        if (!bytes) continue;
        const path = photoVariantPath(newPath, size);
        await store.write(bucket, path, bytes);
        written.push(path);
      }
      // The main object last: its row is repointed only once every size exists.
      await store.write(bucket, newPath, out.main);
      written.push(newPath);
      await repoint(newPath);
    } catch (err) {
      await store.remove(bucket, written).catch(() => {});
      throw err;
    }
    replacedOriginals.push({ bucket, path: oldPath });
    report.migrated += 1;
    log(`migrated ${bucket}/${oldPath} → ${newPath}: ${original.byteLength} → ${out.main.byteLength} bytes`);
  };

  for (const photo of await store.listPlacePhotos()) {
    try {
      if (await placePhotoIsCurrent(store, photo.storagePath)) {
        report.current += 1;
        continue;
      }
      const original = await store.read("places", photo.storagePath);
      if (!original) throw new Error("object missing");
      await replace("places", photo.storagePath, original, () => processPlacePhoto(original), (path) => store.repointPlacePhoto(photo.id, path));
    } catch (err) {
      report.failed.push({ path: `places/${photo.storagePath}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const avatar of await store.listAvatars()) {
    try {
      const original = await store.read("avatars", avatar.storagePath);
      if (!original) throw new Error("object missing");
      if (await avatarIsCurrent(original)) {
        report.current += 1;
        continue;
      }
      await replace("avatars", avatar.storagePath, original, () => processAvatar(original), (path) => store.repointAvatar(avatar.profileId, path));
    } catch (err) {
      report.failed.push({ path: `avatars/${avatar.storagePath}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!replacedOriginals.length) return report;
  // Throws if the repoints cannot be made durable: originals are then untouched.
  await store.commit();
  if (opts.deleteOriginals) {
    for (const { bucket, path } of replacedOriginals) {
      try {
        await store.remove(bucket, [path]);
      } catch (err) {
        // The row already points at the replacement; a leftover original is only wasted space.
        report.failed.push({ path: `${bucket}/${path}`, reason: `original not deleted: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }
  return report;
}
