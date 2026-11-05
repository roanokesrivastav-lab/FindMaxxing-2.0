/**
 * Roadmap 1.3: first-map arrival. Per-interest counts from the repositories' count() (the full
 * authorized set), the one widening offered, the real /api/discover/presence route, the real Explore
 * page deciding when arrival applies, and the arrival bar rendered on the server.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { DEFAULT_CENTER } from "../src/lib/config";
import { bboxParam } from "../src/lib/map/bounds";
import { arrivalWidening, interestPresence, widerBounds, WIDER_FACTOR } from "../src/lib/explore/arrival";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const ctx: { viewer: string | null; repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = (() => {
  const store = createIsolatedStore();
  return { viewer: maya, repo: createDemoRepository(store), store };
})();
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { destination: to });
  },
}));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => {
    if (!ctx.viewer) return null;
    const profile = await ctx.repo.profiles.getById(ctx.viewer);
    return profile ? { id: ctx.viewer, profile } : null;
  },
}));
vi.mock("@/lib/data", async (orig) => ({ ...(await orig<object>()), getRepository: async () => ctx.repo }));
vi.mock("@/server/analytics", () => ({ track: async () => {} }));

const { GET: presenceRoute } = await import("../src/app/api/discover/presence/route");
const { default: ExplorePage } = await import("../src/app/(explore)/page");
const { ArrivalBar } = await import("../src/components/explore/ArrivalBar");

beforeEach(() => {
  ctx.viewer = maya;
  ctx.store = createIsolatedStore();
  ctx.repo = createDemoRepository(ctx.store);
  vi.unstubAllEnvs();
});

// The Explore page's first area, and a small one in the middle of it.
const area = { north: DEFAULT_CENTER.lat + 0.07, south: DEFAULT_CENTER.lat - 0.07, east: DEFAULT_CENTER.lng + 0.12, west: DEFAULT_CENTER.lng - 0.12 };
const small = { north: 39.9712, south: 39.9512, east: -82.9838, west: -83.0138 };
const q = (bounds: typeof area, tags: string[]) => ({ bounds, tags, category: null, kind: "all" as const, viewerId: maya });

describe("presence counts", () => {
  it("a bigger area is three times the span around the same center", () => {
    const w = widerBounds(area);
    expect(w.north - w.south).toBeCloseTo((area.north - area.south) * WIDER_FACTOR);
    expect((w.north + w.south) / 2).toBeCloseTo((area.north + area.south) / 2);
    expect(widerBounds({ north: 10, south: -10, east: -170, west: 170 })).toEqual({ north: 10, south: -10, east: -170, west: 170 });
  });

  it("counts match the map's own filters (places + events, authorized)", async () => {
    const [coffee] = await interestPresence(ctx.repo, q(area, ["coffee"]));
    const f = { bounds: area, tags: ["coffee"], viewerId: maya };
    expect(coffee.nearby).toBe((await ctx.repo.places.count(f)) + (await ctx.repo.events.count(f)));
    expect(coffee.nearby).toBeGreaterThan(0);
    expect(arrivalWidening(coffee)).toBeNull();
  });

  it("no matches here, some in a bigger area: offers the bigger area", async () => {
    const [coffee] = await interestPresence(ctx.repo, q(small, ["coffee"]));
    expect(coffee).toMatchObject({ nearby: 0 });
    expect(coffee.wider).toBeGreaterThan(0);
    expect(arrivalWidening(coffee)).toBe("bigger-area");
  });

  it("no matches anywhere near: offers all interests", async () => {
    const [vol] = await interestPresence(ctx.repo, q(area, ["volunteering"]));
    expect(vol).toEqual({ slug: "volunteering", nearby: 0, wider: 0 });
    expect(arrivalWidening(vol)).toBe("all-interests");
  });

  it("hidden places are not counted", async () => {
    const [before] = await interestPresence(ctx.repo, q(area, ["coffee"]));
    const tagged = new Set(ctx.store.state.placeTags.filter((t) => t.interestSlug === "coffee").map((t) => t.placeId));
    for (const p of ctx.store.state.places) if (tagged.has(p.id)) p.status = "hidden";
    const [after] = await interestPresence(ctx.repo, q(area, ["coffee"]));
    expect(after.nearby).toBeLessThan(before.nearby);
  });
});

describe("GET /api/discover/presence", () => {
  const get = (params: string) => presenceRoute(new Request(`http://x/api/discover/presence?${params}`));

  it("returns per-interest counts for the area", async () => {
    const res = await get(`bbox=${bboxParam(small)}&tags=coffee,hiking`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interests.map((p: { slug: string }) => p.slug)).toEqual(["coffee", "hiking"]);
    expect(body.interests[1]).toEqual({ slug: "hiking", nearby: 0, wider: 0 });
  });

  it("respects kind and drops unknown tags", async () => {
    const all = await (await get(`bbox=${bboxParam(area)}&tags=coffee,nope`)).json();
    const places = await (await get(`bbox=${bboxParam(area)}&tags=coffee&kind=places`)).json();
    expect(all.interests).toHaveLength(1);
    expect(places.interests[0].nearby).toBe(await ctx.repo.places.count({ bounds: area, tags: ["coffee"], viewerId: maya }));
  });

  it("is off without pilotFoundation, and rejects a bad bbox", async () => {
    expect((await get("bbox=1,2,3")).status).toBe(400);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect((await get(`bbox=${bboxParam(area)}&tags=coffee`)).status).toBe(404);
  });
});

describe("Explore page", () => {
  type Props = { arrival: { slug: string; nearby: number }[] | null; welcome: boolean; pilotFoundation: boolean };
  const page = async (sp: Record<string, string>) =>
    ((await ExplorePage({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) } as never)) as { props: Props }).props;

  it("the first visit after onboarding carries counts for each picked interest", async () => {
    const props = await page({ tags: "coffee,volunteering", welcome: "1" });
    expect(props.arrival?.map((p) => p.slug)).toEqual(["coffee", "volunteering"]);
    expect(props.arrival?.[1].nearby).toBe(0);
  });

  it("all interests (the most the map takes): every one is counted", async () => {
    const eight = ["sports", "pickup-sports", "fitness", "hiking", "outdoors", "food", "coffee", "studying"];
    expect((await page({ tags: eight.join(","), welcome: "1" })).arrival).toHaveLength(8);
  });

  it("no arrival without welcome, without interests, signed out, or with the flag off", async () => {
    expect((await page({ tags: "coffee" })).arrival).toBeNull();
    expect((await page({ welcome: "1" })).arrival).toBeNull();
    ctx.viewer = null;
    expect((await page({ tags: "coffee", welcome: "1" })).arrival).toBeNull();
    ctx.viewer = maya;
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    const off = await page({ tags: "coffee", welcome: "1" });
    expect(off.arrival).toBeNull();
    expect(off.pilotFoundation).toBe(false);
  });
});

describe("ArrivalBar", () => {
  const bar = (interests: string[], presence: { slug: string; nearby: number; wider: number }[], status: "idle" | "loading" | "error" = "idle") =>
    renderToStaticMarkup(h(ArrivalBar, { interests, presence: { status, interests: presence }, onRemove: () => {}, onShowEverything: () => {}, onBiggerArea: () => {} }));

  it("removable interest filters with Show everything beside them", () => {
    const html = bar(["coffee", "food"], [{ slug: "coffee", nearby: 3, wider: 3 }, { slug: "food", nearby: 2, wider: 2 }]);
    expect(html).toMatch(/data-remove="coffee".*?Remove <\/span>Coffee<span class="sr-only"> filter/);
    expect(html).toMatch(/data-remove="food".*?Remove <\/span>Food<span class="sr-only"> filter/);
    expect(html).toMatch(/>Show everything</);
    expect(html).not.toContain("data-empty-interest");
  });

  it("an empty interest says so and offers exactly one widening", () => {
    const html = bar(["coffee", "hiking", "music"], [
      { slug: "coffee", nearby: 3, wider: 3 },
      { slug: "hiking", nearby: 0, wider: 0 },
      { slug: "music", nearby: 0, wider: 4 },
    ]);
    expect(html).toContain("Nothing for Hiking in this area yet.");
    expect(html).toMatch(/data-empty-interest="hiking" data-widening="all-interests".*?Show all interests/);
    expect(html).toMatch(/data-empty-interest="music" data-widening="bigger-area".*?Look in a bigger area/);
    expect(html.match(/data-empty-interest=/g)).toHaveLength(2);
  });

  it("every interest empty: one statement, not a repeat per interest", () => {
    const html = bar(["hiking", "dogs"], [{ slug: "hiking", nearby: 0, wider: 0 }, { slug: "dogs", nearby: 0, wider: 0 }]);
    expect(html).toContain("None of your interests has anything in this area yet.");
    expect(html.match(/data-empty-interest=/g)).toHaveLength(1);
  });

  it("loading and error states", () => {
    expect(bar(["coffee"], [], "loading")).toContain('aria-label="Checking this area"');
    expect(bar(["coffee"], [], "error")).toContain("Couldn&#x27;t check each interest in this area.");
  });
});
