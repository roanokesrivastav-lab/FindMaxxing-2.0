/**
 * Attribution for the interaction log (0033_interaction_attribution.sql):
 * one impression per rendered rail and item, with its policy and score;
 * save, unsave, rate, join and leave written by the database when they
 * happen (the person's own, outside the opt-out, at no rate-limit cost);
 * and "For you" without anyone blocked either way. The demo store matches.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore, migrateDemoState } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import type { DataRepository } from "../src/lib/data/repository";

vi.mock("server-only", () => ({}));

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina, jules] = ["maya_r", "nina", "jules"].map(user);
const NOW = new Date(Date.now() + 3600_000).toISOString();
const impressionSql = "insert into public.user_interactions (item_type, item_id, action, surface, position, request_id, policy, score) values ";

describe("interaction attribution in the database", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const mine = (id: string) => as<{ action: string; item_id: string; value: number | null }>(id, "select action, item_id, value from public.user_interactions order by id");
  const ticks = async (id: string) => (await db.query<{ n: number }>("select coalesce(sum(count), 0)::int as n from public.rate_limit_counters where user_id = $1 and action = 'interactions'", [id])).rows[0].n;

  beforeAll(async () => { db = await createSeededDb(); });
  afterAll(async () => { await db?.close(); });

  it("keeps one impression per request and item, with its policy and score", async () => {
    const place = (await db.query<{ id: string }>("select id from public.places where status = 'published' and visibility = 'public' order by id limit 1")).rows[0].id;
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await as(maya, `${impressionSql} ('place', $1, 'impression', 'for_you', 0, $2, 'rules-v1', 7.5), ('place', $1, 'impression', 'for_you', 0, $2, 'rules-v1', 7.5)`, [place, first]);
    await as(maya, `${impressionSql} ('place', $1, 'impression', 'for_you', 0, $2, 'rules-v1', 7.5)`, [place, first]);
    await as(maya, `${impressionSql} ('place', $1, 'impression', 'for_you', 2, $2, 'rules-v1+rerank', 6)`, [place, second]);
    const rows = await as<{ request_id: string; policy: string; score: number }>(maya, "select request_id, policy, score from public.user_interactions where action = 'impression' order by id");
    expect(rows).toEqual([{ request_id: first, policy: "rules-v1", score: 7.5 }, { request_id: second, policy: "rules-v1+rerank", score: 6 }]);
    // Impressions without a request (list, map) are not deduplicated.
    await as(maya, `${impressionSql} ('place', $1, 'impression', 'list', 0, null, null, null), ('place', $1, 'impression', 'list', 0, null, null, null)`, [place]);
    expect((await mine(maya)).filter((r) => r.action === "impression")).toHaveLength(4);
  });

  it("logs a person's own saves, ratings and attendance as they happen, at no rate-limit cost", async () => {
    const place = (await db.query<{ id: string }>("select id from public.places p where status = 'published' and visibility = 'public' and not exists (select 1 from public.saved_places s where s.place_id = p.id and s.user_id = $1) and not exists (select 1 from public.place_ratings r where r.place_id = p.id and r.user_id = $1) order by id limit 1", [jules])).rows[0].id;
    const event = (await db.query<{ id: string }>("select id from public.events e where status = 'published' and starts_at > now() and capacity is null and creator_id <> $1 and not exists (select 1 from public.event_attendees a where a.event_id = e.id and a.user_id = $1) order by id limit 1", [jules])).rows[0]?.id;
    const before = await ticks(jules);
    await as(jules, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [jules, place]);
    await as(jules, "delete from public.saved_places where user_id = $1 and place_id = $2", [jules, place]);
    await as(jules, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, 4) on conflict (place_id, user_id) do update set score = excluded.score", [jules, place]);
    await as(jules, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, 2) on conflict (place_id, user_id) do update set score = excluded.score", [jules, place]);
    const expected = [
      { action: "save", item_id: place, value: null },
      { action: "unsave", item_id: place, value: null },
      { action: "rate", item_id: place, value: 4 },
      { action: "rate", item_id: place, value: 2 },
    ];
    if (event) {
      await as(jules, "insert into public.event_attendees (user_id, event_id) values ($1, $2)", [jules, event]);
      await as(jules, "delete from public.event_attendees where user_id = $1 and event_id = $2", [jules, event]);
      expected.push({ action: "join", item_id: event, value: null }, { action: "leave", item_id: event, value: null });
    }
    expect(await mine(jules)).toEqual(expected);
    expect(await ticks(jules)).toBe(before);
  });

  it("logs nothing for the opted out, nor for writes that are not the person's own", async () => {
    const place = (await db.query<{ id: string }>("select id from public.places p where status = 'published' and visibility = 'public' and not exists (select 1 from public.saved_places s where s.place_id = p.id and s.user_id = $1) order by id limit 1", [nina])).rows[0].id;
    await db.query("update public.profiles set analytics_opt_out = true where id = $1", [nina]);
    await as(nina, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina, place]);
    await db.query("update public.profiles set analytics_opt_out = false where id = $1", [nina]);
    await as(nina, "delete from public.saved_places where user_id = $1 and place_id = $2", [nina, place]);
    // A service job (no session) saving for someone.
    await db.query("insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina, place]);
    expect((await mine(nina)).map((r) => r.action)).toEqual(["unsave"]);
  });

  it("leaves people blocked either way out of For you", async () => {
    const recs = async () => as<{ place_id: string; creator_id: string | null }>(nina, "select r.place_id, p.creator_id from public.recommend_places(null, null, 50) r join public.places p on p.id = r.place_id");
    const creator = (await recs()).find((r) => r.creator_id && r.creator_id !== nina)?.creator_id;
    expect(creator).toBeTruthy();
    const theirs = (await recs()).filter((r) => r.creator_id === creator).map((r) => r.place_id);
    await as(nina, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [nina, creator]);
    expect((await recs()).some((r) => theirs.includes(r.place_id))).toBe(false);
    await as(nina, "delete from public.blocks where blocked_id = $1", [creator]);
    expect((await recs()).some((r) => theirs.includes(r.place_id))).toBe(true);
    // Blocked by them works the same.
    await as(creator!, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [creator, nina]);
    expect((await recs()).some((r) => theirs.includes(r.place_id))).toBe(false);
    await as(creator!, "delete from public.blocks where blocked_id = $1", [nina]);
  });
});

describe("interaction attribution in the demo store", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  const unsavedPlace = (userId: string) => store.state.places.find((p) =>
    p.status === "published" && p.visibility === "public" && !store.state.savedPlaces.some((s) => s.userId === userId && s.placeId === p.id))!;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });

  it("keeps one impression per request and item", async () => {
    const p = unsavedPlace(maya);
    const requestId = crypto.randomUUID();
    const seen = { itemType: "place" as const, itemId: p.id, action: "impression" as const, surface: "for_you" as const, position: 0, requestId, policy: "rules-v1", score: 7.5 };
    await repo.interactions.log(maya, [seen, seen]);
    await repo.interactions.log(maya, [seen, { ...seen, requestId: crypto.randomUUID() }]);
    const rows = await repo.interactions.list(maya);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.requestId === requestId)).toMatchObject({ policy: "rules-v1", score: 7.5, propensity: null });
  });

  it("logs saves, ratings and attendance from the repository, and nothing for the opted out", async () => {
    const p = unsavedPlace(jules);
    await repo.places.save(jules, p.id);
    await repo.places.save(jules, p.id);
    await repo.places.unsave(jules, p.id);
    await repo.places.unsave(jules, p.id);
    await repo.places.rate(jules, p.id, 3, null);
    const ev = store.state.events.find((e) => e.status === "published" && Date.parse(e.startsAt) > Date.now() && e.capacity === null && e.creatorId !== jules
      && !store.state.eventAttendees.some((a) => a.eventId === e.id && a.userId === jules));
    const expected: [string, number | null][] = [["save", null], ["unsave", null], ["rate", 3]];
    if (ev) {
      await repo.events.join(jules, ev.id);
      await repo.events.leave(jules, ev.id);
      expected.push(["join", null], ["leave", null]);
    }
    expect(store.state.userInteractions.filter((i) => i.userId === jules).map((i) => [i.action, i.value])).toEqual(expected);
    expect(store.state.rateLimits.some((r) => r.userId === jules && r.action === "interactions")).toBe(false);
    await repo.analytics.setOptOut(nina, true);
    await repo.places.save(nina, unsavedPlace(nina).id);
    expect(store.state.userInteractions.filter((i) => i.userId === nina)).toEqual([]);
  });

  it("migrates v13 rows with empty attribution", () => {
    const old = JSON.parse(JSON.stringify(createIsolatedStore().state));
    old.version = 13;
    old.userInteractions = [{ id: 1, userId: maya, itemType: "place", itemId: old.places[0].id, action: "view", surface: null, position: null, value: null, createdAt: new Date().toISOString() }];
    const result = migrateDemoState(old);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.userInteractions[0]).toMatchObject({ requestId: null, policy: null, score: null, propensity: null });
  });
});

describe("blocks parity", () => {
  it("SQL and the demo store leave out the same people", async () => {
    const db = await createSeededDb();
    const store = createIsolatedStore();
    const repo = createDemoRepository(store);
    await alignDbWithDemo(db, store);
    for (const viewer of [maya, nina]) {
      // Block whoever made the viewer's top place and top event, and someone the viewer follows.
      const [topPlace] = await repo.recommendations.places(viewer, { limit: 50 });
      const [topEvent] = await repo.recommendations.events(viewer, { limit: 50, now: NOW });
      const followed = store.state.follows.find((f) => f.followerId === viewer)?.followingId;
      const blocked = new Set([topPlace?.item.creator?.id, topEvent?.item.creator?.id, followed].filter((id): id is string => !!id && id !== viewer));
      expect(blocked.size).toBeGreaterThan(0);
      for (const other of blocked) {
        store.state.blocks.push({ blockerId: viewer, blockedId: other, createdAt: new Date().toISOString() });
        await queryAs(db, viewer, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing", [viewer, other]);
      }
      const sqlPlaces = await queryAs<{ id: string; score: string; reason_text: string }>(db, viewer, "select place_id as id, score, reason_text from public.recommend_places(null, null, 50)");
      const sqlEvents = await queryAs<{ id: string; score: string; reason_text: string }>(db, viewer, "select event_id as id, score, reason_text from public.recommend_events(null, null, 50, $1::timestamptz)", [NOW]);
      expect((await repo.recommendations.places(viewer, { limit: 50 })).map((r) => [r.item.id, r.score, r.reason.text])).toEqual(sqlPlaces.map((r) => [r.id, Number(r.score), r.reason_text]));
      expect((await repo.recommendations.events(viewer, { limit: 50, now: NOW })).map((r) => [r.item.id, r.score, r.reason.text])).toEqual(sqlEvents.map((r) => [r.id, Number(r.score), r.reason_text]));
      expect(sqlPlaces.map((r) => r.id)).not.toContain(topPlace?.item.id);
    }
  }, 120_000);
});
