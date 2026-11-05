/**
 * Session 9 discovery performance work (0013_discovery_performance.sql) must
 * not change what anyone sees:
 *   * the places and events policies, rewritten to read the row itself, give
 *     the same answer as can_view_place / can_view_event for every row and viewer;
 *   * the definer-rights text helpers return exactly the visible matches;
 *   * the trigram indexes can serve every searched column;
 *   * "Nearest" pages identically through SQL and the demo repository.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { discoverArgs } from "../src/lib/data/supabase/repository";
import { DataError } from "../src/lib/data/types";
import {
  decodeDistanceCursor,
  discoveryDistance,
  encodeDistanceCursor,
  normalizeFilters,
} from "../src/lib/data/discovery";
import type { DiscoveryFilters } from "../src/lib/data/types";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const VIEWERS: (string | null)[] = [null, ...SEED_USERS.map((u) => u.id)];
const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;

let db: PGlite;
beforeAll(async () => {
  db = await createSeededDb();
  // A removed place, a hidden one, a private one and a cancelled event, so the
  // equivalence covers every branch of the rules.
  await db.query("update public.places set status = 'removed' where id = $1", [stableId("place:The Lumen Rooftop")]);
  await db.query("update public.places set status = 'hidden' where id = $1", [stableId("place:Cannon & Crown")]);
  await db.query("update public.places set visibility = 'private' where id = $1", [stableId("place:Little Alley Dumpling")]);
  await db.query("update public.events set status = 'cancelled' where id = $1", [stableId("event:Ridgeline sunrise hike")]);
});

describe("row policies match the visibility functions", () => {
  it("places: the policy and can_view_place agree for every row and viewer", async () => {
    for (const viewer of VIEWERS) {
      const viaPolicy = (await queryAs<{ id: string }>(db, viewer, "select id from public.places order by id")).map((r) => r.id);
      // can_view_place has definer rights, so evaluate it over every row, not just the ones RLS lets through.
      const viaFunction = (await db.query<{ id: string }>(
        `select id from public.places p
         where (select public.can_view_place(p.id) from (select set_config('request.jwt.claim.sub', $1, true)) s)
         order by id`, [viewer ?? ""])).rows.map((r) => r.id);
      expect([viewer, viaPolicy]).toEqual([viewer, viaFunction]);
    }
  });

  it("events: the policy and can_view_event agree for every row and viewer", async () => {
    for (const viewer of VIEWERS) {
      const viaPolicy = (await queryAs<{ id: string }>(db, viewer, "select id from public.events order by id")).map((r) => r.id);
      const viaFunction = (await db.query<{ id: string }>(
        `select id from public.events e
         where (select public.can_view_event(e.id) from (select set_config('request.jwt.claim.sub', $1, true)) s)
         order by id`, [viewer ?? ""])).rows.map((r) => r.id);
      expect([viewer, viaPolicy]).toEqual([viewer, viaFunction]);
    }
  });
});

describe("text helpers", () => {
  const TEXTS = ["game", "a", "dumpling", "sunrise", "%", "zzz-nothing", "lumen"];

  it("return exactly the visible rows the old row-by-row match found", async () => {
    for (const viewer of VIEWERS) {
      for (const text of TEXTS) {
        const f = normalizeFilters({ text });
        const args = discoverArgs(f);
        const helper = (await queryAs<{ id: string }>(db, viewer, "select public.discover_place_text_ids($1, $2::text[], $3::text[]) as id order by 1", [args.p_text, args.p_text_categories, args.p_text_tags])).map((r) => r.id);
        // The pre-0013 predicate, evaluated under RLS row by row.
        const naive = (await queryAs<{ id: string }>(db, viewer,
          `select p.id from public.places p where
             p.name ilike public.discover_like_pattern($1) or p.description ilike public.discover_like_pattern($1)
             or p.local_tip ilike public.discover_like_pattern($1) or p.neighborhood ilike public.discover_like_pattern($1)
             or p.category_slug = any ($2::text[])
             or exists (select 1 from public.place_tags t where t.place_id = p.id and t.interest_slug = any ($3::text[]))
           order by 1`, [args.p_text, args.p_text_categories, args.p_text_tags])).map((r) => r.id);
        expect([viewer, text, helper]).toEqual([viewer, text, naive]);

        const eventHelper = (await queryAs<{ id: string }>(db, viewer, "select public.discover_event_text_ids($1, $2::text[], $3::text[]) as id order by 1", [args.p_text, args.p_text_categories, args.p_text_tags])).map((r) => r.id);
        const eventNaive = (await queryAs<{ id: string }>(db, viewer,
          `select e.id from public.events e where
             e.title ilike public.discover_like_pattern($1) or e.description ilike public.discover_like_pattern($1)
             or e.location_name ilike public.discover_like_pattern($1) or e.category_slug = any ($2::text[])
             or exists (select 1 from public.event_tags t where t.event_id = e.id and t.interest_slug = any ($3::text[]))
           order by 1`, [args.p_text, args.p_text_categories, args.p_text_tags])).map((r) => r.id);
        expect([viewer, text, eventHelper]).toEqual([viewer, text, eventNaive]);
      }
    }
  });

  it("never return a locals-only place to a non-local, even when called directly", async () => {
    const ridgeline = stableId("place:Ridgeline Loop");
    const rows = await queryAs<{ id: string }>(db, user("nina"), "select public.discover_place_text_ids('Ridgeline', '{}', '{}') as id");
    expect(rows.map((r) => r.id)).not.toContain(ridgeline);
    const anon = await queryAs<{ id: string }>(db, null, "select public.discover_place_text_ids('Ridgeline', '{}', '{}') as id");
    expect(anon.map((r) => r.id)).not.toContain(ridgeline);
  });

  it("can use a trigram index for every searched column", async () => {
    const columns: [string, string, string][] = [
      ["places", "name", "places_name_trgm_idx"],
      ["places", "description", "places_description_trgm_idx"],
      ["places", "local_tip", "places_local_tip_trgm_idx"],
      ["places", "neighborhood", "places_neighborhood_trgm_idx"],
      ["events", "title", "events_title_trgm_idx"],
      ["events", "description", "events_description_trgm_idx"],
      ["events", "location_name", "events_location_trgm_idx"],
    ];
    await db.exec("set enable_seqscan = off");
    try {
      for (const [table, column, index] of columns) {
        const plan = (await db.query<{ "QUERY PLAN": string }>(`explain select id from public.${table} where ${column} ilike '%zephyr%'`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        expect([column, plan]).toEqual([column, expect.stringContaining(index)]);
      }
    } finally {
      await db.exec("reset enable_seqscan");
    }
  });
});

describe("Nearest", () => {
  const ORIGIN = { lat: 39.9612, lng: -82.9988 };

  it("measures distance the same way in SQL and JavaScript", async () => {
    const points = [
      { lat: 39.9612, lng: -82.9988 },
      { lat: 40.0325, lng: -83.0231 },
      { lat: 39.9, lng: -83.1 },
      { lat: -33.86, lng: 151.21 },
      { lat: 10, lng: 179.9 },
    ];
    for (const p of points) {
      const { rows } = await db.query<{ d: number }>("select public.distance_m($1, $2, $3, $4) as d", [p.lat, p.lng, ORIGIN.lat, ORIGIN.lng]);
      expect([p, discoveryDistance(p, ORIGIN)]).toEqual([p, rows[0].d]);
    }
    // Across the antimeridian the short way round is used.
    expect(discoveryDistance({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })).toBeLessThan(25_000);
  });

  it("pages the same places in the same order through SQL and the demo repository, for every viewer", async () => {
    // The demo store gets the same status changes as the database.
    const handle = createIsolatedStore();
    handle.state.places.find((p) => p.id === stableId("place:The Lumen Rooftop"))!.status = "removed";
    handle.state.places.find((p) => p.id === stableId("place:Cannon & Crown"))!.status = "hidden";
    handle.state.places.find((p) => p.id === stableId("place:Little Alley Dumpling"))!.visibility = "private";
    const repo = createDemoRepository(handle);

    const sqlPage = async (viewer: string | null, filters: DiscoveryFilters, limit: number, cursor: string | null) => {
      const after = decodeDistanceCursor(cursor);
      const args = discoverArgs(normalizeFilters(filters));
      const casts: Record<string, string> = {
        p_north: "float8", p_south: "float8", p_east: "float8", p_west: "float8", p_text: "text", p_text_categories: "text[]",
        p_text_tags: "text[]", p_category: "text", p_tags: "text[]", p_neighborhood: "text", p_created_after: "timestamptz",
      };
      const names = Object.keys(args) as (keyof typeof args)[];
      const params = [ORIGIN.lat, ORIGIN.lng, after?.distance ?? null, after?.id ?? null, ...names.map((n) => args[n])];
      const rows = await queryAs<{ id: string; distance_m: number }>(db, viewer,
        `select id, distance_m from public.discover_places_nearest(p_lat => $1, p_lng => $2, p_after_distance => $3::float8, p_after_id => $4::uuid,
           ${names.map((n, i) => `${n} => $${i + 5}::${casts[n]}`).join(", ")}) order by distance_m, id limit ${limit + 1}`, params);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((r) => r.id), nextCursor: rows.length > limit && last ? encodeDistanceCursor(last.distance_m, last.id) : null };
    };
    const walk = async (page: (cursor: string | null) => Promise<{ items: string[]; nextCursor: string | null }>) => {
      const all: string[] = [];
      for (let cursor: string | null = null, n = 0; n < 50; n++) {
        const p = await page(cursor);
        all.push(...p.items);
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      return all;
    };
    const FILTERS: DiscoveryFilters[] = [{}, { text: "game" }, { category: "food" }, { tags: ["coffee", "hiking"] }, { bounds: { north: 40.0, south: 39.94, east: -82.95, west: -83.03 } }];
    for (const viewer of [null, user("nina"), user("jules"), user("dev")]) {
      for (const filters of FILTERS) {
        const fromSql = await walk((c) => sqlPage(viewer, filters, 4, c));
        const fromDemo = await walk((c) =>
          repo.places.search({ ...filters, near: ORIGIN, viewerId: viewer, limit: 4, cursor: c }).then((p) => ({ items: p.items.map((x) => x.id), nextCursor: p.nextCursor })));
        expect([viewer, filters, fromDemo]).toEqual([viewer, filters, fromSql]);
        const distances = fromDemo.map((id) => discoveryDistance(handle.state.places.find((p) => p.id === id)!, ORIGIN));
        expect([...distances].sort((a, b) => a - b)).toEqual(distances);
      }
    }
  });

  it("rejects a bad point or a cursor from the other order", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    await expect(repo.places.search({ near: { lat: 91, lng: 0 } })).rejects.toBeInstanceOf(DataError);
    const newest = await repo.places.search({ limit: 1 });
    await expect(repo.places.search({ near: ORIGIN, cursor: newest.nextCursor })).rejects.toThrow(/Invalid page cursor/);
    const nearest = await repo.places.search({ near: ORIGIN, limit: 1 });
    await expect(repo.places.search({ cursor: nearest.nextCursor })).rejects.toThrow(/Invalid page cursor/);
  });
});
