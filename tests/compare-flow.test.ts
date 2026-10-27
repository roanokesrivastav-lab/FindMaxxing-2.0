/**
 * The post-rating comparison flow: nextOpponent's binary search, and the demo
 * repository's nextComparison / compare (privacy, validation, replacing an answer).
 */
import { describe, expect, it, vi } from "vitest";
import { nextOpponent, type RankedPlace } from "../src/lib/ranking/nextComparison";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";

vi.mock("server-only", () => ({}));

const place = (id: string, stars: number, score: number): RankedPlace => ({ id, stars, score });

describe("nextOpponent", () => {
  const rated = [place("me", 4, 7), place("a", 4, 9), place("b", 4, 8), place("c", 4, 6), place("d", 4, 5), place("x", 5, 9.5), place("y", 2, 2)];

  it("asks only about places with the same stars, starting in the middle", () => {
    expect(nextOpponent("me", rated, [])).toBe("c"); // bucket a,b,c,d; middle index 2
  });

  it("halves the bucket on each answer and finishes within ceil(log2(n + 1)) questions", () => {
    // The person ranks me between b and c: beats c and d, loses to a and b.
    const truth = (opp: string) => ["c", "d"].includes(opp);
    const answers: { winnerId: string; loserId: string }[] = [];
    for (let asked = 0; ; asked++) {
      const next = nextOpponent("me", rated, answers);
      if (!next) { expect(asked).toBeLessThanOrEqual(3); break; }
      answers.push(truth(next) ? { winnerId: "me", loserId: next } : { winnerId: next, loserId: "me" });
    }
    expect(answers.length).toBeGreaterThan(0);
  });

  it("never repeats an answered place, and stops when the bucket is decided", () => {
    const answers = [{ winnerId: "me", loserId: "a" }, { winnerId: "me", loserId: "b" }];
    const next = nextOpponent("me", rated, answers);
    expect(next === null || !["a", "b"].includes(next)).toBe(true);
    expect(nextOpponent("me", [place("me", 3, 5), place("z", 4, 8)], [])).toBeNull();
    expect(nextOpponent("missing", rated, [])).toBeNull();
  });

  it("ignores answers about places outside the bucket", () => {
    expect(nextOpponent("me", rated, [{ winnerId: "me", loserId: "x" }, { winnerId: "y", loserId: "me" }])).toBe("c");
  });
});

describe("demo repository comparisons", () => {
  const store = createIsolatedStore();
  const repo = createDemoRepository(store);
  const [maya, nina] = ["maya_r", "nina"].map((u) => SEED_USERS.find((x) => x.username === u)!.id);
  const published = store.state.places.filter((p) => p.status === "published" && p.visibility === "public" && p.creatorId !== maya);
  const category = [...new Set(published.map((p) => p.categorySlug))].find((c) => published.filter((p) => p.categorySlug === c).length >= 3)!;
  const [p1, p2, p3] = published.filter((p) => p.categorySlug === category).slice(0, 3);
  const other = published.find((p) => p.categorySlug !== category)!;

  it("asks nothing before a rating, then asks about a same-star place", async () => {
    store.state.placeRatings = store.state.placeRatings.filter((r) => r.userId !== maya);
    expect(await repo.places.nextComparison(maya, p1.id)).toBeNull();
    await repo.places.rate(maya, p1.id, 4, null);
    expect(await repo.places.nextComparison(maya, p1.id)).toBeNull(); // nothing else rated yet
    await repo.places.rate(maya, p2.id, 4, null);
    await repo.places.rate(maya, p3.id, 2, null);
    await repo.places.rate(maya, other.id, 4, null);
    const q = await repo.places.nextComparison(maya, p2.id);
    expect(q?.subject.id).toBe(p2.id);
    expect(q?.opponent.id).toBe(p1.id); // not p3 (other stars) and not `other` (other category)
  });

  it("records an answer, finishes the bucket, and replaces a changed mind", async () => {
    await repo.places.compare(maya, p2.id, p1.id);
    expect(await repo.places.nextComparison(maya, p2.id)).toBeNull();
    await repo.places.compare(maya, p1.id, p2.id);
    const mine = store.state.placeComparisons.filter((c) => c.userId === maya);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ winnerId: p1.id, loserId: p2.id });
  });

  it("refuses unrated, cross-category and self comparisons, and keeps answers private", async () => {
    await expect(repo.places.compare(nina, p1.id, p2.id)).rejects.toThrow();
    await expect(repo.places.compare(maya, p1.id, other.id)).rejects.toThrow();
    await expect(repo.places.compare(maya, p1.id, p1.id)).rejects.toThrow();
    expect(await repo.places.nextComparison(nina, p1.id)).toBeNull();
  });

  it("forgets a person's answers when they delete their account", async () => {
    expect(store.state.placeComparisons.some((c) => c.userId === maya)).toBe(true);
    deleteDemoAccount(store, maya);
    expect(store.state.profiles.some((p) => p.id === maya)).toBe(false);
    expect(store.state.placeComparisons.some((c) => c.userId === maya)).toBe(false);
  });
});
