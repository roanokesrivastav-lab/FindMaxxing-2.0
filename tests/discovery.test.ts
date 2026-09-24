/**
 * Discovery queries: the SQL functions (through the same argument builder the
 * Supabase repository sends to PostgREST) and the demo repository must return
 * the same records, in the same order, in the same pages, for every viewer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { discoverArgs, upcomingCutoff } from "../src/lib/data/supabase/repository";
import {
  DEFAULT_MAP_MARKERS,
  DEFAULT_PAGE_SIZE,
  MAX_MAP_MARKERS,
  MAX_PAGE_SIZE,
  clampLimit,
  compareTimestamps,
  decodeCursor,
  encodeCursor,
  expandSearchText,
  inBounds,
  isValidTimestamp,
  normalizeFilters,
  toPage,
} from "../src/lib/data/discovery";
import type { DataRepository } from "../src/lib/data/repository";
import type { DiscoveryFilters, EventSearchOptions, MapQueryOptions, Page, PlaceSearchOptions } from "../src/lib/data/types";
import { SEED_PLACES, SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const VIEWERS: [string, string | null][] = [
  ["anonymous", null],
  ["nina (visitor)", user("nina")],
  ["jules (local)", user("jules")],
  ["maya", user("maya_r")],
];
const ridgeline = stableId("place:Ridgeline Loop");
const ridgelineEvent = stableId("event:Ridgeline sunrise hike");

// A box around the densest part of the seed data, so bounds actually cut.
const anchor = SEED_PLACES[0];
const BOX = { north: anchor.lat + 0.02, south: anchor.lat - 0.02, east: anchor.lng + 0.02, west: anchor.lng - 0.02 };

const FILTERS: [string, DiscoveryFilters][] = [
  ["no filters", {}],
  ["taxonomy keyword 'hoops'", { text: "hoops" }],
  ["interest keyword 'wifi'", { text: "wifi" }],
  ["own text 'dumpling'", { text: "dumpling" }],
  ["mixed case '  SUNRISE '", { text: "  SUNRISE " }],
  // Each term appears in exactly one searchable field, so dropping that field
  // from either implementation changes the result.
  ["place neighborhood only 'franklinton'", { text: "franklinton" }],
  ["place local tip only 'kickoff'", { text: "kickoff" }],
  ["event location only 'trailhead'", { text: "trailhead" }],
  ["event description only 'cleats'", { text: "cleats" }],
  ["category", { category: "pickup-sports" }],
  ["any-of tags", { tags: ["hiking", "coffee"] }],
  ["bounds", { bounds: BOX }],
  ["bounds + text", { bounds: BOX, text: "game" }],
  ["category + tags", { category: "food", tags: ["studying", "food"] }],
  ["literal %", { text: "%" }],
  ["literal _", { text: "_" }],
  ["no match", { text: "zzz-nothing" }],
];

// ----------------------------------------------------------------------------
// SQL side: call the functions with named arguments, exactly as PostgREST does,
// then order/limit around them the way the Supabase repository asks it to.
// ----------------------------------------------------------------------------
const CASTS: Record<string, string> = {
  p_north: "float8", p_south: "float8", p_east: "float8", p_west: "float8",
  p_text: "text", p_text_categories: "text[]", p_text_tags: "text[]",
  p_category: "text", p_tags: "text[]",
  p_after_created_at: "timestamptz", p_after_id: "uuid",
  p_ends_after: "timestamptz", p_after_starts_at: "timestamptz",
};

function call(fn: string, args: Record<string, unknown>) {
  const names = Object.keys(args);
  return {
    from: `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${CASTS[n]}`).join(", ")})`,
    params: names.map((n) => args[n]),
  };
}

// PostgREST serializes timestamps with to_json: ISO 8601 with microseconds.
const ISO = (col: string) => `to_json(${col}) #>> '{}'`;

function sqlSide(db: PGlite) {
  return {
    async placePage(viewer: string | null, opts: PlaceSearchOptions): Promise<Page<string>> {
      const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const after = decodeCursor(opts.cursor);
      const { from, params } = call("discover_places", {
        ...discoverArgs(normalizeFilters(opts)), p_after_created_at: after?.key ?? null, p_after_id: after?.id ?? null,
      });
      const rows = await queryAs<{ id: string; key: string }>(db, viewer,
        `select id, ${ISO("created_at")} as key from ${from} order by created_at desc, id desc limit ${limit + 1}`, params);
      return toPage(rows, limit, (r) => r.id, (r) => ({ key: r.key, id: r.id }));
    },
    async eventPage(viewer: string | null, opts: EventSearchOptions): Promise<Page<string>> {
      const limit = clampLimit(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const after = decodeCursor(opts.cursor);
      const { from, params } = call("discover_events", {
        ...discoverArgs(normalizeFilters(opts)), p_ends_after: upcomingCutoff(opts.includePast),
        p_after_starts_at: after?.key ?? null, p_after_id: after?.id ?? null,
      });
      const rows = await queryAs<{ id: string; key: string }>(db, viewer,
        `select id, ${ISO("starts_at")} as key from ${from} order by starts_at, id limit ${limit + 1}`, params);
      return toPage(rows, limit, (r) => r.id, (r) => ({ key: r.key, id: r.id }));
    },
    async placeMap(viewer: string | null, opts: MapQueryOptions) {
      const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
      const { from, params } = call("discover_places", discoverArgs(normalizeFilters(opts)));
      const rows = await queryAs<{ id: string }>(db, viewer,
        `select id from ${from} order by rating_count desc, save_count desc, id limit ${limit + 1}`, params);
      return { ids: rows.slice(0, limit).map((r) => r.id), truncated: rows.length > limit };
    },
    async eventMap(viewer: string | null, opts: MapQueryOptions) {
      const limit = clampLimit(opts.limit, DEFAULT_MAP_MARKERS, MAX_MAP_MARKERS);
      const { from, params } = call("discover_events", { ...discoverArgs(normalizeFilters(opts)), p_ends_after: upcomingCutoff(opts.includePast) });
      const rows = await queryAs<{ id: string }>(db, viewer, `select id from ${from} order by starts_at, id limit ${limit + 1}`, params);
      return { ids: rows.slice(0, limit).map((r) => r.id), truncated: rows.length > limit };
    },
  };
}

/** Follows nextCursor to the end; fails on repeats or runaway paging. */
async function walk(fetchPage: (cursor: string | null) => Promise<Page<string>>): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const page = await fetchPage(cursor);
    ids.push(...page.items);
    if (!page.nextCursor) {
      expect(new Set(ids).size, "no record appears on two pages").toBe(ids.length);
      return ids;
    }
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

let db: PGlite;
let sql: ReturnType<typeof sqlSide>;
let demo: DataRepository;

beforeAll(async () => {
  db = await createSeededDb();
  sql = sqlSide(db);
  demo = createDemoRepository(createIsolatedStore());
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("SQL pagination with timestamp ties", () => {
  // The SQL seed inserts every place in one transaction: all created_at equal.
  it("seeds places with identical created_at, so only the id tie-break orders them", async () => {
    const { rows } = await db.query<{ n: number }>("select count(distinct created_at)::int as n from public.places");
    expect(rows[0].n).toBe(1);
  });

  it("walks every page without gaps or repeats", async () => {
    const all = await sql.placePage(null, { limit: 100 });
    expect(all.nextCursor).toBeNull();
    const walked = await walk((cursor) => sql.placePage(null, { limit: 3, cursor }));
    expect(walked).toEqual(all.items);
  });
});

describe("SQL and demo agree", () => {
  beforeAll(async () => {
    // Give SQL the demo store's timestamps so ordering can be compared exactly.
    const state = createIsolatedStore().state;
    demo = createDemoRepository({ state, persist() {} });
    await db.exec("alter table public.events disable trigger guard_owner_event_change;");
    for (const p of state.places) await db.query("update public.places set created_at = $2 where id = $1", [p.id, p.createdAt]);
    for (const e of state.events) await db.query("update public.events set starts_at = $2, ends_at = $3 where id = $1", [e.id, e.startsAt, e.endsAt]);
    await db.exec("alter table public.events enable trigger guard_owner_event_change;");
  });

  const demoPlaces = (viewerId: string | null, opts: PlaceSearchOptions) =>
    demo.places.search({ ...opts, viewerId }).then((p) => ({ items: p.items.map((x) => x.id), nextCursor: p.nextCursor }));
  const demoEvents = (viewerId: string | null, opts: EventSearchOptions) =>
    demo.events.search({ ...opts, viewerId }).then((p) => ({ items: p.items.map((x) => x.id), nextCursor: p.nextCursor }));

  describe.each(VIEWERS)("as %s", (_label, viewer) => {
    it.each(FILTERS)("places: %s", async (_name, filters) => {
      const complete = await demoPlaces(viewer, { ...filters, limit: MAX_PAGE_SIZE });
      expect(complete.nextCursor).toBeNull();
      const sqlWalk = await walk((cursor) => sql.placePage(viewer, { ...filters, limit: 4, cursor }));
      const demoWalk = await walk((cursor) => demoPlaces(viewer, { ...filters, limit: 4, cursor }));
      expect(sqlWalk).toEqual(complete.items);
      expect(demoWalk).toEqual(complete.items);

      const sqlMap = await sql.placeMap(viewer, filters);
      const demoMap = await demo.places.mapMarkers({ ...filters, viewerId: viewer });
      expect(sqlMap.ids).toEqual(demoMap.items.map((m) => m.id));
      expect(new Set(sqlMap.ids)).toEqual(new Set(complete.items));
    });

    it.each(FILTERS)("events: %s", async (_name, filters) => {
      for (const includePast of [false, true]) {
        const complete = await demoEvents(viewer, { ...filters, includePast, limit: MAX_PAGE_SIZE });
        const sqlWalk = await walk((cursor) => sql.eventPage(viewer, { ...filters, includePast, limit: 3, cursor }));
        const demoWalk = await walk((cursor) => demoEvents(viewer, { ...filters, includePast, limit: 3, cursor }));
        expect(sqlWalk).toEqual(complete.items);
        expect(demoWalk).toEqual(complete.items);
        const sqlMap = await sql.eventMap(viewer, { ...filters, includePast });
        const demoMap = await demo.events.mapMarkers({ ...filters, includePast, viewerId: viewer });
        expect(sqlMap.ids).toEqual(demoMap.items.map((m) => m.id));
      }
    });
  });

  it("filters are meaningful: they narrow without emptying", async () => {
    const total = (await demoPlaces(null, { limit: MAX_PAGE_SIZE })).items.length;
    for (const [name, filters] of FILTERS.filter(([n]) => !/no filters|literal|no match/.test(n))) {
      const n = (await demoPlaces(user("jules"), { ...filters, limit: MAX_PAGE_SIZE })).items.length;
      const e = (await demoEvents(user("jules"), { ...filters, includePast: true, limit: MAX_PAGE_SIZE })).items.length;
      expect(n + e, name).toBeGreaterThan(0);
      expect(n, name).toBeLessThan(total + 1);
    }
    expect((await demoPlaces(null, { text: "hoops", limit: MAX_PAGE_SIZE })).items.length).toBeLessThan(total);
  });

  it("covers the whole data set, not just the newest rows", async () => {
    // The oldest seeded place is last in list order; a text search still finds it.
    const oldest = SEED_PLACES[0];
    const found = await sql.placePage(null, { text: oldest.name, limit: 5 });
    expect(found.items).toContain(oldest.id);
  });

  it("applies locals-only visibility to search, map and linked events", async () => {
    const seen = async (viewer: string | null) => ({
      place: (await sql.placePage(viewer, { limit: MAX_PAGE_SIZE })).items.includes(ridgeline),
      map: (await sql.placeMap(viewer, {})).ids.includes(ridgeline),
      event: (await sql.eventPage(viewer, { includePast: true, limit: MAX_PAGE_SIZE })).items.includes(ridgelineEvent),
    });
    expect(await seen(null)).toEqual({ place: false, map: false, event: false });
    expect(await seen(user("nina"))).toEqual({ place: false, map: false, event: false });
    expect(await seen(user("jules"))).toEqual({ place: true, map: true, event: true });
  });

  it("caps map markers and flags truncation, most notable first", async () => {
    const sqlMap = await sql.placeMap(null, { limit: 3 });
    const demoMap = await demo.places.mapMarkers({ limit: 3 });
    expect(demoMap).toMatchObject({ truncated: true, limit: 3 });
    expect(sqlMap).toEqual({ ids: demoMap.items.map((m) => m.id), truncated: true });
    const counts = demoMap.items.map((m) => m.ratingCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect((await demo.places.mapMarkers({ text: "zzz-nothing" })).truncated).toBe(false);
  });

  it("excludes owner-hidden places from discovery, even for the owner", async () => {
    const lumen = stableId("place:The Lumen Rooftop");
    const owner = SEED_PLACES.find((p) => p.id === lumen)!.creator;
    await db.query("update public.places set status = 'hidden' where id = $1", [lumen]);
    expect((await sql.placePage(user(owner), { limit: MAX_PAGE_SIZE })).items).not.toContain(lumen);
    await db.query("update public.places set status = 'published' where id = $1", [lumen]);
  });
});

describe("cursor precision", () => {
  it("does not skip a row whose timestamp differs only in microseconds", async () => {
    const [a, b] = [stableId("place:Cannon & Crown"), stableId("place:Lantern Bowl")];
    await db.query("update public.places set created_at = '2099-01-01 00:00:00.000200+00' where id = $1", [a]);
    await db.query("update public.places set created_at = '2099-01-01 00:00:00.000100+00' where id = $1", [b]);
    const first = await sql.placePage(null, { limit: 1 });
    expect(first.items).toEqual([a]);
    // The cursor carries the sub-millisecond digits a JS Date would drop.
    const key = decodeCursor(first.nextCursor)!.key;
    expect(key).toMatch(/:00\.0002[+-]/);
    expect(compareTimestamps(key, "2099-01-01T00:00:00.0002Z")).toBe(0);
    const second = await sql.placePage(null, { limit: 1, cursor: first.nextCursor });
    expect(second.items).toEqual([b]);
  });

  it("compares timestamps below the millisecond", () => {
    expect(compareTimestamps("2099-01-01T00:00:00.0002+00:00", "2099-01-01T00:00:00.0001+00:00")).toBe(1);
    expect(compareTimestamps("2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00+00:00")).toBe(0);
    expect(compareTimestamps("2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000+01:00")).toBe(0);
    expect(compareTimestamps("2026-01-01T00:00:00.001Z", "2026-01-01T00:00:00.000999Z")).toBe(1);
  });
});

describe("contract edges", () => {
  it("clamps page and map sizes", async () => {
    expect((await demo.places.search({ limit: 5000 })).items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect((await demo.places.search({ limit: 0 })).items).toHaveLength(1);
    expect((await demo.places.mapMarkers({ limit: 1 })).limit).toBe(1);
    expect(clampLimit(undefined, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(Number.NaN, 7, 9)).toBe(7);
  });

  it("rejects malformed and tampered cursors", async () => {
    const bad = [
      "not-base64!!",
      Buffer.from("[1,2]").toString("base64url"),
      encodeCursor({ key: "2026-01-01T00:00:00Z'); drop table places; --", id: ridgeline }),
      encodeCursor({ key: "2026-01-01T00:00:00Z", id: "not-a-uuid" }),
      // Well-formed but not real instants: Postgres would reject these as
      // timestamptz arguments, so they must fail here as a 400, not a 500.
      encodeCursor({ key: "2026-99-99T00:00:00Z", id: ridgeline }),
      encodeCursor({ key: "2026-02-30T00:00:00Z", id: ridgeline }),
      encodeCursor({ key: "2026-02-29T00:00:00Z", id: ridgeline }),
      encodeCursor({ key: "2026-01-01T24:00:00Z", id: ridgeline }),
      encodeCursor({ key: "2026-01-01T00:00:00+16:00", id: ridgeline }),
    ];
    for (const cursor of bad) {
      await expect(demo.places.search({ cursor })).rejects.toThrow(/Invalid page cursor/);
      await expect(sql.placePage(null, { cursor })).rejects.toThrow(/Invalid page cursor/);
    }
  });

  it("accepts every real timestamp format a store returns, and nothing Postgres would refuse", async () => {
    for (const ok of ["2028-02-29T00:00:00Z", "2026-09-23T12:34:56.123456+00:00", "2026-09-23 12:34:56.1-08", "2026-12-31T23:59:59.999+05:30"]) {
      expect(isValidTimestamp(ok), ok).toBe(true);
      await expect(db.query("select $1::timestamptz", [ok])).resolves.toBeDefined();
    }
    for (const bad of ["2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-01T23:60:00Z"]) {
      expect(isValidTimestamp(bad), bad).toBe(false);
      await expect(db.query("select $1::timestamptz", [bad]), bad).rejects.toThrow();
    }
  });

  it("rejects impossible bounds", async () => {
    await expect(demo.places.search({ bounds: { north: 10, south: 20, east: 0, west: 0 } })).rejects.toThrow(/bounds/);
    await expect(demo.places.mapMarkers({ bounds: { north: 95, south: 0, east: 0, west: 0 } })).rejects.toThrow(/bounds/);
  });

  it("handles boxes that cross the antimeridian identically in SQL and TS", async () => {
    const box = { north: 10, south: -10, east: -170, west: 170 };
    for (const lng of [175, -175, 0, 170, -170, 169.9]) {
      const { rows } = await db.query<{ ok: boolean }>("select public.discover_in_bounds(0, $1, $2, $3, $4, $5) as ok", [lng, box.north, box.south, box.east, box.west]);
      expect(rows[0].ok, `lng ${lng}`).toBe(inBounds({ lat: 0, lng }, box));
    }
    expect(inBounds({ lat: 0, lng: 175 }, box)).toBe(true);
    expect(inBounds({ lat: 0, lng: 0 }, box)).toBe(false);
  });

  it("escapes LIKE wildcards in SQL", async () => {
    const { rows } = await db.query<{ p: string }>("select public.discover_like_pattern($1) as p", ["50%_off\\"]);
    expect(rows[0].p).toBe("%50\\%\\_off\\\\%");
    expect((await db.query<{ p: string | null }>("select public.discover_like_pattern('   ') as p")).rows[0].p).toBeNull();
  });

  it("expands search text through the taxonomy", () => {
    expect(expandSearchText("hoops").categories).toContain("pickup-sports");
    expect(expandSearchText("WIFI").tags).toContain("studying");
    expect(expandSearchText("   ")).toEqual({ text: null, categories: [], tags: [] });
    expect(expandSearchText("x".repeat(200)).text).toHaveLength(80);
  });
});
