/**
 * Roadmap 2.4a: intent filter tabs. When windows on a frozen clock (including both DST changes), the
 * overlap rule, the travel box, the single widening, the real discovery routes honouring a When window,
 * and parity of that window between the demo twin and the SQL function (PGlite).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { alignDbWithDemo } from "./helpers/parity";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { discoverArgs } from "../src/lib/data/supabase/repository";
import { eventCutoffMs, normalizeFilters, UPCOMING_GRACE_MS } from "../src/lib/data/discovery";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { distanceMeters } from "../src/lib/utils/geo";
import { AREA_METERS, boundsAround, inWindow, intentWidening, NOW_WINDOW_MS, whenWindow, type TimeWindow } from "../src/lib/explore/intent";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);

describe("When windows (frozen clock)", () => {
  it("any time is no window; now is on now or starting within the hour", () => {
    expect(whenWindow("any", at("2026-11-04T15:00:00Z"), NY)).toBeNull();
    expect(whenWindow("now", at("2026-11-04T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-04T15:00:00.000Z", startsBefore: new Date(at("2026-11-04T15:00:00Z") + NOW_WINDOW_MS).toISOString() });
  });

  it("tonight: 5 pm to 4 am local; after 5 pm it starts now; before 4 am it is still last night", () => {
    // Wed 2026-11-04 10:00 EST (15:00Z): 17:00 EST = 22:00Z, Thu 04:00 EST = 09:00Z.
    expect(whenWindow("tonight", at("2026-11-04T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-04T22:00:00.000Z", startsBefore: "2026-11-05T09:00:00.000Z" });
    expect(whenWindow("tonight", at("2026-11-05T01:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-05T01:00:00.000Z", startsBefore: "2026-11-05T09:00:00.000Z" }); // 20:00 EST
    expect(whenWindow("tonight", at("2026-11-05T07:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-05T07:00:00.000Z", startsBefore: "2026-11-05T09:00:00.000Z" }); // 02:00 EST
  });

  it("this weekend: Friday 5 pm to Monday 00:00; on the weekend, from now", () => {
    // Wed 2026-11-04 → Fri 11-06 17:00 EST (22:00Z) to Mon 11-09 00:00 EST (05:00Z).
    expect(whenWindow("weekend", at("2026-11-04T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-06T22:00:00.000Z", startsBefore: "2026-11-09T05:00:00.000Z" });
    expect(whenWindow("weekend", at("2026-11-07T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-07T15:00:00.000Z", startsBefore: "2026-11-09T05:00:00.000Z" }); // Saturday
    expect(whenWindow("weekend", at("2026-11-08T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-11-08T15:00:00.000Z", startsBefore: "2026-11-09T05:00:00.000Z" }); // Sunday
  });

  it("across the fall-back DST change (Sun 2026-11-01)", () => {
    // Fri 10-30 17:00 EDT = 21:00Z; Mon 11-02 00:00 EST = 05:00Z.
    expect(whenWindow("weekend", at("2026-10-28T15:00:00Z"), NY)).toEqual({ endsAfter: "2026-10-30T21:00:00.000Z", startsBefore: "2026-11-02T05:00:00.000Z" });
    // Sat 10-31 noon EDT: tonight 17:00 EDT (21:00Z) to Sun 04:00 EST (09:00Z), a 12-hour night.
    expect(whenWindow("tonight", at("2026-10-31T16:00:00Z"), NY)).toEqual({ endsAfter: "2026-10-31T21:00:00.000Z", startsBefore: "2026-11-01T09:00:00.000Z" });
  });

  it("across the spring-forward DST change (Sun 2027-03-14)", () => {
    // Sat 03-13 noon EST: 17:00 EST = 22:00Z; Sun 04:00 EDT = 08:00Z (a 10-hour night).
    expect(whenWindow("tonight", at("2027-03-13T17:00:00Z"), NY)).toEqual({ endsAfter: "2027-03-13T22:00:00.000Z", startsBefore: "2027-03-14T08:00:00.000Z" });
    // In another zone the same instant gives that zone's evening.
    expect(whenWindow("tonight", at("2027-03-13T17:00:00Z"), "America/Los_Angeles")).toEqual({ endsAfter: "2027-03-14T01:00:00.000Z", startsBefore: "2027-03-14T11:00:00.000Z" });
  });

  it("an event counts when it overlaps the window", () => {
    const w: TimeWindow = { endsAfter: "2026-11-04T22:00:00Z", startsBefore: "2026-11-05T09:00:00Z" };
    expect(inWindow({ startsAt: "2026-11-04T23:00:00Z" }, w)).toBe(true);
    expect(inWindow({ startsAt: "2026-11-04T20:00:00Z", endsAt: "2026-11-04T23:00:00Z" }, w)).toBe(true); // already on
    expect(inWindow({ startsAt: "2026-11-04T19:00:00Z", endsAt: "2026-11-04T21:00:00Z" }, w)).toBe(false); // over before
    expect(inWindow({ startsAt: "2026-11-05T09:00:00Z" }, w)).toBe(false); // starts at the end
  });
});

describe("15 min away and the single widening", () => {
  it("the box holds the whole 15-minute circle", () => {
    const c = { lat: 39.9686, lng: -83.0037 };
    const b = boundsAround(c, AREA_METERS);
    expect(distanceMeters(c, { lat: b.north, lng: c.lng })).toBeGreaterThanOrEqual(AREA_METERS - 1);
    expect(distanceMeters(c, { lat: c.lat, lng: b.east })).toBeGreaterThanOrEqual(AREA_METERS - 1);
    expect(AREA_METERS).toBe(1200);
  });

  it("one expansion, most specific first", () => {
    expect(intentWidening("now", true, "food")).toEqual({ label: "Try tonight", action: "when" });
    expect(intentWidening("tonight", false, null)).toEqual({ label: "Try this weekend", action: "when" });
    expect(intentWidening("weekend", false, null)).toEqual({ label: "Show any time", action: "when" });
    expect(intentWidening("any", true, "food")).toEqual({ label: "Show the whole map", action: "area" });
    expect(intentWidening("any", false, "food")).toEqual({ label: "Any activity", action: "activity" });
    expect(intentWidening("any", false, null)).toBeNull();
  });

  it("the cutoff is the later of the upcoming rule and the window start", () => {
    const now = at("2026-11-04T15:00:00Z");
    expect(eventCutoffMs(false, null, now)).toBe(now - UPCOMING_GRACE_MS);
    expect(eventCutoffMs(false, "2026-11-04T22:00:00Z", now)).toBe(at("2026-11-04T22:00:00Z"));
    expect(eventCutoffMs(false, "2026-11-01T00:00:00Z", now)).toBe(now - UPCOMING_GRACE_MS); // never reopens ended events
    expect(eventCutoffMs(true, null, now)).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Real routes against the demo repository.
// ----------------------------------------------------------------------------
const ctx: { repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = (() => {
  const store = createIsolatedStore();
  return { repo: createDemoRepository(store), store };
})();
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => null }));
vi.mock("@/lib/data", async (orig) => ({ ...(await orig<object>()), getRepository: async () => ctx.repo }));
vi.mock("@/server/analytics", () => ({ track: async () => {} }));
const { GET: eventsRoute } = await import("../src/app/api/discover/events/route");
const { GET: mapRoute } = await import("../src/app/api/discover/map/route");

describe("routes honour a When window", () => {
  beforeEach(() => {
    ctx.store = createIsolatedStore();
    ctx.repo = createDemoRepository(ctx.store);
  });
  const windowAround = (iso: string): TimeWindow => ({ endsAfter: new Date(Date.parse(iso) - 60_000).toISOString(), startsBefore: new Date(Date.parse(iso) + 60_000).toISOString() });
  const qs = (w: TimeWindow, extra = "") => `endsAfter=${encodeURIComponent(w.endsAfter)}&startsBefore=${encodeURIComponent(w.startsBefore)}${extra}`;

  it("events and event pins inside the window only; places are not asked for", async () => {
    const target = ctx.store.state.events.filter((e) => e.status === "published" && Date.parse(e.startsAt) > Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    const w = windowAround(target.startsAt);
    const page = await (await eventsRoute(new Request(`http://x/api/discover/events?${qs(w)}`))).json();
    expect(page.items.map((e: { id: string }) => e.id)).toContain(target.id);
    for (const e of page.items as { startsAt: string; endsAt: string | null }[]) expect(inWindow(e, w)).toBe(true);
    const map = await (await mapRoute(new Request(`http://x/api/discover/map?kind=events&${qs(w)}`))).json();
    expect(map.places).toBeNull();
    expect(map.events.items.map((e: { id: string }) => e.id)).toContain(target.id);
    expect(map.events.items.length).toBe(page.items.length);
  });

  it("a window with nothing in it is empty (and an invalid timestamp is a 400)", async () => {
    const empty: TimeWindow = { endsAfter: "2099-01-01T00:00:00Z", startsBefore: "2099-01-01T01:00:00Z" };
    expect((await (await eventsRoute(new Request(`http://x/api/discover/events?${qs(empty)}`))).json()).items).toEqual([]);
    expect((await mapRoute(new Request("http://x/api/discover/map?endsAfter=tomorrow"))).status).toBe(400);
  });

  it("without a window, nothing changes", async () => {
    const plain = await (await mapRoute(new Request("http://x/api/discover/map"))).json();
    expect(plain.events.items.length).toBe((await ctx.repo.events.mapMarkers({})).items.length);
    expect(plain.places).not.toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Parity: the demo twin and public.discover_events agree on a When window.
// ----------------------------------------------------------------------------
describe("demo and SQL agree on When windows", () => {
  let db: PGlite;
  const store = createIsolatedStore();
  const demo = createDemoRepository(store);
  beforeAll(async () => {
    db = await createSeededDb();
    await alignDbWithDemo(db, store);
  });
  afterAll(async () => db?.close());

  const sqlIds = async (viewer: string | null, w: TimeWindow) => {
    const endsAfter = new Date(eventCutoffMs(false, w.endsAfter)!).toISOString();
    const args = { ...discoverArgs(normalizeFilters({})), p_ends_after: endsAfter, p_starts_before: w.startsBefore };
    const names = Object.keys(args);
    const casts: Record<string, string> = { p_north: "float8", p_south: "float8", p_east: "float8", p_west: "float8", p_text: "text", p_text_categories: "text[]", p_text_tags: "text[]", p_category: "text", p_tags: "text[]", p_neighborhood: "text", p_created_after: "timestamptz", p_ends_after: "timestamptz", p_starts_before: "timestamptz" };
    const from = `public.discover_events(${names.map((n, i) => `${n} => $${i + 1}::${casts[n]}`).join(", ")})`;
    const rows = await queryAs<{ id: string }>(db, viewer, `select id from ${from} order by starts_at, id`, names.map((n) => (args as Record<string, unknown>)[n]));
    return rows.map((r) => r.id);
  };

  it("now, tonight and this weekend, for an anonymous and a signed-in viewer", async () => {
    const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
    for (const tab of ["now", "tonight", "weekend"] as const) {
      const w = whenWindow(tab, Date.now(), NY)!;
      for (const viewer of [null, maya]) {
        const page = await demo.events.search({ viewerId: viewer, endsAfter: w.endsAfter, startsBefore: w.startsBefore, limit: 100 });
        expect(page.items.map((e) => e.id), `${tab} / ${viewer ?? "anon"}`).toEqual(await sqlIds(viewer, w));
      }
    }
  });

  it("a window around each upcoming event", async () => {
    const visible = (await demo.events.search({ limit: 100 })).items.filter((x) => Date.parse(x.startsAt) > Date.now());
    expect(visible.length).toBeGreaterThan(0);
    for (const e of visible.slice(0, 5)) {
      const w = { endsAfter: e.startsAt, startsBefore: new Date(Date.parse(e.startsAt) + 1000).toISOString() };
      const page = await demo.events.search({ endsAfter: w.endsAfter, startsBefore: w.startsBefore, limit: 100 });
      expect(page.items.map((x) => x.id)).toEqual(await sqlIds(null, w));
      expect(page.items.map((x) => x.id)).toContain(e.id);
    }
  });
});
