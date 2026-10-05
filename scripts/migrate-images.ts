/**
 * Re-encodes images stored before the image pipeline (Session 5): legacy place
 * photos get pipeline output with every display size, oversized avatars get
 * the 256px WebP. Each image goes to a new path and its row is repointed; see
 * src/lib/images/migrate.ts.
 *
 *   npx tsx scripts/migrate-images.ts [--dry-run] [--delete-originals] [--data-dir <path>]
 *
 * Run it from the repository root (tsx resolves the `@/` imports from there).
 * Mode follows the app: with NEXT_PUBLIC_SUPABASE_URL set it migrates Supabase
 * (needs SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS — run it from a trusted
 * machine only); otherwise it migrates the demo store in .data (or --data-dir). Stop the dev
 * server first in demo mode: it holds the store in memory and would write its
 * own copy back over the repointed rows.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { migrateImages, type ImageBucket, type ImageMigrationStore } from "../src/lib/images/migrate";
import { PLACE_PHOTO_BUCKET, placePhotoReference } from "../src/lib/data/photos";
import { loadStateFile } from "../src/lib/data/demo/store";

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const deleteOriginals = args.has("--delete-originals");
const dataDirArg = argv.indexOf("--data-dir");
const dataDir = path.resolve(dataDirArg >= 0 && argv[dataDirArg + 1] ? argv[dataDirArg + 1] : path.join(process.cwd(), ".data"));

// ----------------------------------------------------------------------------
// Supabase
// ----------------------------------------------------------------------------
const AVATAR_PUBLIC = /\/storage\/v1\/object\/public\/avatars\/(.+)$/;

function supabaseStore(url: string, serviceKey: string): ImageMigrationStore {
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  const bucketOf = (b: ImageBucket) => (b === "places" ? PLACE_PHOTO_BUCKET : "avatars");
  const avatarRows = new Map<string, string>();

  async function all<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
    const rows: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await query(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) return rows;
    }
  }

  return {
    async listPlacePhotos() {
      const rows = await all<{ id: string; storage_path: string }>((a, b) =>
        supabase.from("place_photos").select("id, storage_path").not("storage_path", "is", null).order("id").range(a, b),
      );
      return rows.map((r) => ({ id: r.id, storagePath: r.storage_path }));
    },
    async listAvatars() {
      const rows = await all<{ id: string; avatar_url: string }>((a, b) =>
        supabase.from("profiles").select("id, avatar_url").like("avatar_url", "%/storage/v1/object/public/avatars/%").order("id").range(a, b),
      );
      return rows.flatMap((r) => {
        const match = AVATAR_PUBLIC.exec(r.avatar_url);
        if (!match) return [];
        const storagePath = decodeURIComponent(match[1].split("?")[0]);
        avatarRows.set(r.id, storagePath);
        return [{ profileId: r.id, storagePath }];
      });
    },
    async exists(bucket, p) {
      const { data } = await supabase.storage.from(bucketOf(bucket)).exists(p);
      return data;
    },
    async read(bucket, p) {
      const { data, error } = await supabase.storage.from(bucketOf(bucket)).download(p);
      return error || !data ? null : new Uint8Array(await data.arrayBuffer());
    },
    async write(bucket, p, bytes) {
      const { error } = await supabase.storage.from(bucketOf(bucket)).upload(p, bytes, { contentType: "image/webp", upsert: false });
      if (error) throw new Error(`upload ${p}: ${error.message}`);
    },
    async remove(bucket, paths) {
      if (!paths.length) return;
      const { error } = await supabase.storage.from(bucketOf(bucket)).remove(paths);
      if (error) throw new Error(`remove: ${error.message}`);
    },
    newPath(_bucket, oldPath) {
      return `${path.posix.dirname(oldPath)}/${randomUUID()}.webp`;
    },
    async repointPlacePhoto(id, storagePath) {
      const { error } = await supabase.from("place_photos").update({ storage_path: storagePath, url: placePhotoReference(storagePath) }).eq("id", id);
      if (error) throw new Error(`repoint photo ${id}: ${error.message}`);
    },
    async repointAvatar(profileId, storagePath) {
      const avatarUrl = supabase.storage.from("avatars").getPublicUrl(storagePath).data.publicUrl;
      const { error } = await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", profileId);
      if (error) throw new Error(`repoint avatar ${profileId}: ${error.message}`);
    },
    // Each repoint above is already a committed update.
    async commit() {},
  };
}

// ----------------------------------------------------------------------------
// Demo store (.data/demo-store.json + .data/uploads)
// ----------------------------------------------------------------------------
function demoStore(dataDir: string): ImageMigrationStore {
  const stateFile = path.join(dataDir, "demo-store.json");
  const uploads = path.join(dataDir, "uploads");
  const loaded = loadStateFile(stateFile);
  if (!loaded) throw new Error(`No demo store at ${stateFile}; nothing to migrate.`);
  const { state } = loaded;
  const AVATAR_URL = /^\/api\/uploads\/(avatars-[^/]+)$/;
  // Demo names encode the owner prefix: places-<owner8>-<uuid>.webp
  const owner = (name: string) => /^(?:places|avatars)-([0-9a-f]{8})-/.exec(name)?.[1] ?? "00000000";
  const file = (p: string) => path.join(uploads, path.basename(p));

  return {
    async listPlacePhotos() {
      return state.placePhotos.flatMap((p) => (p.storagePath ? [{ id: p.id, storagePath: p.storagePath }] : []));
    },
    async listAvatars() {
      return state.profiles.flatMap((p) => {
        const match = p.avatarUrl ? AVATAR_URL.exec(p.avatarUrl) : null;
        return match ? [{ profileId: p.id, storagePath: match[1] }] : [];
      });
    },
    async exists(_bucket, p) {
      return existsSync(file(p));
    },
    async read(_bucket, p) {
      try {
        return new Uint8Array(readFileSync(file(p)));
      } catch {
        return null;
      }
    },
    async write(_bucket, p, bytes) {
      mkdirSync(uploads, { recursive: true });
      writeFileSync(file(p), bytes, { flag: "wx" });
    },
    async remove(_bucket, paths) {
      for (const p of paths) {
        try { unlinkSync(file(p)); } catch { /* already gone */ }
      }
    },
    newPath(bucket, oldPath) {
      return `${bucket}-${owner(path.basename(oldPath))}-${randomUUID()}.webp`;
    },
    async repointPlacePhoto(id, storagePath) {
      const photo = state.placePhotos.find((p) => p.id === id);
      if (!photo) throw new Error(`photo ${id} not found`);
      photo.storagePath = storagePath;
      photo.url = placePhotoReference(storagePath);
    },
    async repointAvatar(profileId, storagePath) {
      const profile = state.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`profile ${profileId} not found`);
      profile.avatarUrl = `/api/uploads/${storagePath}`;
    },
    // Repoints live in memory until here; the migration deletes originals only afterwards.
    async commit() {
      const backup = `${stateFile}.pre-image-migration-${Date.now()}.bak.json`;
      copyFileSync(stateFile, backup);
      const temp = `${stateFile}.tmp`;
      writeFileSync(temp, JSON.stringify(state));
      renameSync(temp, stateFile); // atomic: never a half-written store
      console.log(`Demo store updated; previous copy at ${backup}`);
    },
  };
}

// ----------------------------------------------------------------------------
async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let store: ImageMigrationStore;
  if (url) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY to migrate Supabase Storage.");
    store = supabaseStore(url, key);
    console.log(`Migrating Supabase at ${url}${dryRun ? " (dry run)" : ""}`);
  } else {
    store = demoStore(dataDir);
    console.log(`Migrating the demo store in ${dataDir}${dryRun ? " (dry run)" : ""}`);
  }

  const report = await migrateImages(store, { dryRun, deleteOriginals, log: (line) => console.log(line) });

  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  console.log(
    `\n${report.migrated} ${dryRun ? "to migrate" : "migrated"}, ${report.current} already current, ${report.skipped} skipped, ${report.failed.length} failed` +
      (report.migrated ? ` · ${kb(report.bytesBefore)} → ${kb(report.bytesAfter)} (all sizes)` : ""),
  );
  for (const f of report.failed) console.log(`  failed ${f.path}: ${f.reason}`);
  if (report.failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
