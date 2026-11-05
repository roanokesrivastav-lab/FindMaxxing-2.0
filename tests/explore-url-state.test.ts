/**
 * Roadmap 2.2: Explore state in the URL. Strict parsing and round trips, and the real Explore page
 * restoring camera, filters, selection and view from a deep link (selection re-authorized on the
 * server), with today's behaviour when pilotExplore is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import type { Event, Place } from "../src/lib/data/types";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "../src/lib/config";
import { approximateBounds, parseExploreState, serializeExploreState, type ExploreUrlState } from "../src/lib/explore/urlState";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const ctx: { viewer: string | null; repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = (() => {
  const store = createIsolatedStore();
  return { viewer: maya, repo: createDemoRepository(store), store };
})();
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { destination: to }); } }));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => {
    if (!ctx.viewer) return null;
    const profile = await ctx.repo.profiles.getById(ctx.viewer);
    return profile ? { id: ctx.viewer, profile } : null;
  },
}));
vi.mock("@/lib/data", async (orig) => ({ ...(await orig<object>()), getRepository: async () => ctx.repo }));
vi.mock("@/server/analytics", () => ({ track: async () => {} }));
const { default: ExplorePage } = await import("../src/app/(explore)/page");

beforeEach(() => {
  ctx.viewer = maya;
  ctx.store = createIsolatedStore();
  ctx.repo = createDemoRepository(ctx.store);
  vi.unstubAllEnvs();
});

const UUID = "0b7c1f0e-1d2a-4c3b-8e9f-0a1b2c3d4e5f";
const base: ExploreUrlState = { camera: null, q: "", category: null, tags: [], kind: "all", sel: null, view: "map" };

describe("parse and serialize", () => {
  it("the plain map is the plain URL", () => {
    expect(serializeExploreState(base)).toBe("");
    expect(parseExploreState({})).toEqual(base);
  });

  it("round-trips camera, filters, selection and view (reopen after panning)", () => {
    const s: ExploreUrlState = { camera: { lat: 39.98123, lng: -83.00456, zoom: 14.25 }, q: "tacos", category: "food", tags: ["coffee", "food"], kind: "places", sel: { kind: "place", id: UUID }, view: "list" };
    expect(parseExploreState(new URLSearchParams(serializeExploreState(s)))).toEqual(s);
  });

  it("drops anything unknown or out of range", () => {
    expect(
      parseExploreState({ at: "999,0,12", category: "nope", tags: "coffee,nope,coffee", kind: "everything", sel: "place:not-a-uuid", view: "grid" }),
    ).toEqual({ ...base, tags: ["coffee"] });
    expect(parseExploreState({ at: "40,-83,40" }).camera).toBeNull(); // zoom out of range
    expect(parseExploreState({ at: "40,-83" }).camera).toBeNull();
    expect(parseExploreState({ sel: "user:" + UUID }).sel).toBeNull();
    expect(parseExploreState({ tags: "sports,pickup-sports,fitness,hiking,outdoors,food,coffee,studying,nightlife" }).tags).toHaveLength(8);
    expect(parseExploreState({ q: "x".repeat(200) }).q).toHaveLength(80);
  });

  it("the first-paint bounds at the default zoom match the default request", () => {
    const b = approximateBounds({ lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, zoom: DEFAULT_ZOOM }, DEFAULT_ZOOM);
    expect(b.north - b.south).toBeCloseTo(0.14);
    expect(b.east - b.west).toBeCloseTo(0.24);
    const wide = approximateBounds({ lat: 40, lng: -83, zoom: 3 }, DEFAULT_ZOOM);
    expect(wide.north).toBeLessThanOrEqual(85);
    expect(wide.west).toBeGreaterThanOrEqual(-180);
  });
});

type Props = {
  urlState: ExploreUrlState | null;
  initialSelected: { kind: string; item: Place | Event } | null;
  initialRequest: { bounds: unknown; text: string; category: string | null; tags: string[]; kind: string };
  initial: { placeMarkers: { items: { categorySlug: string }[] } | null; eventMarkers: { items: unknown[] } | null; places: { items: Place[] } };
};
const page = async (sp: Record<string, string>) =>
  ((await ExplorePage({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) } as never)) as { props: Props }).props;

describe("Explore page restores from the URL", () => {
  it("deep link with filters: the first paint already uses them", async () => {
    const props = await page({ category: "food", kind: "places", tags: "cheap-eats" });
    expect(props.initialRequest).toMatchObject({ category: "food", kind: "places", tags: ["cheap-eats"] });
    expect(props.initial.eventMarkers).toBeNull();
    expect(props.initial.placeMarkers?.items.length).toBeGreaterThan(0);
    expect(props.initial.placeMarkers?.items.every((m) => m.categorySlug === "food")).toBe(true);
  });

  it("a search in the URL covers everywhere, like typing it", async () => {
    const props = await page({ q: "coffee" });
    expect(props.initialRequest).toMatchObject({ text: "coffee", bounds: null });
  });

  it("camera: the first paint covers the restored area", async () => {
    const props = await page({ at: "39.99,-83.01,15" });
    expect(props.urlState?.camera).toEqual({ lat: 39.99, lng: -83.01, zoom: 15 });
    expect(props.initialRequest.bounds).toEqual(approximateBounds({ lat: 39.99, lng: -83.01, zoom: 15 }, DEFAULT_ZOOM));
  });

  it("back navigation: the selected place comes back, loaded on the server", async () => {
    const place = ctx.store.state.places.find((p) => p.status === "published")!;
    const props = await page({ sel: `place:${place.id}`, view: "list" });
    expect(props.initialSelected).toMatchObject({ kind: "place", item: { id: place.id } });
    expect(props.urlState?.view).toBe("list");
  });

  it("a selection the viewer may not see is not restored", async () => {
    const place = ctx.store.state.places.find((p) => p.status === "published")!;
    place.status = "hidden";
    expect((await page({ sel: `place:${place.id}` })).initialSelected).toBeNull();
    expect((await page({ sel: `event:${UUID}` })).initialSelected).toBeNull();
  });

  it("flag off: today's behaviour (only tags are read)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    const props = await page({ category: "food", kind: "places", tags: "coffee", at: "39.99,-83.01,15", sel: `place:${UUID}` });
    expect(props.urlState).toBeNull();
    expect(props.initialSelected).toBeNull();
    expect(props.initialRequest).toMatchObject({ category: null, kind: "all", tags: ["coffee"] });
    expect(props.initial.eventMarkers).not.toBeNull();
  });
});
