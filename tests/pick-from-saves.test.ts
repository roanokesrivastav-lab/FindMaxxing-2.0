/**
 * Roadmap 3.6 (R1): "Pick somewhere from my saves". Empty library, one match, filters
 * with no match (one specific widening), no repeats within a round, owner-only (the
 * action has no user parameter; another user only ever gets their own saves), and
 * the picker on /saved.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { parseLibraryFilters } from "../src/lib/places/library";
import { pickOne, widenOnce } from "../src/lib/places/pick";
import { ToastProvider } from "../src/components/ui/Toast";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";

const ctx = vi.hoisted(() => ({ repo: null as unknown as DataRepository, viewer: null as { id: string } | null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => "/saved",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const maya = user("maya_r");
const theo = user("theo");
const cannon = stableId("place:Cannon & Crown");

beforeEach(() => {
  ctx.repo = createDemoRepository(createIsolatedStore());
  ctx.viewer = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("pick (pure, over the demo library)", () => {
  it("an empty library says so", () => {
    expect(pickOne([], parseLibraryFilters({}), [])).toEqual({ kind: "empty" });
  });

  it("one match is picked every time", async () => {
    await ctx.repo.saves.update(maya, cannon, { tags: ["only-one"] });
    const items = await ctx.repo.saves.library(maya);
    const f = parseLibraryFilters({ tag: "only-one" });
    for (const r of [0, 0.5, 0.99]) {
      const res = pickOne(items, f, [], () => r);
      expect(res).toMatchObject({ kind: "picked", matches: 1, item: { place: { id: cannon } } });
    }
  });

  it("does not repeat until every match was shown, then starts a new round", async () => {
    const items = await ctx.repo.saves.library(maya);
    expect(items.length).toBeGreaterThan(2);
    const f = parseLibraryFilters({});
    let round: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const res = pickOne(items, f, round, Math.random);
      if (res.kind !== "picked") throw new Error("expected a pick");
      expect(seen.has(res.item.place.id)).toBe(false);
      seen.add(res.item.place.id);
      round = res.round;
    }
    const next = pickOne(items, f, round, Math.random);
    if (next.kind !== "picked") throw new Error("expected a pick");
    expect(next.round).toHaveLength(1);
    expect(next.item.place.id).not.toBe(round[round.length - 1]);
  });

  it("filters with no match offer one specific widening that does match", async () => {
    await ctx.repo.saves.update(maya, cannon, { tags: ["wings"] });
    const items = await ctx.repo.saves.library(maya);
    const f = parseLibraryFilters({ tag: "wings", status: "visited" });
    const res = pickOne(items, f, []);
    expect(res.kind).toBe("none");
    if (res.kind !== "none") return;
    expect(res.widening).not.toBeNull();
    expect(res.widening!.count).toBeGreaterThan(0);
    expect(pickOne(items, res.widening!.filters, []).kind).toBe("picked");
    expect(widenOnce(items, parseLibraryFilters({ q: "zzzz-nothing-anywhere" }))?.label).toBe("without the search “zzzz-nothing-anywhere”");
    expect(widenOnce([], parseLibraryFilters({ q: "x" }))).toBeNull();
  });
});

describe("the pick action", () => {
  it("needs a signed-in viewer and picks only from the viewer's own saves", async () => {
    const { pickFromSavesAction } = await import("../src/server/actions/saves");
    expect(await pickFromSavesAction({})).toMatchObject({ ok: false, code: "unauthenticated" });
    const mine = new Set((await ctx.repo.saves.library(theo)).map((i) => i.place.id));
    ctx.viewer = { id: theo };
    for (let i = 0; i < 20; i++) {
      const res = await pickFromSavesAction({});
      if (!res.ok || res.data.kind !== "picked") throw new Error("expected a pick");
      expect(mine.has(res.data.place.id)).toBe(true);
      // No owner-only field ever leaves in the result.
      expect(Object.keys(res.data.place).sort()).toEqual(["categorySlug", "id", "lat", "lng", "name", "neighborhood", "photoUrl"]);
    }
  });

  it("an empty library and a no-match filter answer honestly", async () => {
    const { pickFromSavesAction } = await import("../src/server/actions/saves");
    const fresh = user("nina");
    for (const item of await ctx.repo.saves.library(fresh)) await ctx.repo.places.unsave(fresh, item.place.id);
    ctx.viewer = { id: fresh };
    expect(await pickFromSavesAction({})).toEqual({ ok: true, data: { kind: "empty" } });
    ctx.viewer = { id: maya };
    const res = await pickFromSavesAction({ q: "zzzz-nothing" });
    expect(res).toEqual({ ok: true, data: { kind: "none", widening: { label: "without the search “zzzz-nothing”", count: expect.any(Number), href: "/saved" } } });
  });

  it("is off with pilotLibrary off", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilotExplore");
    const { pickFromSavesAction } = await import("../src/server/actions/saves");
    ctx.viewer = { id: maya };
    expect(await pickFromSavesAction({})).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("appears on /saved under the filters", async () => {
    const { default: SavedPage } = await import("../src/app/saved/page");
    ctx.viewer = { id: maya };
    const el = (await SavedPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ status: "want_to_go" }) } as never)) as ReactElement;
    const html = renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
    expect(html).toContain("Pick somewhere from my saves");
    expect(html).toContain("Picks from the saves matching your filters.");
  });
});
