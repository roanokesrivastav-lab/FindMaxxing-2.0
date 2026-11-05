/**
 * Per-category taste (0035_user_taste.sql) and the diversity pass
 * (src/server/recommendations/diversify.ts): a low rating pulls similar
 * places down and a high one lifts them, the same in SQL and the demo; the
 * taste view is the viewer's own only; a rail never has more than three of
 * one category; and rules-v2 does at least as well as rules-v1 offline.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { diversify, DIVERSITY_PLANNED, similarity, type DiversityView } from "../src/server/recommendations/diversify";
import { evaluate } from "../scripts/recs/eval";

vi.mock("server-only", () => ({}));

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina] = ["maya_r", "nina"].map(user);
type Row = { id: string; score: string };

describe("taste in recommend_places and its demo twin", () => {
  let db: PGlite;
  const store = createIsolatedStore();
  const repo = createDemoRepository(store);
  const sqlScores = async (viewer: string) => new Map((await queryAs<Row>(db, viewer, "select place_id as id, score from public.recommend_places(null, null, 50)")).map((r) => [r.id, Number(r.score)]));
  const demoScores = async (viewer: string) => new Map((await repo.recommendations.places(viewer, { limit: 50 })).map((r) => [r.item.id, r.score]));

  beforeAll(async () => {
    db = await createSeededDb();
    await alignDbWithDemo(db, store);
  });
  afterAll(async () => { await db?.close(); });

  it("pulls places like a 1-star rating down, and lifts them for a 5, in SQL and the demo alike", async () => {
    const before = await sqlScores(nina);
    const tagsOf = (id: string) => store.state.placeTags.filter((t) => t.placeId === id).map((t) => t.interestSlug);
    // A recommended place, and another nina has not touched that shares its category and a tag.
    const touched = new Set([...store.state.savedPlaces, ...store.state.placeRatings].filter((r) => r.userId === nina).map((r) => r.placeId));
    let target: string | undefined;
    let similar: string | undefined;
    for (const id of before.keys()) {
      const p = store.state.places.find((x) => x.id === id)!;
      const twin = store.state.places.find((q) => q.id !== id && !touched.has(q.id) && q.status === "published" && q.visibility === "public"
        && q.categorySlug === p.categorySlug && q.creatorId !== nina && tagsOf(q.id).some((t) => tagsOf(id).includes(t)));
      if (twin && tagsOf(id).length) { target = id; similar = twin.id; break; }
    }
    expect(target && similar).toBeTruthy();
    for (const [stars, direction] of [[1, -1], [5, 1]] as const) {
      await queryAs(db, nina, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, $3) on conflict (place_id, user_id) do update set score = excluded.score", [nina, similar, stars]);
      await repo.places.rate(nina, similar!, stars, null);
      const sql = await sqlScores(nina);
      const demo = await demoScores(nina);
      expect(Math.sign(sql.get(target!)! - before.get(target!)!)).toBe(direction);
      expect(demo.get(target!)).toBe(sql.get(target!));
    }
  });

  it("shows each person only their own taste", async () => {
    const mine = await queryAs<{ category_slug: string | null; interest_slug: string; weight: number }>(db, maya, "select * from public.user_taste");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((r) => r.category_slug === null)).toBe(true);
    // Computed for auth.uid(): nothing is keyed by anyone else, and anonymous callers are refused.
    expect(Object.keys(mine[0]).sort()).toEqual(["category_slug", "interest_slug", "weight"]);
    await expect(queryAs(db, null, "select * from public.user_taste")).rejects.toThrow(/permission denied/);
    const ninas = await queryAs<{ interest_slug: string; weight: number }>(db, nina, "select interest_slug, weight from public.user_taste where category_slug is null order by interest_slug");
    const mayas = mine.filter((r) => r.category_slug === null).sort((a, b) => a.interest_slug.localeCompare(b.interest_slug));
    expect(ninas).not.toEqual(mayas.map((r) => ({ interest_slug: r.interest_slug, weight: r.weight })));
  });
});

describe("diversify()", () => {
  const v = (category: string, score: number, creatorId: string | null = null, tags: string[] = []): DiversityView => ({ category, score, creatorId, tags });

  it("measures similarity as same category plus half the tag overlap", () => {
    expect(similarity(v("food", 1, null, ["a", "b"]), v("food", 1, null, ["b", "c"]))).toBeCloseTo(1 + 0.5 / 3);
    expect(similarity(v("food", 1), v("bars", 1))).toBe(0);
  });

  it("keeps at most three per category, in score order by default", () => {
    const items = [v("a", 10), v("a", 9), v("a", 8), v("a", 7), v("b", 6), v("c", 5)];
    expect(diversify(items, (x) => x)).toEqual([items[0], items[1], items[2], items[4], items[5]]);
  });

  it("with the planned setting, caps creators and trades a little score for variety", () => {
    const items = [v("a", 10, "x", ["t"]), v("a", 9.9, "x", ["t"]), v("a", 9.8, "x", ["t"]), v("b", 9, "y", ["u"])];
    const out = diversify(items, (x) => x, DIVERSITY_PLANNED);
    expect(out[0]).toBe(items[0]);
    // The near-copy loses to a different category, and the creator cap stops the third.
    expect(out[1]).toBe(items[3]);
    expect(out).toHaveLength(3);
  });
});

describe("the served rails", () => {
  it("never show more than three of one category", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "recommendations");
    try {
      const { forYouPlaces, forYouEvents } = await import("../src/server/recommendations");
      const repo = createDemoRepository(createIsolatedStore());
      for (const u of SEED_USERS) {
        const viewer = { id: u.id, profile: { interests: [] } };
        for (const rail of [await forYouPlaces(repo, viewer), await forYouEvents(repo, viewer)]) {
          expect(rail.policy).toBe("rules-v2");
          expect(rail.items.length).toBeLessThanOrEqual(12);
          const per = new Map<string, number>();
          for (const r of rail.items) per.set(r.item.categorySlug, (per.get(r.item.categorySlug) ?? 0) + 1);
          expect(Math.max(0, ...per.values())).toBeLessThanOrEqual(3);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("offline", () => {
  it("rules-v2 does at least as well as rules-v1 on the demo dataset", () => {
    const state = createIsolatedStore().state;
    const v1 = evaluate(state, { policy: "rules-v1" });
    const v2 = evaluate(state, { policy: "rules-v2" });
    expect(v2.places.recall).toBeGreaterThanOrEqual(v1.places.recall);
    expect(v2.places.ndcg).toBeGreaterThanOrEqual(v1.places.ndcg);
    expect(v2.events.recall).toBeGreaterThanOrEqual(v1.events.recall);
  });
});
