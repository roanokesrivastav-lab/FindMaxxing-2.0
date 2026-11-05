/**
 * Roadmap 2.8: public and personal place photos (0063_personal_photos.sql).
 *
 * The privacy promise: a personal photo is reachable by its owner and nobody else:
 * not anon, another user, a friend (mutual follow), a moderator or an admin; not
 * through the table, the storage objects, the delivery route, the place page, share
 * metadata or recommendations. The first rating needs one; saving, joining an event
 * and bulk marking visited never do. The upload keeps the pipeline's metadata
 * stripping. The public photo is team-set with a permission note and leads.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore, type StoreHandle } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { ToastProvider } from "../src/components/ui/Toast";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";

const ctx = vi.hoisted(() => ({ repo: null as unknown as DataRepository, viewer: null as { id: string } | null }));
// Keep this suite's demo uploads out of the developer's .data folder.
vi.mock("@/lib/data/demo/uploads", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  return { UPLOAD_DIR: mkdtempSync(`${tmpdir()}/fm-personal-`) };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT", to });
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));
vi.mock("@/components/map/MiniMap", () => ({ MiniMap: () => null }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const place = (name: string) => stableId(`place:${name}`);
const maya = user("maya_r"); // the owner
const theo = user("theo"); // maya's friend (mutual follow)
const nina = user("nina"); // another user
const mod = user("mo_moderator");
const admin = user("dev");
const cannon = place("Cannon & Crown"); // maya already rated it
const annex = place("Hollow Oak Print Studio"); // neither maya nor nina has rated it
const basement = place("Fourth Street Basement"); // locals-only

async function photoFile(secret: string): Promise<File> {
  const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#7a5" } })
    .withExif({ IFD0: { Copyright: secret, Artist: secret } })
    .jpeg()
    .toBuffer();
  return new File([new Uint8Array(jpeg)], "me.jpg", { type: "image/jpeg" });
}

describe("personal photos in the database (as PostgREST and Storage would see it)", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const obj = `${maya}/mine.webp`;

  beforeAll(async () => {
    db = await createSeededDb();
    await db.exec(`
      alter table storage.objects enable row level security;
      grant usage on schema storage to anon, authenticated;
      grant select, insert, update, delete on storage.objects to anon, authenticated;
    `);
    await as(maya, "insert into storage.objects (bucket_id, name) values ('personal-photos', $1)", [obj]);
    await as(maya, "insert into public.personal_place_photos (user_id, place_id, storage_path) values ($1, $2, $3)", [maya, cannon, obj]);
  });

  it("the bucket is private and separate from place-photos", async () => {
    const { rows } = await db.query<{ public: boolean }>("select public from storage.buckets where id = 'personal-photos'");
    expect(rows).toEqual([{ public: false }]);
  });

  it("only the owner can read the row or the object: not anon, another user, a friend, a moderator or an admin", async () => {
    expect(await as(maya, "select place_id from public.personal_place_photos")).toHaveLength(1);
    expect(await as(maya, "select name from storage.objects where bucket_id = 'personal-photos'")).toHaveLength(1);
    for (const viewer of [null, nina, theo, mod, admin]) {
      // anon has no table privilege at all (permission denied); everyone else sees no rows.
      expect(await as(viewer, "select place_id from public.personal_place_photos where user_id = $1", [maya]).catch(() => []), String(viewer)).toHaveLength(0);
      expect(await as(viewer, "select name from storage.objects where bucket_id = 'personal-photos' and name = $1", [obj]), String(viewer)).toHaveLength(0);
      // Nor change or delete them.
      expect(await as(viewer, "delete from storage.objects where bucket_id = 'personal-photos' and name = $1 returning name", [obj]).catch(() => [])).toHaveLength(0);
      expect(await as(viewer, "update public.personal_place_photos set storage_path = $2 where user_id = $1 returning 1", [maya, `${maya}/x.webp`]).catch(() => [])).toHaveLength(0);
    }
  });

  it("nobody writes into someone else's folder or claims their object", async () => {
    await expect(as(nina, "insert into storage.objects (bucket_id, name) values ('personal-photos', $1)", [`${maya}/planted.webp`])).rejects.toThrow();
    await expect(as(null, "insert into storage.objects (bucket_id, name) values ('personal-photos', $1)", [`${maya}/anon.webp`])).rejects.toThrow();
    await expect(as(nina, "insert into public.personal_place_photos (user_id, place_id, storage_path) values ($1, $2, $3)", [maya, annex, `${maya}/x.webp`])).rejects.toThrow();
    // A row pointing at someone else's object is refused by the folder check.
    await expect(as(nina, "insert into public.personal_place_photos (user_id, place_id, storage_path) values ($1, $2, $3)", [nina, annex, obj])).rejects.toThrow(/own_folder|unique/);
    // And not on a place the user cannot see.
    await expect(as(nina, "insert into public.personal_place_photos (user_id, place_id, storage_path) values ($1, $2, $3)", [nina, basement, `${nina}/b.webp`])).rejects.toThrow();
  });

  it("the place-photo visibility rules never open it, and no function or view reads the table", async () => {
    const [{ v }] = await as<{ v: boolean }>(nina, "select public.can_view_place_photo_object($1) as v", [obj]);
    expect(v).toBe(false);
    const fns = await db.query<{ proname: string }>("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~* 'personal_place_photos|personal-photos'");
    expect(fns.rows.map((r) => r.proname)).toEqual([]);
    const views = await db.query("select viewname from pg_views where schemaname = 'public' and definition ~* 'personal_place_photos'");
    expect(views.rows).toEqual([]);
  });

  it("account deletion collects the owner's personal objects for removal", async () => {
    // prepare_account_deletion lists every object under the user's folder, in any bucket.
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from storage.objects where name like $1 || '/%' and bucket_id = 'personal-photos'", [maya]);
    expect(rows[0].n).toBe(1);
  });

  it("only the team sets a public photo, with a permission note; it becomes the first photo and its credit follows the place", async () => {
    const ids = (await db.query<{ id: string }>(
      "insert into public.place_photos (place_id, url, storage_path, uploader_id, sort_order) values ($1, 'https://img.test/a.webp', null, $2, 0), ($1, 'https://img.test/b.webp', null, $2, 1) returning id",
      [cannon, theo],
    )).rows.map((r) => r.id);
    await expect(as(theo, "select public.set_place_public_photo($1, $2, 'mine')", [cannon, ids[1]])).rejects.toThrow(/team/);
    await expect(as(null, "select public.set_place_public_photo($1, $2, 'x')", [cannon, ids[1]])).rejects.toThrow();
    await expect(as(mod, "select public.set_place_public_photo($1, $2, '  ')", [cannon, ids[1]])).rejects.toThrow(/permission/);
    await expect(as(mod, "select public.set_place_public_photo($1, $2, 'x')", [annex, ids[1]])).rejects.toThrow(/not one of this place/);
    await as(mod, "select public.set_place_public_photo($1, $2, 'Taken by Theo, used with permission')", [cannon, ids[1]]);
    const first = await db.query<{ id: string }>("select id from public.place_photos where place_id = $1 order by sort_order limit 1", [cannon]);
    expect(first.rows[0].id).toBe(ids[1]);
    expect(await as(null, "select permission_note from public.place_public_photos where place_id = $1", [cannon])).toEqual([{ permission_note: "Taken by Theo, used with permission" }]);
    await expect(as(mod, "insert into public.place_public_photos (place_id, photo_id, permission_note) values ($1, $2, 'x')", [annex, ids[0]])).rejects.toThrow(/permission denied/);
  });
});

describe("personal photos in the app (demo repository, real actions and routes)", () => {
  let handle: StoreHandle;
  beforeEach(() => {
    handle = createIsolatedStore();
    ctx.repo = createDemoRepository(handle);
    ctx.viewer = null;
  });
  afterEach(() => vi.unstubAllEnvs());

  const upload = async (as: string, placeId: string, secret = "GPS 39.96,-83.00 home") => {
    ctx.viewer = { id: as };
    const { uploadPersonalPhotoAction } = await import("../src/server/actions/personalPhotos");
    const data = new FormData();
    data.set("placeId", placeId);
    data.set("photo", await photoFile(secret));
    return uploadPersonalPhotoAction(data);
  };
  const fetchPhoto = async (viewer: string | null, placeId: string) => {
    ctx.viewer = viewer ? { id: viewer } : null;
    const { GET } = await import("../src/app/api/personal-photos/[placeId]/route");
    return GET(new Request(`http://x/api/personal-photos/${placeId}`), { params: Promise.resolve({ placeId }) } as never);
  };
  const renderPlace = async (viewer: string | null, id: string) => {
    ctx.viewer = viewer ? { id: viewer } : null;
    const { default: PlacePage } = await import("../src/app/places/[id]/page");
    const el = (await PlacePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never)) as ReactElement;
    return renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
  };

  it("the route hands the photo to its owner only, with metadata stripped", async () => {
    expect(await upload(maya, cannon, "SECRET-EXIF-MARKER")).toEqual({ ok: true, data: undefined });
    const mine = await fetchPhoto(maya, cannon);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await mine.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(bytes.includes(Buffer.from("SECRET-EXIF-MARKER"))).toBe(false);
    for (const viewer of [null, nina, theo, mod, admin]) {
      const res = await fetchPhoto(viewer, cannon);
      expect(res.status, String(viewer)).toBe(404);
    }
    // There is no way to name another user's photo: the route only knows the viewer's own.
    expect((await fetchPhoto(theo, "not-a-uuid")).status).toBe(404);
    expect(await ctx.repo.personalPhotos.get(theo, cannon)).toBeNull();
    expect(await ctx.repo.personalPhotos.deliver(theo, cannon)).toBeNull();
  });

  it("the owner's page leads with their photo; nobody else's page, share card or recommendations ever mention it", async () => {
    await upload(maya, cannon);
    const own = await renderPlace(maya, cannon);
    expect(own).toContain(`/api/personal-photos/${cannon}`);
    expect(own).toContain("Your photo · only you see it");
    expect(own).toContain('data-hero="photo"');
    for (const viewer of [null, nina, theo, mod, admin]) {
      const html = await renderPlace(viewer, cannon);
      expect(html, String(viewer)).not.toContain("/api/personal-photos/");
      expect(html).not.toContain("only you see it");
    }
    const { generateMetadata } = await import("../src/app/places/[id]/page");
    expect(JSON.stringify(await generateMetadata({ params: Promise.resolve({ id: cannon }) } as never))).not.toContain("personal");
    const recs = JSON.stringify([await ctx.repo.recommendations.places(theo), await ctx.repo.places.get(cannon, theo), await ctx.repo.saves.library(theo)]);
    expect(recs).not.toContain("personal");
  });

  it("a first rating needs the photo; changing an existing rating does not", async () => {
    const { ratePlaceAction } = await import("../src/server/actions/places");
    ctx.viewer = { id: maya };
    expect(await ratePlaceAction({ placeId: annex, score: 4, note: "Quiet upstairs" })).toMatchObject({ ok: false, code: "photo_required" });
    expect(await ratePlaceAction({ placeId: cannon, score: 3, note: null })).toMatchObject({ ok: true });
    expect(await upload(maya, annex)).toMatchObject({ ok: true });
    ctx.viewer = { id: maya };
    expect(await ratePlaceAction({ placeId: annex, score: 4, note: "Quiet upstairs" })).toMatchObject({ ok: true });
  });

  it("with pilotExplore off, rating works exactly as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilotLibrary");
    const { ratePlaceAction } = await import("../src/server/actions/places");
    ctx.viewer = { id: maya };
    expect(await ratePlaceAction({ placeId: annex, score: 4, note: null })).toMatchObject({ ok: true });
  });

  it("never blocks saving, joining an event or bulk marking visited", async () => {
    ctx.viewer = { id: nina };
    const { toggleSaveAction } = await import("../src/server/actions/places");
    const { bulkSavesAction } = await import("../src/server/actions/saves");
    const { toggleAttendanceAction } = await import("../src/server/actions/events");
    expect(await ctx.repo.personalPhotos.get(nina, annex)).toBeNull();
    expect(await toggleSaveAction(annex, true)).toMatchObject({ ok: true });
    expect(await bulkSavesAction([annex], { kind: "status", status: "visited" })).toMatchObject({ ok: true });
    const page = await ctx.repo.events.search({ limit: 50 });
    const event = page.items.find((e) => !e.priceCents && (e.capacity === null || e.attendeeCount < e.capacity));
    expect(event).toBeTruthy();
    expect(await toggleAttendanceAction(event!.id, true)).toMatchObject({ ok: true });
  });

  it("the page with no photo at all is still complete, and asks for the photo only where a first rating needs it", async () => {
    const html = await renderPlace(nina, annex);
    expect(html).toContain('data-hero="glyph"');
    expect(html).toContain('data-personal-photo="required"');
    expect(html).toContain("data-rating-locked");
    for (const block of ["you", "friends", "community", "reviews", "actions"]) expect(html).toContain(`data-block="${block}"`);
    // Someone who already rated it is not asked to add one before they can change their rating.
    const rated = await renderPlace(maya, cannon);
    expect(rated).toContain('data-personal-photo="optional"');
    expect(rated).not.toContain("data-rating-locked");
  });

  it("a friend who went shows the public photo, their own review and the photos they chose to post, never their personal photo", async () => {
    await ctx.repo.places.addPhotos(cannon, [{ url: "https://img.test/theo-posted.webp", storagePath: null }], theo);
    await upload(theo, cannon, "theo private");
    const html = await renderPlace(maya, cannon);
    expect(html).toContain("The only bar that turns the sound on.");
    expect(html).toContain(`data-friend-photos="${theo}"`);
    expect(html).toContain("https://img.test/theo-posted.webp");
    expect(html).not.toContain("/api/personal-photos/");
  });

  it("the team's public photo leads with its credit; only moderators can set it", async () => {
    await ctx.repo.places.addPhotos(cannon, [{ url: "https://img.test/one.webp", storagePath: null }, { url: "https://img.test/two.webp", storagePath: null }], theo);
    const two = (await ctx.repo.places.get(cannon))!.photos.find((p) => p.url.endsWith("two.webp"))!;
    const { setPublicPhotoAction } = await import("../src/server/actions/personalPhotos");
    ctx.viewer = { id: theo };
    expect(await setPublicPhotoAction(cannon, two.id, "mine")).toMatchObject({ ok: false, code: "forbidden" });
    ctx.viewer = { id: mod };
    expect(await setPublicPhotoAction(cannon, two.id, "")).toMatchObject({ ok: false, code: "invalid" });
    expect(await setPublicPhotoAction(cannon, two.id, "Team photo, 2026")).toEqual({ ok: true, data: undefined });
    expect((await ctx.repo.places.get(cannon))!.photos[0].id).toBe(two.id);
    const html = await renderPlace(nina, cannon);
    expect(html).toContain("Photo: Team photo, 2026");
    expect(html.indexOf("two.webp")).toBeLessThan(html.indexOf("<h1"));
  });
});
