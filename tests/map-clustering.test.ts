/**
 * Roadmap 2.1: map clustering. The pure grouping (wide vs close zoom, co-located stacks at every zoom,
 * the selection kept out, determinism), the count labels (partial when capped), and the real
 * /api/discover/map route feeding it: a capped query, hidden places excluded, and real co-located records.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import type { EventMapRecord, PlaceMapRecord } from "../src/lib/data/types";
import { CLUSTER_MAX_ZOOM, clusterLabel, clusterMarkers, stacksOf, type ClusterItem } from "../src/lib/map/cluster";
import { eventMarker, placeMarker } from "../src/lib/map/markers";
import type { MapMarker } from "../src/lib/map/types";
import { ClusterPin, StackPin } from "../src/components/map/Pin";

const ctx: { repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = (() => {
  const store = createIsolatedStore();
  return { repo: createDemoRepository(store), store };
})();
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => null }));
vi.mock("@/lib/data", async (orig) => ({ ...(await orig<object>()), getRepository: async () => ctx.repo }));
vi.mock("@/server/analytics", () => ({ track: async () => {} }));
const { GET: mapRoute } = await import("../src/app/api/discover/map/route");

beforeEach(() => {
  ctx.store = createIsolatedStore();
  ctx.repo = createDemoRepository(ctx.store);
});

const m = (id: string, lat: number, lng: number, kind: "place" | "event" = "place"): MapMarker => ({ id, kind, lat, lng, color: "#000", categorySlug: "food", label: id });
const ids = (items: ClusterItem[]) => items.flatMap((i) => (i.type === "marker" ? [i.marker.id] : i.markers.map((x) => x.id))).sort();
const COLUMBUS = { lat: 39.9686, lng: -83.0037 };
// Ten pins within ~300 m, plus one far away.
const near = Array.from({ length: 10 }, (_, i) => m(`n${i}`, COLUMBUS.lat + i * 0.0003, COLUMBUS.lng + i * 0.0003));
const far = m("far", 40.1, -82.8);

describe("clusterMarkers", () => {
  it("merges nearby pins at a wide zoom and keeps every pin exactly once", () => {
    const items = clusterMarkers([...near, far], 11);
    const clusters = items.filter((i) => i.type === "cluster");
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters.reduce((n, c) => n + (c.type === "cluster" ? c.markers.length : 0), 0)).toBeLessThanOrEqual(10);
    expect(ids(items)).toEqual([...near, far].map((x) => x.id).sort());
    expect(items.some((i) => i.type === "marker" && i.marker.id === "far")).toBe(true);
  });

  it("does not cluster at close zooms", () => {
    const items = clusterMarkers(near, CLUSTER_MAX_ZOOM);
    expect(items.every((i) => i.type === "marker")).toBe(true);
  });

  it("co-located pins stack at every zoom, even the closest, so tapping never zooms forever", () => {
    const spot = [m("a", 40, -83), m("b", 40, -83, "event"), m("c", 40, -83)];
    for (const zoom of [CLUSTER_MAX_ZOOM, 18]) {
      const items = clusterMarkers(spot, zoom);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "stack" });
      // Places first, then events; ids in order: the "1 of N" order is stable.
      expect(items[0].type === "stack" && items[0].markers.map((x) => x.id)).toEqual(["a", "c", "b"]);
    }
  });

  it("keeps the selected pin (and its whole stack) out of clusters", () => {
    const items = clusterMarkers(near, 11, "n3");
    expect(items.some((i) => i.type === "marker" && i.marker.id === "n3")).toBe(true);
    expect(items.filter((i) => i.type === "cluster").every((c) => c.type === "cluster" && !c.markers.some((x) => x.id === "n3"))).toBe(true);
    const spot = [m("a", 40, -83), m("b", 40, -83), m("c", 40.0001, -83.0001)];
    const kept = clusterMarkers(spot, 11, ["b", null]);
    expect(kept.find((i) => i.type === "stack")).toMatchObject({ markers: [{ id: "a" }, { id: "b" }] });
  });

  it("is deterministic regardless of input order", () => {
    const shuffled = [...near, far].reverse();
    expect(JSON.stringify(clusterMarkers(shuffled, 11))).toBe(JSON.stringify(clusterMarkers([...near, far], 11)));
  });

  it("cluster bounds cover every member", () => {
    const c = clusterMarkers(near, 10).find((i) => i.type === "cluster");
    if (c?.type !== "cluster") throw new Error("expected a cluster");
    for (const x of c.markers) {
      expect(x.lat).toBeGreaterThanOrEqual(c.bounds.south);
      expect(x.lat).toBeLessThanOrEqual(c.bounds.north);
      expect(x.lng).toBeGreaterThanOrEqual(c.bounds.west);
      expect(x.lng).toBeLessThanOrEqual(c.bounds.east);
    }
  });
});

describe("labels and pins", () => {
  const cluster = clusterMarkers([...near.slice(0, 3), m("e1", COLUMBUS.lat, COLUMBUS.lng + 0.0001, "event")], 10).find((i) => i.type === "cluster") as ClusterItem;

  it("a full count, or a partial one when the query was capped", () => {
    if (cluster.type === "marker") throw new Error("expected a cluster");
    expect(clusterLabel(cluster, false)).toEqual({ count: "4", label: "4 in this area: 3 places and 1 event. Zoom in" });
    expect(clusterLabel(cluster, true)).toEqual({ count: "4+", label: "4+ in this area (partial count: zoom in for all): 3 places and 1 event. Zoom in" });
  });

  it("pins are labelled buttons showing the count", () => {
    const c = renderToStaticMarkup(h(ClusterPin, { count: "4+", label: "At least 4" }));
    expect(c).toMatch(/<button type="button" aria-label="At least 4"/);
    expect(c).toContain(">4+<");
    const s = renderToStaticMarkup(h(StackPin, { color: "#000", categorySlug: "food", count: "3", label: "3 places at this spot", active: true }));
    expect(s).toMatch(/aria-label="3 places at this spot" aria-pressed="true"/);
  });
});

describe("through the real map route", () => {
  const get = async (params: string) => (await mapRoute(new Request(`http://x/api/discover/map?${params}`))).json() as Promise<{ places: { items: PlaceMapRecord[]; truncated: boolean } | null; events: { items: EventMapRecord[]; truncated: boolean } | null }>;
  const markersOf = (body: Awaited<ReturnType<typeof get>>) => [...(body.places?.items ?? []).map(placeMarker), ...(body.events?.items ?? []).map((e) => eventMarker(e, "America/New_York"))];

  it("a capped query is labelled partial", async () => {
    const body = await get("limit=3");
    expect(body.places?.truncated).toBe(true);
    const items = clusterMarkers(markersOf(body), 3);
    const group = items.find((i) => i.type !== "marker") as ClusterItem | undefined;
    if (!group || group.type === "marker") throw new Error("expected a group at zoom 3");
    expect(clusterLabel(group, true).count).toMatch(/\+$/);
  });

  it("hidden places are excluded from every cluster", async () => {
    const victim = ctx.store.state.places.find((p) => p.status === "published")!;
    const before = ids(clusterMarkers(markersOf(await get("")), 5));
    expect(before).toContain(victim.id);
    victim.status = "hidden";
    const after = ids(clusterMarkers(markersOf(await get("")), 5));
    expect(after).not.toContain(victim.id);
    // Nothing new appears; events held at a hidden place are dropped by the existing visibility rule too.
    expect(after.every((id) => before.includes(id))).toBe(true);
  });

  it("real co-located records (an event at its place) form a stack", async () => {
    const all = markersOf(await get(""));
    const shared = stacksOf(all).filter((g) => g.length > 1);
    expect(shared.length).toBeGreaterThan(0);
    const items = clusterMarkers(all, 18);
    expect(items.filter((i) => i.type === "stack")).toHaveLength(shared.length);
  });
});

describe("flag", () => {
  it("the Explore page turns clustering on only with pilotExplore", async () => {
    vi.doMock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
    const { default: ExplorePage } = await import("../src/app/(explore)/page");
    const props = async () =>
      ((await ExplorePage({ searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never)) as { props: { pilotExplore: boolean } }).props;
    expect((await props()).pilotExplore).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect((await props()).pilotExplore).toBe(false);
    vi.unstubAllEnvs();
  });
});
