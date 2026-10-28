/**
 * The offline evaluation harness (scripts/recs/eval.ts) and the cold-start
 * fallback (0034_cold_start_fallback.sql): a time split that hides the
 * future from the replay, standard recall/NDCG, and "Popular with locals"
 * for someone with nothing but a home city, the same in SQL and the demo.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { evaluate, formatReport, holdoutCount, ndcgAt, rewindPerson } from "../scripts/recs/eval";

vi.mock("server-only", () => ({}));

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
type Row = { id: string; score: string; reason_kind: string; reason_text: string };

describe("evaluation metrics", () => {
  it("holds out the last fifth, at least one, never everything", () => {
    expect([0, 1, 2, 4, 5, 6, 10].map((n) => holdoutCount(n, 0.2))).toEqual([0, 0, 1, 1, 1, 2, 2]);
  });

  it("computes NDCG for binary relevance", () => {
    expect(ndcgAt(["a", "b", "c"], new Set(["a"]), 3)).toBe(1);
    expect(ndcgAt(["x", "a"], new Set(["a"]), 2)).toBeCloseTo(1 / Math.log2(3));
    expect(ndcgAt(["x", "y"], new Set(["a"]), 2)).toBe(0);
    // Only the top k count.
    expect(ndcgAt(["x", "y", "a"], new Set(["a"]), 2)).toBe(0);
  });
});

describe("the time split", () => {
  it("rewinds only the person, from the split on", () => {
    const state = createIsolatedStore().state;
    const saves = state.savedPlaces.filter((s) => s.userId === maya).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const splitAt = Date.parse(saves[saves.length - 1].createdAt);
    const past = rewindPerson(state, maya, splitAt);
    expect(past.savedPlaces.filter((s) => s.userId === maya)).toHaveLength(saves.length - 1);
    expect(past.savedPlaces.filter((s) => s.userId !== maya)).toEqual(state.savedPlaces.filter((s) => s.userId !== maya));
    expect(past.placeRatings.filter((r) => r.userId === maya).every((r) => Date.parse(r.updatedAt) < splitAt)).toBe(true);
    // The input is not changed.
    expect(state.savedPlaces.filter((s) => s.userId === maya)).toHaveLength(saves.length);
  });

  it("reports rules-v1 recall@12 and NDCG@12 on the demo dataset, deterministically", () => {
    const report = evaluate(createIsolatedStore().state, { policy: "rules-v1" });
    expect(report).toMatchObject({ policy: "rules-v1", k: 12 });
    expect(report.places.people).toBeGreaterThan(0);
    expect(report.events.people).toBeGreaterThan(0);
    for (const m of [report.places, report.events, report.places.sparse]) {
      expect(m.recall).toBeGreaterThanOrEqual(0);
      expect(m.recall).toBeLessThanOrEqual(1);
      expect(m.ndcg).toBeGreaterThanOrEqual(0);
      expect(m.ndcg).toBeLessThanOrEqual(1);
      expect(m.hits).toBeLessThanOrEqual(m.heldOut);
    }
    const categories = Object.values(report.places.byCategory);
    expect(categories.reduce((n, c) => n + c.heldOut, 0)).toBe(report.places.heldOut);
    expect(evaluate(createIsolatedStore().state, { policy: "rules-v1" })).toEqual(report);
    expect(formatReport(report)).toMatch(/recall@12 .*NDCG@12/);
  });
});

describe("cold-start fallback", () => {
  let db: PGlite;
  const store = createIsolatedStore();
  const repo = createDemoRepository(store);
  const newcomer = crypto.randomUUID();

  beforeAll(async () => {
    db = await createSeededDb();
    await alignDbWithDemo(db, store);
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)", [newcomer, `${newcomer}@example.test`, JSON.stringify({ username: `new_${newcomer.slice(0, 8)}`, display_name: "Newcomer" })]);
    const createdAt = new Date().toISOString();
    store.state.profiles.push({ ...store.state.profiles.find((p) => p.id === maya)!, id: newcomer, username: `new_${newcomer.slice(0, 8)}`, displayName: "Newcomer", homeCity: null, createdAt });
  });
  afterAll(async () => { await db?.close(); });

  const sqlRecs = () => queryAs<Row>(db, newcomer, "select place_id as id, score, reason_kind, reason_text from public.recommend_places(null, null, 50)");
  const setCity = async (city: string | null) => {
    await db.query("update public.profiles set home_city = $2 where id = $1", [newcomer, city]);
    store.state.profiles.find((p) => p.id === newcomer)!.homeCity = city;
  };

  it("gives someone with nothing but a home city at least six places Popular with locals, in SQL and the demo", async () => {
    await setCity(null);
    expect(await sqlRecs()).toEqual([]);
    expect(await repo.recommendations.places(newcomer, { limit: 50 })).toEqual([]);
    await setCity("Columbus");
    const sql = await sqlRecs();
    expect(sql.length).toBeGreaterThanOrEqual(6);
    expect(sql.every((r) => r.reason_kind === "popular_local" && r.reason_text === "Popular with locals")).toBe(true);
    const demo = await repo.recommendations.places(newcomer, { limit: 50 });
    expect(demo.map((r) => [r.item.id, r.score, r.reason.text])).toEqual(sql.map((r) => [r.id, Number(r.score), r.reason_text]));
    // Most saved first; nothing nobody saved; nothing from another city.
    const counts = new Map((await db.query<{ id: string; save_count: number; city: string }>("select id, save_count, city from public.places")).rows.map((p) => [p.id, p]));
    expect(sql.every((r) => counts.get(r.id)!.save_count > 0 && counts.get(r.id)!.city === "Columbus")).toBe(true);
    await setCity("Cleveland");
    expect(await sqlRecs()).toEqual([]);
  });

  it("only fills in behind places with a reason of their own", async () => {
    let mixed = 0;
    for (const viewer of SEED_USERS.map((u) => u.id)) {
      const sql = await queryAs<Row>(db, viewer, "select place_id as id, score, reason_kind, reason_text from public.recommend_places(null, null, 50)");
      const firstFallback = sql.findIndex((r) => r.reason_kind === "popular_local");
      if (firstFallback < 0) continue;
      if (firstFallback > 0) mixed++;
      expect(sql.slice(firstFallback).every((r) => r.reason_kind === "popular_local" && Number(r.score) < 0.9)).toBe(true);
      expect(sql.slice(0, firstFallback).every((r) => Number(r.score) > 1)).toBe(true);
    }
    expect(mixed).toBeGreaterThan(0);
  });
});

describe("the online metrics query (docs/recommendations-metrics.md)", () => {
  it("credits saves, views and hides to the latest For you impression before them", async () => {
    const doc = readFileSync(path.join(__dirname, "../docs/recommendations-metrics.md"), "utf8");
    const query = doc.match(/```sql\n([\s\S]*?)```/)![1];
    const db = await createSeededDb();
    try {
      const places = (await db.query<{ id: string }>("select id from public.places where status = 'published' and visibility = 'public' order by id limit 3")).rows.map((r) => r.id);
      const [a, b, c] = places;
      const [r1, r2] = [crypto.randomUUID(), crypto.randomUUID()];
      const row = "insert into public.user_interactions (user_id, item_type, item_id, action, surface, position, request_id, policy, score, created_at) values ($1, 'place', $2, $3, $4, $5, $6, $7, $8, now() - make_interval(hours => $9))";
      // rules-v1: three impressions; a is viewed then saved a day later, b is hidden, c is saved 8 days on (too late).
      await db.query(row, [maya, a, "impression", "for_you", 0, r1, "rules-v1", 5, 240]);
      await db.query(row, [maya, b, "impression", "for_you", 1, r1, "rules-v1", 4, 240]);
      await db.query(row, [maya, c, "impression", "for_you", 2, r1, "rules-v1", 3, 240]);
      await db.query(row, [maya, a, "view", "detail", null, null, null, null, 239]);
      await db.query(row, [maya, a, "save", null, null, null, null, null, 216]);
      await db.query(row, [maya, b, "hide", "for_you", 1, r1, "rules-v1", null, 239]);
      await db.query(row, [maya, c, "save", null, null, null, null, null, 0]);
      // rules-v1+rerank: one impression, nothing after it.
      await db.query(row, [maya, b, "impression", "for_you", 0, r2, "rules-v1+rerank", 6, 1]);
      const out = (await db.query<Record<string, string | number>>(query)).rows.map((r) => ({ ...r, impressions: Number(r.impressions), renders: Number(r.renders) }));
      expect(out).toEqual([
        { policy: "rules-v1", item_type: "place", impressions: 3, renders: 1, distinct_items: 3, click_rate: "0.3333", save_rate: "0.3333", join_rate: "0.0000", hide_rate: "0.3333" },
        { policy: "rules-v1+rerank", item_type: "place", impressions: 1, renders: 1, distinct_items: 1, click_rate: "0.0000", save_rate: "0.0000", join_rate: "0.0000", hide_rate: "0.0000" },
      ]);
    } finally {
      await db.close();
    }
  });
});
