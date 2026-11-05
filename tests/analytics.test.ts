/**
 * Analytics (Session 10): events are written only through track_event(), under
 * a pseudonymous actor, never for opted-out users, rate limited, read only by
 * admins, and purged after 180 days. The demo store mirrors it; the helper that
 * actions call respects the feature flag, DNT/GPC and the opt-out.
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { purgeDemoAnalytics } from "../src/lib/data/demo/analytics";
import type { DataRepository } from "../src/lib/data/repository";
import { featureEnabled } from "../src/lib/config";
import { SEED_ADMINS, SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const dev = user("dev"); // seeded admin
const maya = user("maya_r");
const theo = user("theo");
const cannon = stableId("place:Cannon & Crown");
const tuttle = stableId("place:Tuttle Lot Fields"); // a seed place maya has not saved

describe("analytics in the database", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  beforeAll(async () => {
    db = await createSeededDb();
    // The SQL seed stamps saves with the seed time; the demo seed backdates them. Match the demo.
    await db.query("update public.saved_places set created_at = now() - interval '30 days'");
  });

  it("seeds an admin from SQL that no client can grant", async () => {
    expect(SEED_ADMINS).toEqual(["dev"]);
    expect((await as<{ ok: boolean }>(dev, "select public.is_admin() as ok"))[0].ok).toBe(true);
    expect((await as<{ ok: boolean }>(maya, "select public.is_admin() as ok"))[0].ok).toBe(false);
    await expect(as(maya, "insert into public.admins (user_id) values ($1)", [maya])).rejects.toThrow(/permission denied/);
  });

  it("records events only through track_event, under a salted hash, never the user id", async () => {
    await expect(as(maya, "insert into public.analytics_events (actor, name) values ('x', 'follow')")).rejects.toThrow(/permission denied/);
    await as(maya, "select public.track_event('save_place', $1::jsonb)", [JSON.stringify({ placeId: cannon })]);
    await as(theo, "select public.track_event('save_place', '{}')");
    const { rows } = await db.query<{ actor: string; name: string }>("select actor, name from public.analytics_events order by id");
    expect(rows).toHaveLength(2);
    expect(rows[0].actor).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].actor).not.toContain(maya.replace(/-/g, ""));
    expect(rows[0].actor).not.toBe(rows[1].actor);
    await expect(as(maya, "select public.track_event('made_up', '{}')")).rejects.toThrow(/check constraint/);
    await expect(as(maya, "select * from public.analytics_salt")).rejects.toThrow(/permission denied/);
  });

  it("does nothing for anonymous callers (refused) or opted-out users (silently)", async () => {
    await expect(as(null, "select public.track_event('follow', '{}')")).rejects.toThrow(/permission denied/);
    await as(theo, "update public.profiles set analytics_opt_out = true where id = $1", [theo]);
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.analytics_events")).rows[0].n;
    await as(theo, "select public.track_event('follow', '{}')");
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.analytics_events")).rows[0].n).toBe(before);
  });

  it("lets only admins read events and metrics", async () => {
    expect(await as(maya, "select id from public.analytics_events")).toEqual([]);
    expect(await as(maya, "select * from public.analytics_funnel(now() - interval '1 day', now() + interval '1 day')")).toEqual([]);
    expect(await as(maya, "select * from public.analytics_save_sources(now() - interval '1 day', now() + interval '1 day')")).toEqual([]);
    expect((await as(dev, "select id from public.analytics_events")).length).toBeGreaterThan(0);
    const funnel = await as<{ step: string; actors: number }>(dev, "select step, actors from public.analytics_funnel(now() - interval '1 day', now() + interval '1 day')");
    expect(funnel.find((f) => f.step === "save_place")).toEqual({ step: "save_place", actors: 2 });
    expect(funnel.map((f) => f.step)).toEqual(["view_place", "save_place", "add_to_list", "contribute_place", "create_event", "join_event", "follow"]);
  });

  it("splits saves by where the place came from, and new places are always community", async () => {
    await as(maya, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [maya, tuttle]);
    const [placeId] = (await as<{ id: string }>(maya, "select public.create_place_with_details('New spot', 'A long enough description', null, 'food', 39.96, -83.0, null, null, 'Columbus', 'public', '{}', '[]') as id")).map((r) => r.id);
    expect((await db.query<{ source: string }>("select source from public.places where id = $1", [placeId])).rows[0].source).toBe("community");
    await as(theo, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [theo, placeId]);
    const rows = await as<{ source: string; saves: number }>(dev, "select * from public.analytics_save_sources(now() - interval '1 hour', now() + interval '1 hour')");
    expect(rows).toEqual([{ source: "community", saves: 1 }, { source: "seed", saves: 1 }]);
  });

  it("rate limits tracking and purges events older than 180 days", async () => {
    await db.query("insert into public.rate_limit_counters (user_id, action, window_start, count) select $1, 'analytics', to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), 600 on conflict (user_id, action, window_start) do update set count = 600", [maya]);
    await expect(as(maya, "select public.track_event('follow', '{}')")).rejects.toThrow(/rate_limited:analytics/);
    await db.query("insert into public.analytics_events (actor, name, created_at) values ('old', 'follow', now() - interval '181 days'), ('recent', 'follow', now() - interval '179 days')");
    await expect(as(dev, "select public.purge_analytics(180)")).rejects.toThrow(/permission denied/);
    await db.exec("set role service_role");
    try {
      expect((await db.query<{ n: number }>("select public.purge_analytics(180) as n")).rows[0].n).toBe(1);
      expect((await db.query<{ n: number }>("select public.purge_analytics(180) as n")).rows[0].n).toBe(0);
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("analytics in demo mode", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });

  it("mirrors the database: pseudonymous actors, opt-out, admin-only metrics, purge", async () => {
    await repo.analytics.track(maya, "save_place", { placeId: cannon });
    await repo.analytics.track(theo, "save_place");
    await repo.analytics.setOptOut(theo, true);
    await repo.analytics.track(theo, "follow");
    expect(store.state.analyticsEvents).toHaveLength(2);
    expect(store.state.analyticsEvents[0].actor).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(store.state.analyticsEvents)).not.toContain(maya);
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    expect(await repo.analytics.funnel(maya, from, to)).toEqual([]);
    expect((await repo.analytics.funnel(dev, from, to)).find((f) => f.step === "save_place")).toEqual({ step: "save_place", actors: 2, events: 2 });
    expect((await repo.analytics.weeklyContributors(dev, 4))).toHaveLength(4);
    store.state.analyticsEvents.push({ id: 99, actor: "old", name: "follow", props: {}, createdAt: new Date(Date.now() - 181 * 86_400_000).toISOString() });
    expect(purgeDemoAnalytics(store, 180)).toBe(1);
  });

  it("counts saves by source the same way as SQL", async () => {
    const db = await createSeededDb();
    await db.query("update public.saved_places set created_at = now() - interval '30 days'");
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    await queryAs(db, maya, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [maya, tuttle]);
    await repo.places.save(maya, tuttle);
    const sql = await queryAs<{ source: string; saves: number }>(db, dev, "select * from public.analytics_save_sources($1::timestamptz, $2::timestamptz)", [from, to]);
    expect(await repo.analytics.saveSources(dev, from, to)).toEqual(Object.fromEntries(sql.map((r) => [r.source, r.saves])));
  });
});

describe("feature flags", () => {
  it("are off unless listed, and keyed features need their keys", () => {
    expect(featureEnabled("analytics", {})).toBe(false);
    expect(featureEnabled("analytics", { NEXT_PUBLIC_FEATURES: "analytics, messaging" })).toBe(true);
    expect(featureEnabled("messaging", { NEXT_PUBLIC_FEATURES: "all" })).toBe(true);
    expect(featureEnabled("tripPlanning", { NEXT_PUBLIC_FEATURES: "all" })).toBe(false);
    expect(featureEnabled("tripPlanning", { NEXT_PUBLIC_FEATURES: "all", ANTHROPIC_API_KEY: "k" })).toBe(true);
  });
});

// The helper the server actions call.
const ctx: { repo: DataRepository; viewer: string | null; headers: Headers } = { repo: createDemoRepository(createIsolatedStore()), viewer: maya, headers: new Headers() };
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("next/headers", () => ({ headers: async () => ctx.headers }));

describe("track()", async () => {
  const { track } = await import("../src/server/analytics");
  let store: ReturnType<typeof createIsolatedStore>;
  beforeEach(() => {
    store = createIsolatedStore();
    ctx.repo = createDemoRepository(store);
    ctx.viewer = maya;
    ctx.headers = new Headers();
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "analytics");
  });

  it("records when on, and not when the flag is off, the browser says no, or nobody is signed in", async () => {
    await track("follow");
    expect(store.state.analyticsEvents).toHaveLength(1);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    await track("follow");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "analytics");
    ctx.headers = new Headers({ dnt: "1" });
    await track("follow");
    ctx.headers = new Headers({ "sec-gpc": "1" });
    await track("follow");
    ctx.headers = new Headers();
    ctx.viewer = null;
    await track("follow");
    expect(store.state.analyticsEvents).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});
