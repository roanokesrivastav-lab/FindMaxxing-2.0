/**
 * The private per-user interaction log (0031_user_interactions.sql, with
 * attribution from 0033_interaction_attribution.sql): own rows only, visible
 * items only, the opt-out honored except for Not interested, one rate-limit
 * tick per batch, one impression per request, saves, ratings and attendance
 * written by the database rather than the client, gone with the account or
 * the item, a service-only training aggregate, and the same behavior in the
 * demo store. "Not interested" and blocks leave items out of recommendations
 * on both sides.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore, migrateDemoState, STATE_VERSION } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import { purgeDemoInteractions } from "../src/lib/data/demo/interactions";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import type { DataRepository } from "../src/lib/data/repository";

vi.mock("server-only", () => ({}));

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina, jules] = ["maya_r", "nina", "jules"].map(user);
const NOW = new Date(Date.now() + 3600_000).toISOString();

const insertSql = "insert into public.user_interactions (item_type, item_id, action, surface, position, value) values ";

describe("user_interactions in the database", () => {
  let db: PGlite;
  let place: string;
  let otherPlace: string;
  let event: string;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const mine = (id: string) => as<{ action: string; item_id: string }>(id, "select action, item_id from public.user_interactions order by id");

  beforeAll(async () => {
    db = await createSeededDb();
    const places = (await db.query<{ id: string }>("select id from public.places where status = 'published' and visibility = 'public' order by id limit 2")).rows;
    [place, otherPlace] = places.map((p) => p.id);
    event = (await db.query<{ id: string }>("select id from public.events where status = 'published' and place_id is null order by id limit 1")).rows[0].id;
  });
  afterAll(async () => { await db?.close(); });

  it("lets a person write and read only their own rows, with the server's clock", async () => {
    await as(maya, `${insertSql} ('place', $1, 'impression', 'for_you', 0, null), ('place', $2, 'impression', 'for_you', 1, null), ('event', $3, 'view', 'detail', null, null)`, [place, otherPlace, event]);
    await as(nina, `${insertSql} ('place', $1, 'view', 'detail', null, null)`, [place]);
    // Nothing from the seed's saves, ratings and attendance: only what people do themselves.
    expect((await mine(maya)).map((r) => r.action)).toEqual(["impression", "impression", "view"]);
    expect(await mine(nina)).toEqual([{ action: "view", item_id: place }]);
    // Not as someone else, not with a chosen timestamp, not changed afterwards, not anonymously.
    await expect(as(maya, "insert into public.user_interactions (user_id, item_type, item_id, action) values ($1, 'place', $2, 'view')", [nina, place])).rejects.toThrow(/row-level security/);
    await expect(as(maya, "insert into public.user_interactions (item_type, item_id, action, created_at) values ('place', $1, 'view', now() - interval '1 year')", [place])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.user_interactions set position = 5")).rejects.toThrow(/permission denied/);
    await expect(as(null, "select * from public.user_interactions")).rejects.toThrow(/permission denied/);
    await expect(as(null, `${insertSql} ('place', $1, 'view', null, null, null)`, [place])).rejects.toThrow(/permission denied/);
    // Deleting someone else's rows silently matches nothing.
    await as(maya, "delete from public.user_interactions where user_id = $1", [nina]);
    expect(await mine(nina)).toHaveLength(1);
  });

  it("checks the shape: actions, rate values, positions, policies", async () => {
    // What the database sees happen is not the client's to send, real or made up.
    for (const [type, id, action, value] of [["place", place, "save", null], ["place", place, "unsave", null], ["place", place, "rate", 5], ["event", event, "join", null], ["event", event, "leave", null]]) {
      await expect(as(maya, `${insertSql} ($1, $2, $3, 'detail', null, $4)`, [type, id, action, value])).rejects.toThrow(/row-level security/);
    }
    await expect(as(maya, `${insertSql} ('place', $1, 'view', null, null, 3)`, [place])).rejects.toThrow(/check constraint/);
    await expect(as(maya, "insert into public.user_interactions (item_type, item_id, action, policy) values ('place', $1, 'view', 'Rules v1!')", [place])).rejects.toThrow(/check constraint/);
    await expect(as(maya, "insert into public.user_interactions (item_type, item_id, action, propensity) values ('place', $1, 'view', 0)", [place])).rejects.toThrow(/check constraint/);
    await expect(as(maya, `${insertSql} ('place', $1, 'impression', 'list', -1, null)`, [place])).rejects.toThrow(/check constraint/);
    // An unknown action fails the policy's action list before the check constraint.
    await expect(as(maya, `${insertSql} ('place', $1, 'like', null, null, null)`, [place])).rejects.toThrow(/row-level security/);
  });

  it("only accepts items the writer can see", async () => {
    await expect(as(maya, `${insertSql} ('place', $1, 'view', null, null, null)`, [crypto.randomUUID()])).rejects.toThrow(/row-level security/);
    await as(jules, "select public.create_place_with_details('Locals spot', 'A long enough description', null, 'coffee-study', 39.96, -83.0, null, null, 'Columbus', 'locals', array['coffee'], '[]')");
    const locals = (await db.query<{ id: string }>("select id from public.places where name = 'Locals spot'")).rows[0].id;
    const nonLocal = (await db.query<{ id: string }>("select id from public.profiles where home_city is distinct from 'Columbus' and id <> $1 limit 1", [jules])).rows[0]?.id;
    if (nonLocal) await expect(as(nonLocal, `${insertSql} ('place', $1, 'view', null, null, null)`, [locals])).rejects.toThrow(/row-level security/);
    await as(jules, `${insertSql} ('place', $1, 'view', 'detail', null, null)`, [locals]);
  });

  it("honors the analytics opt-out, except for an explicit Not interested", async () => {
    await db.query("update public.profiles set analytics_opt_out = true where id = $1", [nina]);
    await expect(as(nina, `${insertSql} ('place', $1, 'impression', 'list', 0, null)`, [otherPlace])).rejects.toThrow(/row-level security/);
    await as(nina, `${insertSql} ('place', $1, 'hide', 'for_you', 0, null)`, [otherPlace]);
    await db.query("update public.profiles set analytics_opt_out = false where id = $1", [nina]);
    expect((await mine(nina)).map((r) => r.action)).toEqual(["view", "hide"]);
  });

  it("counts one rate-limit tick per batch and caps a batch at 100 rows", async () => {
    const ticks = async () => (await db.query<{ count: number }>("select coalesce(sum(count), 0)::int as count from public.rate_limit_counters where user_id = $1 and action = 'interactions'", [jules])).rows[0].count;
    const before = await ticks();
    await as(jules, `${insertSql} ('place', $1, 'impression', 'list', 0, null), ('place', $2, 'impression', 'list', 1, null)`, [place, otherPlace]);
    expect(await ticks()).toBe(before + 1);
    const values = Array.from({ length: 101 }, (_, i) => `('place', $1, 'impression', 'list', ${i}, null)`).join(", ");
    await expect(as(jules, `${insertSql} ${values}`, [place])).rejects.toThrow(/Too many interactions/);
  });

  it("keeps the training aggregate and retention service-only", async () => {
    await expect(as(maya, "select * from public.interaction_item_stats()")).rejects.toThrow(/permission denied/);
    await expect(as(maya, "select public.purge_user_interactions(0)")).rejects.toThrow(/permission denied/);
    await db.exec("set role service_role;");
    try {
      const stats = (await db.query<{ item_id: string; people: number; impressions: number }>("select * from public.interaction_item_stats() where item_type = 'place' and item_id = $1", [place])).rows;
      expect(stats[0]).toMatchObject({ people: 3, impressions: 2 });
      expect(Object.keys(stats[0])).not.toContain("user_id");
    } finally {
      await db.exec("reset role;");
    }
  });

  it("purges old impressions and views but keeps the actions", async () => {
    await db.query("update public.user_interactions set created_at = now() - interval '400 days' where user_id = $1", [maya]);
    await db.query("insert into public.user_interactions (user_id, item_type, item_id, action, created_at) values ($1, 'place', $2, 'hide', now() - interval '400 days')", [maya, otherPlace]);
    const n = (await db.query<{ n: number }>("select public.purge_user_interactions(365) as n")).rows[0].n;
    expect(n).toBe(3);
    expect(await mine(maya)).toEqual([{ action: "hide", item_id: otherPlace }]);
  });

  it("Not interested leaves the item out of recommendations, and undo brings it back", async () => {
    const recs = async () => (await as<{ place_id: string }>(nina, "select place_id from public.recommend_places(null, null, 50)")).map((r) => r.place_id);
    const evs = async () => (await as<{ event_id: string }>(nina, "select event_id from public.recommend_events(null, null, 50, $1::timestamptz)", [NOW])).map((r) => r.event_id);
    const [top] = await recs();
    const [topEvent] = await evs();
    expect(top).toBeTruthy();
    expect(topEvent).toBeTruthy();
    await as(nina, `${insertSql} ('place', $1, 'hide', 'for_you', 0, null), ('event', $2, 'hide', 'for_you', 0, null)`, [top, topEvent]);
    expect(await recs()).not.toContain(top);
    expect(await evs()).not.toContain(topEvent);
    // Someone else's hide changes nothing for nina; her own undo does.
    await as(nina, "delete from public.user_interactions where action = 'hide' and item_id in ($1, $2)", [top, topEvent]);
    expect(await recs()).toContain(top);
    expect(await evs()).toContain(topEvent);
  });

  it("goes with the account, and with the items the account made", async () => {
    const id = crypto.randomUUID();
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)", [id, `${id}@example.test`, JSON.stringify({ username: `i_${id.slice(0, 8)}`, display_name: "Interactions test" })]);
    const [own] = (await db.query<{ id: string }>(`insert into public.places(name,description,category_slug,lat,lng,city,creator_id) values ('Interaction place','Long enough description',(select slug from public.categories where scope in ('place','both') limit 1),39.96,-83,'Columbus',$1) returning id`, [id])).rows;
    await as(id, `${insertSql} ('place', $1, 'impression', 'list', 0, null)`, [place]);
    await as(id, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [id, own.id]);
    expect((await as<{ action: string }>(id, "select action from public.user_interactions order by id")).map((r) => r.action)).toEqual(["impression", "save"]);
    await as(maya, `${insertSql} ('place', $1, 'view', 'detail', null, null)`, [own.id]);
    await db.query("delete from auth.users where id = $1", [id]);
    expect((await db.query("select 1 from public.user_interactions where user_id = $1", [id])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.user_interactions where item_id = $1", [own.id])).rows).toHaveLength(0);
  });
});

describe("user interactions in the demo store", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  const publicPlace = () => store.state.places.find((p) => p.status === "published" && p.visibility === "public")!;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });

  it("logs own rows, newest first, and refuses what the database refuses", async () => {
    const p = publicPlace();
    await repo.interactions.log(maya, [
      { itemType: "place", itemId: p.id, action: "impression", surface: "list", position: 0 },
      { itemType: "place", itemId: p.id, action: "view", surface: "detail" },
    ]);
    const rows = await repo.interactions.list(maya);
    expect(rows.map((r) => r.action)).toEqual(["view", "impression"]);
    expect(rows[1]).toMatchObject({ itemType: "place", itemId: p.id, surface: "list", position: 0, value: null });
    expect(await repo.interactions.list(nina)).toEqual([]);
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: crypto.randomUUID(), action: "view" }])).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: p.id, action: "join" }])).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: p.id, action: "rate" }])).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: p.id, action: "rate", value: 5 }])).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: p.id, action: "save" }])).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.interactions.log(maya, [{ itemType: "place", itemId: p.id, action: "view", policy: "Rules v1!" }])).rejects.toMatchObject({ code: "invalid" });
    const many = Array.from({ length: 101 }, (_, i) => ({ itemType: "place" as const, itemId: p.id, action: "impression" as const, position: i }));
    await expect(repo.interactions.log(maya, many)).rejects.toMatchObject({ code: "invalid" });
    // One tick per batch.
    expect(store.state.rateLimits.filter((r) => r.userId === maya && r.action === "interactions").map((r) => r.count)).toEqual([1]);
  });

  it("honors the opt-out except for hide, and refuses suspended accounts", async () => {
    const p = publicPlace();
    await repo.analytics.setOptOut(nina, true);
    await expect(repo.interactions.log(nina, [{ itemType: "place", itemId: p.id, action: "view" }])).rejects.toMatchObject({ code: "forbidden" });
    await repo.interactions.log(nina, [{ itemType: "place", itemId: p.id, action: "hide", surface: "for_you", position: 0 }]);
    expect((await repo.interactions.list(nina)).map((r) => r.action)).toEqual(["hide"]);
    store.state.suspensions.push({ userId: jules, reason: "test", suspendedBy: null, suspendedAt: new Date().toISOString() });
    await expect(repo.interactions.log(jules, [{ itemType: "place", itemId: p.id, action: "view" }])).rejects.toMatchObject({ code: "forbidden" });
  });

  it("Not interested leaves the item out of recommendations, and undo brings it back", async () => {
    const [top] = await repo.recommendations.places(nina, { limit: 50 });
    const [topEvent] = await repo.recommendations.events(nina, { limit: 50, now: NOW });
    await repo.interactions.log(nina, [
      { itemType: "place", itemId: top.item.id, action: "hide", surface: "for_you", position: 0 },
      { itemType: "event", itemId: topEvent.item.id, action: "hide", surface: "for_you", position: 0 },
    ]);
    expect((await repo.recommendations.places(nina, { limit: 50 })).map((r) => r.item.id)).not.toContain(top.item.id);
    expect((await repo.recommendations.events(nina, { limit: 50, now: NOW })).map((r) => r.item.id)).not.toContain(topEvent.item.id);
    expect((await repo.recommendations.places(maya, { limit: 50 })).length).toBeGreaterThan(0);
    await repo.interactions.unhide(nina, { itemType: "place", itemId: top.item.id });
    await repo.interactions.unhide(nina, { itemType: "event", itemId: topEvent.item.id });
    expect((await repo.recommendations.places(nina, { limit: 50 }))[0].item.id).toBe(top.item.id);
    expect((await repo.recommendations.events(nina, { limit: 50, now: NOW }))[0].item.id).toBe(topEvent.item.id);
  });

  it("clears on request, purges old passive rows, and goes with the account and its items", async () => {
    const p = publicPlace();
    const own = await repo.places.create({ name: "Interaction place", description: "Long enough description", localTip: null, categorySlug: p.categorySlug, lat: 39.96, lng: -83, address: null, neighborhood: null, city: "Columbus", tags: [], visibility: "public", photos: [] }, jules);
    await repo.interactions.log(jules, [{ itemType: "place", itemId: p.id, action: "view" }]);
    await repo.places.save(jules, own.id);
    await repo.interactions.log(maya, [{ itemType: "place", itemId: own.id, action: "impression", surface: "list", position: 3 }, { itemType: "place", itemId: p.id, action: "hide" }]);
    for (const r of store.state.userInteractions) r.createdAt = new Date(Date.now() - 400 * 86_400_000).toISOString();
    expect(purgeDemoInteractions(store.state, 365)).toBe(2);
    expect(store.state.userInteractions.map((r) => r.action)).toEqual(["save", "hide"]);
    deleteDemoAccount(store, jules);
    expect(store.state.userInteractions.map((r) => [r.userId, r.itemId])).toEqual([[maya, p.id]]);
    expect(await repo.interactions.clear(maya)).toBe(1);
    expect(store.state.userInteractions).toEqual([]);
  });

  it("deleting a place or event forgets everyone's history of it", async () => {
    const p = publicPlace();
    const own = await repo.places.create({ name: "Short-lived", description: "Long enough description", localTip: null, categorySlug: p.categorySlug, lat: 39.96, lng: -83, address: null, neighborhood: null, city: "Columbus", tags: [], visibility: "public", photos: [] }, jules);
    await repo.interactions.log(maya, [{ itemType: "place", itemId: own.id, action: "view" }, { itemType: "place", itemId: p.id, action: "view" }]);
    await repo.places.delete(own.id, jules);
    expect(store.state.userInteractions.map((r) => r.itemId)).toEqual([p.id]);
  });

  it("migrates a v12 store without losing anything", () => {
    const old = JSON.parse(JSON.stringify(createIsolatedStore().state));
    old.version = 12;
    delete old.userInteractions;
    const result = migrateDemoState(old);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.version).toBe(STATE_VERSION);
      expect(result.state.userInteractions).toEqual([]);
      expect(result.state.places.length).toBe(old.places.length);
    }
  });
});

describe("Not interested parity", () => {
  it("SQL and the demo store leave out the same hidden items", async () => {
    const db = await createSeededDb();
    const store = createIsolatedStore();
    const repo = createDemoRepository(store);
    await alignDbWithDemo(db, store);
    for (const viewer of [maya, nina]) {
      const places = await repo.recommendations.places(viewer, { limit: 50 });
      const events = await repo.recommendations.events(viewer, { limit: 50, now: NOW });
      const hide = [
        ...places.filter((_, i) => i % 2 === 0).map((r) => ({ itemType: "place" as const, itemId: r.item.id, action: "hide" as const, surface: "for_you" as const, position: 0 })),
        ...events.filter((_, i) => i % 2 === 0).map((r) => ({ itemType: "event" as const, itemId: r.item.id, action: "hide" as const, surface: "for_you" as const, position: 0 })),
      ];
      await repo.interactions.log(viewer, hide);
      for (const h of hide) await queryAs(db, viewer, `${insertSql} ($1, $2, 'hide', 'for_you', 0, null)`, [h.itemType, h.itemId]);
      const sqlPlaces = await queryAs<{ id: string; score: string }>(db, viewer, "select place_id as id, score from public.recommend_places(null, null, 50)");
      const sqlEvents = await queryAs<{ id: string; score: string }>(db, viewer, "select event_id as id, score from public.recommend_events(null, null, 50, $1::timestamptz)", [NOW]);
      expect((await repo.recommendations.places(viewer, { limit: 50 })).map((r) => [r.item.id, r.score])).toEqual(sqlPlaces.map((r) => [r.id, Number(r.score)]));
      expect((await repo.recommendations.events(viewer, { limit: 50, now: NOW })).map((r) => [r.item.id, r.score])).toEqual(sqlEvents.map((r) => [r.id, Number(r.score)]));
    }
  }, 120_000);
});

// The helper the server actions call.
const ctx: { repo: DataRepository; viewer: string | null; headers: Headers } = { repo: createDemoRepository(createIsolatedStore()), viewer: maya, headers: new Headers() };
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("next/headers", () => ({ headers: async () => ctx.headers }));

describe("recordInteractions()", async () => {
  const { recordInteractions } = await import("../src/server/interactions");
  let store: ReturnType<typeof createIsolatedStore>;
  const row = () => ({ itemType: "place" as const, itemId: store.state.places.find((p) => p.status === "published" && p.visibility === "public")!.id, action: "view" as const, surface: "detail" as const });
  beforeEach(() => {
    store = createIsolatedStore();
    ctx.repo = createDemoRepository(store);
    ctx.viewer = maya;
    ctx.headers = new Headers();
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "recommendations");
  });

  it("records only with recommendations on, a signed-in viewer, no DNT/GPC and no opt-out", async () => {
    await recordInteractions([row()]);
    expect(store.state.userInteractions).toHaveLength(1);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    await recordInteractions([row()]);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "recommendations");
    ctx.headers = new Headers({ dnt: "1" });
    await recordInteractions([row()]);
    ctx.headers = new Headers({ "sec-gpc": "1" });
    await recordInteractions([row()]);
    ctx.headers = new Headers();
    await ctx.repo.analytics.setOptOut(maya, true);
    await recordInteractions([row()]);
    ctx.viewer = null;
    await recordInteractions([row()]);
    expect(store.state.userInteractions).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("never throws, and never records a hide (that has its own action)", async () => {
    await expect(recordInteractions([{ ...row(), itemId: crypto.randomUUID() }])).resolves.toBeUndefined();
    await recordInteractions([{ ...row(), action: "hide" }]);
    expect(store.state.userInteractions).toEqual([]);
    vi.unstubAllEnvs();
  });
});
