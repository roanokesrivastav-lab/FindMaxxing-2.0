/**
 * Comparison scores in taste (0038_comparison_taste.sql): a rating weighs its
 * Bradley-Terry strength, which is stars - 3 until the viewer compares places,
 * and the SQL view and its demo twin agree either way.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";

vi.mock("server-only", () => ({}));

const nina = SEED_USERS.find((x) => x.username === "nina")!.id;

describe("taste with head-to-head comparisons", () => {
  let db: PGlite;
  const store = createIsolatedStore();
  const repo = createDemoRepository(store);
  let a: string;
  let b: string;
  const sqlScores = async () => new Map((await queryAs<{ id: string; score: string }>(db, nina, "select place_id as id, score from public.recommend_places(null, null, 50)")).map((r) => [r.id, Number(r.score)]));
  const demoScores = async () => new Map((await repo.recommendations.places(nina, { limit: 50 })).map((r) => [r.item.id, r.score]));
  const taste = async () => new Map((await queryAs<{ category_slug: string | null; interest_slug: string; weight: number }>(db, nina, "select * from public.user_taste")).map((r) => [`${r.category_slug}/${r.interest_slug}`, Number(r.weight)]));

  beforeAll(async () => {
    db = await createSeededDb();
    await alignDbWithDemo(db, store);
    const touched = new Set(store.state.placeRatings.filter((r) => r.userId === nina).map((r) => r.placeId));
    const pool = store.state.places.filter((p) => p.status === "published" && p.visibility === "public" && p.creatorId !== nina && !touched.has(p.id));
    const category = [...new Set(pool.map((p) => p.categorySlug))].find((c) => pool.filter((p) => p.categorySlug === c).length >= 2)!;
    [a, b] = pool.filter((p) => p.categorySlug === category).slice(0, 2).map((p) => p.id);
    for (const id of [a, b]) {
      await queryAs(db, nina, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, 4)", [nina, id]);
      await repo.places.rate(nina, id, 4, null);
    }
  });
  afterAll(async () => { await db?.close(); });

  it("with no comparisons, SQL and demo agree exactly", async () => {
    const sql = await sqlScores();
    const demo = await demoScores();
    for (const [id, score] of sql) expect(demo.get(id)).toBe(score);
  });

  it("an answer moves taste, and SQL and demo still agree", async () => {
    const tasteBefore = await taste();
    await queryAs(db, nina, "insert into public.place_comparisons (winner_id, loser_id) values ($1, $2)", [a, b]);
    await repo.places.compare(nina, a, b);
    const tasteAfter = await taste();
    const moved = [...tasteAfter].some(([k, w]) => Math.abs(w - (tasteBefore.get(k) ?? 0)) > 1e-6);
    expect(moved).toBe(true);
    const sql = await sqlScores();
    const demo = await demoScores();
    expect([...sql.keys()].sort()).toEqual([...demo.keys()].sort());
    for (const [id, score] of sql) expect(Math.abs(demo.get(id)! - score)).toBeLessThan(0.011);
  });
});
