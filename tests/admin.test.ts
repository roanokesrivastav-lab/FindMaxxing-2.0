/**
 * The admin dashboard (Session 12): admins above moderators, suspension that
 * blocks every write in the database, audited moderator grants and taxonomy
 * edits, and paged admin reads. The demo repository is held to the same rules.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { DataError } from "../src/lib/data/types";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [dev, maya, theo, nina, sam] = ["dev", "maya_r", "theo", "nina", "sam_k"].map(user);
const tuttle = stableId("place:Tuttle Lot Fields");

describe("admin in the database", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  beforeAll(async () => {
    db = await createSeededDb();
    await db.exec("alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select, insert on storage.objects to authenticated;");
  });

  it("makes admins moderators too, and keeps admin tools from everyone else", async () => {
    expect((await as<{ ok: boolean }>(dev, "select public.is_moderator() as ok"))[0].ok).toBe(true);
    await expect(as(maya, "select public.admin_set_suspended($1, true, 'x')", [nina])).rejects.toThrow(/Admins only/);
    await expect(as(sam, "select public.admin_set_moderator($1, true, 'x')", [maya])).rejects.toThrow(/Admins only/);
    expect(await as(maya, "select * from public.admin_users()")).toEqual([]);
    expect(await as(sam, "select * from public.admin_content()")).toEqual([]);
    expect(await as(maya, "select * from public.admin_rate_limit_hits()")).toEqual([]);
    await expect(as(maya, "insert into public.suspensions (user_id, reason) values ($1, 'x')", [nina])).rejects.toThrow(/permission denied/);
  });

  it("suspends with a reason, never yourself, and blocks every write by the suspended account", async () => {
    await expect(as(dev, "select public.admin_set_suspended($1, true, '  ')", [nina])).rejects.toThrow(/reason_required/);
    await expect(as(dev, "select public.admin_set_suspended($1, true, 'x')", [dev])).rejects.toThrow(/admin:self/);
    await as(dev, "select public.admin_set_suspended($1, true, 'Spam wave')", [nina]);
    const writes = [
      ["create a place", "select public.create_place_with_details('Blocked', 'A long enough description', null, 'food', 41.5, -81.7, null, null, 'Cleveland', 'public', '{}', '[]')", []],
      ["save", "insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina, tuttle]],
      ["follow", "insert into public.follows (follower_id, following_id) values ($1, $2)", [nina, theo]],
      ["report", "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'spam')", [nina, tuttle]],
      ["make a list", "insert into public.saved_lists (owner_id, name) values ($1, 'x')", [nina]],
      ["edit profile", "update public.profiles set bio = 'still here' where id = $1", [nina]],
      ["unfollow", "delete from public.follows where follower_id = $1", [nina]],
      ["upload", "insert into storage.objects (bucket_id, name, owner) values ('avatars', $1, $2)", [`${nina}/a.webp`, nina]],
    ] as const;
    for (const [label, sql, params] of writes) {
      await expect(as(nina, sql, [...params]).then(() => "ok", (e: Error) => (/account_suspended/.test(e.message) ? "blocked" : e.message))).resolves.toBe("blocked");
      void label;
    }
    // Reading still works, and her content stays up.
    expect((await as(nina, "select id from public.places where id = $1", [tuttle])).length).toBe(1);
    expect((await as(nina, "select user_id from public.suspensions")).length).toBe(1);
    await as(dev, "select public.admin_set_suspended($1, false, 'Appeal accepted')", [nina]);
    await as(nina, "insert into public.follows (follower_id, following_id) values ($1, $2)", [nina, theo]);
    const log = await as<{ action: string }>(dev, "select action from public.moderation_actions where target_id = $1 order by created_at, id", [nina]);
    expect(log.map((l) => l.action)).toEqual(["suspend", "unsuspend"]);
  });

  it("grants and revokes moderators, audited", async () => {
    await as(dev, "select public.admin_set_moderator($1, true, 'Helps a lot')", [maya]);
    expect((await as<{ ok: boolean }>(maya, "select public.is_moderator() as ok"))[0].ok).toBe(true);
    await expect(as(dev, "select public.admin_set_moderator($1, true, 'again')", [maya])).rejects.toThrow(/no_change/);
    await as(dev, "select public.admin_set_moderator($1, false, 'Stepping back')", [maya]);
    expect((await as<{ ok: boolean }>(maya, "select public.is_moderator() as ok"))[0].ok).toBe(false);
  });

  it("edits, adds and retires taxonomy entries, audited by slug", async () => {
    await expect(as(maya, "select public.admin_upsert_taxonomy('interest', 'disc-golf', 'Disc golf', '🥏', 50, null, null, 'x')")).rejects.toThrow(/Admins only/);
    await expect(as(dev, "select public.admin_upsert_taxonomy('interest', 'Disc Golf!', 'Disc golf', '🥏', 50, null, null, 'x')")).rejects.toThrow(/admin:bad_slug/);
    await as(dev, "select public.admin_upsert_taxonomy('interest', 'disc-golf', 'Disc golf', '🥏', 50, null, null, 'Requested by users')");
    await as(dev, "select public.admin_upsert_taxonomy('interest', 'hiking', 'Hiking and walks', '🥾', 3, null, null, 'Clearer')");
    await as(dev, "select public.admin_set_taxonomy_retired('interest', 'disc-golf', true, 'Merged into outdoors')");
    const { rows } = await db.query<{ slug: string; label: string; retired: boolean }>("select slug, label, retired from public.interests where slug in ('disc-golf', 'hiking') order by slug");
    expect(rows).toEqual([{ slug: "disc-golf", label: "Disc golf", retired: true }, { slug: "hiking", label: "Hiking and walks", retired: false }]);
    const hist = await as<{ action: string }>(dev, "select action from public.admin_history('interest', null, 'disc-golf')");
    expect(hist.map((h) => h.action)).toEqual(["taxonomy_retire", "taxonomy_upsert"]);
    // Existing references survive a retirement.
    expect((await db.query("select 1 from public.place_tags where interest_slug = 'hiking'")).rows.length).toBeGreaterThan(0);
  });

  it("pages people and content without gaps, and filters them", async () => {
    const all = await as<{ id: string }>(dev, "select id from public.admin_users(p_limit => 101)");
    const walked: string[] = [];
    let after: { c: string | null; id: string | null } = { c: null, id: null };
    for (;;) {
      const page = await as<{ id: string; c: string }>(dev, "select id, to_json(created_at) #>> '{}' as c from public.admin_users(null, $1::timestamptz, $2::uuid, 4)", [after.c, after.id]);
      walked.push(...page.slice(0, 3).map((r) => r.id));
      if (page.length < 4) break;
      after = { c: page[2].c, id: page[2].id };
    }
    expect(walked).toEqual(all.map((r) => r.id));
    expect((await as<{ username: string }>(dev, "select username from public.admin_users('nin')")).map((r) => r.username)).toEqual(["nina"]);
    await db.query("update public.places set status = 'removed' where id = $1", [tuttle]);
    expect((await as<{ id: string }>(dev, "select id from public.admin_content('place', 'removed')")).map((r) => r.id)).toEqual([tuttle]);
  });

  it("shows who is at their rate limit right now", async () => {
    await db.query("insert into public.rate_limit_counters (user_id, action, window_start, count) select $1, 'lists', to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), 30 on conflict (user_id, action, window_start) do update set count = 30", [theo]);
    const rows = await as<{ action: string; users_at_limit: number }>(dev, "select action, users_at_limit from public.admin_rate_limit_hits()");
    expect(rows.find((r) => r.action === "lists")).toEqual({ action: "lists", users_at_limit: 1 });
  });
});

describe("admin in demo mode", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: DataError) => e.code);

  it("blocks every write by a suspended account, keeps reads, and audits", async () => {
    expect(await code(repo.admin.setSuspended(maya, nina, true, "x"))).toBe("forbidden");
    await repo.admin.setSuspended(dev, nina, true, "Spam wave");
    const writes: [string, () => Promise<unknown>][] = [
      ["create a place", () => repo.places.create({ name: "Blocked", description: "A long enough description", categorySlug: "food", lat: 41.5, lng: -81.7, city: "Cleveland", tags: [] }, nina)],
      ["save", () => repo.places.save(nina, tuttle)],
      ["follow", () => repo.profiles.follow(nina, theo)],
      ["report", () => repo.reports.create({ targetType: "place", targetId: tuttle, reason: "spam" }, nina)],
      ["make a list", () => repo.savedLists.create(nina, "x")],
      ["upload", () => repo.storage.uploadImage({ main: new Uint8Array(4) }, "avatars", nina)],
    ];
    for (const [label, write] of writes) expect([label, await code(write())]).toEqual([label, "forbidden"]);
    expect(await repo.places.get(tuttle, nina)).not.toBeNull();
    await repo.admin.setSuspended(dev, nina, false, "Appeal accepted");
    expect(await code(repo.profiles.follow(nina, theo))).toBe("ok");
    expect((await repo.admin.history(dev, { type: "profile", id: nina })).map((h) => h.action).sort()).toEqual(["suspend", "unsuspend"]);
  });

  it("matches SQL: the same people in the same pages, and the same taxonomy refusals", async () => {
    const db = await createSeededDb();
    const sqlIds = (await queryAs<{ id: string }>(db, dev, "select id from public.admin_users(p_limit => 101)")).map((r) => r.id);
    const demoIds: string[] = [];
    for (let cursor: string | null = null; ;) {
      const page = await repo.admin.users(dev, { limit: 3, cursor });
      demoIds.push(...page.items.map((u) => u.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(demoIds).toEqual(sqlIds);
    expect(await code(repo.admin.upsertTaxonomy(dev, { kind: "interest", slug: "Disc Golf!", label: "x", emoji: "🥏", sortOrder: 1 }, "x"))).toBe("invalid");
    await repo.admin.upsertTaxonomy(dev, { kind: "interest", slug: "disc-golf", label: "Disc golf", emoji: "🥏", sortOrder: 50 }, "Requested");
    await repo.admin.setTaxonomyRetired(dev, "interest", "disc-golf", true, "Merged");
    expect((await repo.admin.taxonomy(dev)).find((t) => t.slug === "disc-golf")).toMatchObject({ retired: true, label: "Disc golf" });
    expect(await repo.admin.taxonomy(maya)).toEqual([]);
  });
});

// The server action, with real demo data.
const ctx: { repo: DataRepository; viewer: string | null } = { repo: createDemoRepository(createIsolatedStore()), viewer: dev };
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));

describe("admin actions", async () => {
  const { adminAction } = await import("../src/server/actions/admin");
  beforeEach(() => {
    ctx.repo = createDemoRepository(createIsolatedStore());
    ctx.viewer = dev;
  });
  it("validate, require an admin, and put a missing reason on the reason field", async () => {
    expect(await adminAction({ kind: "suspend", userId: nina, on: true, reason: " " })).toMatchObject({ ok: false, fieldErrors: { reason: "Give a reason" } });
    expect(await adminAction({ kind: "suspend", userId: "nope", on: true, reason: "x" })).toMatchObject({ ok: false });
    ctx.viewer = maya;
    expect(await adminAction({ kind: "moderator", userId: theo, on: true, reason: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    ctx.viewer = dev;
    expect(await adminAction({ kind: "moderator", userId: theo, on: true, reason: "Helps" })).toEqual({ ok: true, data: undefined });
    expect(await ctx.repo.moderation.isModerator(theo)).toBe(true);
  });
});
