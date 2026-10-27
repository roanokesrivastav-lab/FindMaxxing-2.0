/**
 * Head-to-head place comparisons (0037_place_comparisons.sql): owner-only,
 * only between places the writer rated in one category, one answer per pair;
 * and the SQL Bradley-Terry fit agrees with its TypeScript twin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { fitScores } from "../src/lib/ranking/bradleyTerry";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina] = ["maya_r", "nina"].map(user);

describe("place_comparisons and fit_user_category_scores", () => {
  let db: PGlite;
  let category: string;
  let places: string[];
  let otherCategoryPlace: string;
  const stars = [5, 3, 1, 4];

  const compare = (viewer: string, winner: string, loser: string) =>
    queryAs(db, viewer, "insert into public.place_comparisons (winner_id, loser_id) values ($1, $2)", [winner, loser]);
  const sqlScores = async (viewer: string) =>
    new Map((await queryAs<{ place_id: string; score: number }>(db, viewer, "select * from public.fit_user_category_scores($1)", [category])).map((r) => [r.place_id, r.score]));

  beforeAll(async () => {
    db = await createSeededDb();
    const rows = await queryAs<{ id: string; category_slug: string }>(db, maya,
      `select id, category_slug from public.places where status = 'published' and visibility = 'public' and creator_id <> $1 order by category_slug, id`, [maya]);
    const byCategory = new Map<string, string[]>();
    for (const r of rows) byCategory.set(r.category_slug, [...(byCategory.get(r.category_slug) ?? []), r.id]);
    category = [...byCategory.keys()].find((c) => byCategory.get(c)!.length >= 4)!;
    places = byCategory.get(category)!.slice(0, 4);
    otherCategoryPlace = rows.find((r) => r.category_slug !== category)!.id;
    await queryAs(db, maya, "delete from public.place_ratings where user_id = $1", [maya]);
    for (const [i, id] of places.entries()) {
      await queryAs(db, maya, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, $3)", [maya, id, stars[i]]);
    }
    await queryAs(db, maya, "insert into public.place_ratings (user_id, place_id, score) values ($1, $2, 4)", [maya, otherCategoryPlace]);
  });
  afterAll(async () => { await db?.close(); });

  it("with no comparisons, scores follow the star ratings", async () => {
    const scores = await sqlScores(maya);
    expect(scores.size).toBe(4);
    const [five, three, one, four] = places.map((id) => scores.get(id)!);
    expect(five).toBeGreaterThan(four);
    expect(four).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(one);
  });

  it("a win lifts the winner and lowers the loser, and the SQL fit matches the TypeScript one", async () => {
    const before = await sqlScores(maya);
    await compare(maya, places[2], places[0]); // the 1-star place beats the 5-star one
    await compare(maya, places[2], places[3]);
    await compare(maya, places[1], places[0]);
    const after = await sqlScores(maya);
    expect(after.get(places[2])!).toBeGreaterThan(before.get(places[2])!);
    expect(after.get(places[0])!).toBeLessThan(before.get(places[0])!);

    const expected = fitScores(
      places.map((id, i) => ({ id, stars: stars[i] })),
      [{ winnerId: places[2], loserId: places[0] }, { winnerId: places[2], loserId: places[3] }, { winnerId: places[1], loserId: places[0] }],
    );
    for (const id of places) expect(after.get(id)!).toBeCloseTo(expected.get(id)!, 9);
  });

  it("answers each pair once, in either direction", async () => {
    await expect(compare(maya, places[2], places[0])).rejects.toThrow();
    await expect(compare(maya, places[0], places[2])).rejects.toThrow();
  });

  it("refuses places the writer has not rated, or from different categories, or against itself", async () => {
    await expect(compare(nina, places[0], places[1])).rejects.toThrow();
    await expect(compare(maya, places[0], otherCategoryPlace)).rejects.toThrow();
    await expect(compare(maya, places[0], places[0])).rejects.toThrow();
  });

  it("refuses a comparison written as someone else", async () => {
    await expect(queryAs(db, maya, "insert into public.place_comparisons (user_id, winner_id, loser_id) values ($1, $2, $3)", [nina, places[1], places[3]])).rejects.toThrow();
  });

  it("is private to its owner", async () => {
    expect((await queryAs(db, maya, "select 1 from public.place_comparisons")).length).toBe(3);
    expect(await queryAs(db, nina, "select 1 from public.place_comparisons")).toHaveLength(0);
    expect(await queryAs(db, null, "select 1 from public.place_comparisons").catch(() => [])).toHaveLength(0);
    expect(await sqlScores(nina)).toHaveProperty("size", 0);
    await queryAs(db, nina, "delete from public.place_comparisons");
    expect((await queryAs(db, maya, "select 1 from public.place_comparisons")).length).toBe(3);
  });

  it("lets the owner delete a comparison and answer the pair again", async () => {
    await queryAs(db, maya, "delete from public.place_comparisons where winner_id = $1 and loser_id = $2", [places[1], places[0]]);
    await compare(maya, places[0], places[1]);
  });
});
