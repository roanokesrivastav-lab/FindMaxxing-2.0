/**
 * Roadmap 6.1: the walking router (docs/features/6.0.md §3) and the route-validation limit (0095).
 *
 * No network: the Mapbox client is driven by a stubbed fetch, and a spy on the global fetch fails
 * the suite if anything tries a real call. The limiter runs on the real 0040/0095 SQL in PGlite and
 * on its demo twin; two-connection races are in tests/abuse-limits-pg.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { abuseRows, pgliteRpc } from "./helpers/abuseRpc";

const h = vi.hoisted(() => ({ rpc: null as null | ((name: string, args?: Record<string, unknown>) => Promise<unknown>), adminThrows: false }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    if (h.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return { rpc: (name: string, args?: Record<string, unknown>) => h.rpc!(name, args) };
  },
}));
vi.mock("server-only", () => ({}));

const {
  COLUMBUS_FIXTURES, REQUEST_TIMEOUT_MS, VALIDATION_TIMEOUT_MS, createFakeRouter, createGraphhopperFootRouter, createMapboxWalkingRouter,
  createUnconfiguredRouter, describeRouter, resolveWalkingRouter, routeForValidation, routeLegs, withRequestMemo,
} = await import("../src/server/trips/routing");
const { limitRouteValidation, abuseHash } = await import("../src/server/limiters");
const { validate } = await import("../src/lib/trips/feasibility");
const { getDemoStore } = await import("../src/lib/data/demo/store");
import type { FakeRouteFixtures, LatLng, LegResult, WalkingRouter } from "../src/server/trips/routing";
import { DataError } from "../src/lib/data/types";

const live = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("a real network call was attempted"); });
afterEach(() => { expect(live).not.toHaveBeenCalled(); vi.unstubAllEnvs(); });

const signal = () => new AbortController().signal;
/** The same distance the fake uses, written out again here so the expected numbers are not the fake's own. */
function meters(a: LatLng, b: LatLng): number {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(x));
}
const minutes = (m: number) => Math.ceil((m * 1.3) / 80);

// A straight river running north to south, two bridges, and an island in mid-stream.
const RIVER = -83.01;
const north = { lat: 39.97, lng: RIVER };
const south = { lat: 39.95, lng: RIVER };
const island = { lat: 39.96, lng: RIVER };
const fixtures: FakeRouteFixtures = {
  barriers: [{ line: [{ lat: 39.99, lng: RIVER }, { lat: 39.93, lng: RIVER }], bridges: [north, south] }],
  noRoute: [{ center: island, radiusMeters: 50 }],
};
const west = { lat: 39.966, lng: -83.015 };
const westToo = { lat: 39.958, lng: -83.016 };
const east = { lat: 39.966, lng: -83.005 };
const fake = createFakeRouter(fixtures);

describe("the deterministic fake", () => {
  it("walks the great-circle distance times 1.3 at 80 m a minute, rounded up to whole minutes", async () => {
    const [leg] = await fake.legs([west, westToo], { signal: signal() });
    const m = meters(west, westToo);
    expect(leg).toEqual({ status: "ok", seconds: minutes(m) * 60, meters: Math.round(m * 1.3) });
    expect(minutes(m)).toBeGreaterThan((m * 1.3) / 80); // it did round up
    // One metre is one minute, not zero.
    const step = await fake.legs([west, { lat: west.lat + 0.00001, lng: west.lng }], { signal: signal() });
    expect(step[0]).toMatchObject({ status: "ok", seconds: 60 });
    expect(await fake.legs([west, west], { signal: signal() })).toEqual([{ status: "ok", seconds: 0, meters: 0 }]);
  });

  it("does not walk across the river: the leg goes by the bridge that makes it shortest", async () => {
    const [leg] = await fake.legs([west, east], { signal: signal() });
    const straight = meters(west, east);
    const byNorth = meters(west, north) + meters(north, east);
    const bySouth = meters(west, south) + meters(south, east);
    expect(byNorth).toBeLessThan(bySouth);
    expect(leg).toEqual({ status: "ok", seconds: minutes(byNorth) * 60, meters: Math.round(byNorth * 1.3) });
    expect(minutes(byNorth)).toBeGreaterThan(minutes(straight) + 2);
    // Staying on one bank is the plain distance.
    const [same] = await fake.legs([west, westToo], { signal: signal() });
    expect(same).toMatchObject({ seconds: minutes(meters(west, westToo)) * 60 });
  });

  it("a river with no bridge cannot be crossed, and an island cannot be reached", async () => {
    const noBridge = createFakeRouter({ barriers: [{ line: fixtures.barriers[0].line, bridges: [] }], noRoute: [] });
    expect(await noBridge.legs([west, east], { signal: signal() })).toEqual([{ status: "unknown", reason: "no_route" }]);
    const legs = await fake.legs([west, island, westToo, west], { signal: signal() });
    expect(legs.map((l) => l.status)).toEqual(["unknown", "unknown", "ok"]);
    expect(legs[0]).toEqual({ status: "unknown", reason: "no_route" });
  });

  it("answers one leg per pair, nothing for a single point, and unknown for coordinates that are not coordinates", async () => {
    expect(await fake.legs([west], { signal: signal() })).toEqual([]);
    expect(await fake.legs([], { signal: signal() })).toEqual([]);
    expect(await fake.legs([west, westToo, west, westToo], { signal: signal() })).toHaveLength(3);
    expect(await fake.legs([west, { lat: Number.NaN, lng: 0 }], { signal: signal() })).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(await fake.legs([west, { lat: 120, lng: 0 }], { signal: signal() })).toEqual([{ status: "unknown", reason: "provider_error" }]);
  });

  it("is the same every time, and is labelled an estimate", async () => {
    const points = [west, east, westToo, island, west];
    expect(await fake.legs(points, { signal: signal() })).toEqual(await createFakeRouter(fixtures).legs(points, { signal: signal() }));
    expect(fake.id).toBe("fake");
    expect(describeRouter("fake")).toEqual({ measured: false, label: "Walking times are estimates for this demo, not measured routes." });
    expect(describeRouter("mapbox-walking").measured).toBe(true);
  });

  it("the demo fixtures put the Scioto between the west bank and downtown", async () => {
    const demo = createFakeRouter();
    const cosi = { lat: 39.9596, lng: -83.0101 };
    const statehouse = { lat: 39.9612, lng: -82.9988 };
    const [across] = await demo.legs([cosi, statehouse], { signal: signal() });
    expect(across.status).toBe("ok");
    expect((across as { seconds: number }).seconds).toBeGreaterThanOrEqual(minutes(meters(cosi, statehouse)) * 60);
    expect(await demo.legs([cosi, COLUMBUS_FIXTURES.noRoute[0].center], { signal: signal() })).toEqual([{ status: "unknown", reason: "no_route" }]);
  });
});

describe("the fake's legs through the 6.2 validator", () => {
  const plan = (legs: LegResult[], second: LatLng) =>
    validate({
      timeZone: "America/New_York",
      window: { startLocal: "2026-11-14T17:30", endLocal: "2026-11-14T22:00" },
      startPoint: west,
      stops: [{ id: "bar", point: west, durationMin: 5 }, { id: "dinner", point: second, durationMin: 60, fixedStart: "2026-11-14T23:00:00.000Z" }],
      legs,
    });

  it("a straight line across the river would make the 6 PM table; the walk by the bridge does not", async () => {
    const routed = await routeLegs(fake, [west, west, east]);
    const m = meters(west, east);
    const straightLine: LegResult[] = [{ status: "ok", seconds: 0, meters: 0 }, { status: "ok", seconds: minutes(m) * 60, meters: Math.round(m * 1.3) }];
    expect(plan(straightLine, east).status).toBe("feasible");
    expect(plan(routed, east)).toMatchObject({ status: "infeasible", failing: { kind: "fixed_start_missed", stopId: "dinner" } });
  });

  it("a stop on the island leaves the plan uncertain", async () => {
    expect(plan(await routeLegs(fake, [west, west, island]), island)).toMatchObject({ status: "uncertain", stopId: "dinner", reason: { kind: "leg_unknown", leg: "no_route" } });
  });
});

describe("the Mapbox walking client, on stubbed answers only", () => {
  const answer = (body: unknown, status = 200) =>
    vi.fn(async (url: string, init: { signal: AbortSignal }) => ({ ok: status >= 200 && status < 300 && !!url && !!init, status, json: async () => body }));
  const two = [west, westToo, east];
  const good = { code: "Ok", uuid: "abc", waypoints: [{ name: "High St", location: [-83, 39.9] }], routes: [{ duration: 1500, distance: 1900, geometry: "u{~vFvyys@fS]", weight_name: "pedestrian", legs: [
    { duration: 612.4, distance: 801.6, summary: "High St", steps: [{ geometry: "abc", maneuver: {} }], annotation: { duration: [1, 2] } },
    { duration: 887.6, distance: 1098.4, summary: "Broad St", steps: [] },
  ] }] };

  it("asks for walking, in longitude,latitude order, with no geometry and no steps", async () => {
    const fetch = answer(good);
    await createMapboxWalkingRouter({ token: "sk.test token", fetch }).legs(two, { signal: signal() });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/directions/v5/mapbox/walking/-83.015000,39.966000;-83.016000,39.958000;-83.005000,39.966000");
    expect(Object.fromEntries(url.searchParams)).toEqual({ alternatives: "false", overview: "false", steps: "false", access_token: "sk.test token" });
  });

  it("returns two numbers per leg and nothing else from the answer", async () => {
    const legs = await createMapboxWalkingRouter({ token: "t", fetch: answer(good) }).legs(two, { signal: signal() });
    expect(legs).toEqual([{ status: "ok", seconds: 612, meters: 802 }, { status: "ok", seconds: 888, meters: 1098 }]);
    expect(JSON.stringify(legs)).not.toMatch(/geometry|steps|summary|annotation|waypoints|uuid|High St/);
  });

  it.each([
    ["HTTP 500", answer({ message: "boom" }, 500), "provider_error"],
    ["HTTP 401", answer({ message: "Not Authorized" }, 401), "provider_error"],
    ["HTTP 422", answer({ code: "InvalidInput" }, 422), "no_route"],
    ["code NoRoute", answer({ code: "NoRoute", routes: [] }), "no_route"],
    ["code NoSegment", answer({ code: "NoSegment" }), "no_route"],
    ["no routes", answer({ code: "Ok", routes: [] }), "provider_error"],
    ["a different number of legs", answer({ code: "Ok", routes: [{ legs: [{ duration: 1, distance: 1 }] }] }), "provider_error"],
    ["not an object", answer("<html>"), "provider_error"],
    ["null", answer(null), "provider_error"],
    ["an unknown code", answer({ code: "ProfileNotFound", routes: [{ legs: [{}, {}] }] }), "provider_error"],
  ] as const)("%s becomes unknown (%s), never a walk", async (_name, fetch, reason) => {
    expect(await createMapboxWalkingRouter({ token: "t", fetch }).legs(two, { signal: signal() })).toEqual([{ status: "unknown", reason }, { status: "unknown", reason }]);
  });

  it("a leg whose numbers are not sane is unknown on its own", async () => {
    const bad = (duration: unknown, distance: unknown) => answer({ code: "Ok", routes: [{ legs: [{ duration, distance }, { duration: 300, distance: 400 }] }] });
    for (const [d, m] of [["612", 800], [-5, 800], [Number.NaN, 800], [612, null], [10_000_000, 800], [612, 9_000_000]] as const) {
      const legs = await createMapboxWalkingRouter({ token: "t", fetch: bad(d, m) }).legs(two, { signal: signal() });
      expect(legs).toEqual([{ status: "unknown", reason: "provider_error" }, { status: "ok", seconds: 300, meters: 400 }]);
    }
  });

  it("an aborted request is a timeout; any other failure to fetch or parse is a provider error", async () => {
    const aborted = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const garbled = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
    const router = (fetch: Parameters<typeof createMapboxWalkingRouter>[0]["fetch"]) => createMapboxWalkingRouter({ token: "t", fetch }).legs([west, east], { signal: signal() });
    expect(await router(aborted)).toEqual([{ status: "unknown", reason: "timeout" }]);
    expect(await router(down)).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(await router(garbled)).toEqual([{ status: "unknown", reason: "provider_error" }]);
  });

  it("without a token it is not configured and asks nothing", async () => {
    const fetch = answer(good);
    expect(await createMapboxWalkingRouter({ token: "", fetch }).legs(two, { signal: signal() })).toEqual([{ status: "unknown", reason: "not_configured" }, { status: "unknown", reason: "not_configured" }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a long plan is asked in pieces of at most 25 points, each leg once and in order", async () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ lat: 39.9 + i * 0.001, lng: -83 }));
    let n = 0;
    const fetch = vi.fn(async (url: string) => {
      const count = new URL(url).pathname.split("/").pop()!.split(";").length - 1;
      return { ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ legs: Array.from({ length: count }, () => ({ duration: ++n, distance: n })) }] }) };
    });
    const legs = await createMapboxWalkingRouter({ token: "t", fetch }).legs(points, { signal: signal() });
    expect(fetch.mock.calls.map(([url]) => new URL(url as string).pathname.split("/").pop()!.split(";").length)).toEqual([25, 6]);
    expect(legs.map((l) => (l as { seconds: number }).seconds)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
  });
});

describe("which router a deployment gets", () => {
  it("demo mode is always the fake, whatever is set", () => {
    expect(resolveWalkingRouter({ WALKING_ROUTER: "mapbox-walking", MAPBOX_WALKING_TOKEN: "sk.x" }, "demo").id).toBe("fake");
    expect(resolveWalkingRouter({}, "demo").id).toBe("fake");
  });

  it("Supabase mode with nothing set, or half set, is not configured: every leg unknown, none estimated", async () => {
    for (const env of [{}, { WALKING_ROUTER: "mapbox-walking" }, { MAPBOX_WALKING_TOKEN: "sk.x" }, { NEXT_PUBLIC_MAPBOX_TOKEN: "pk.public", WALKING_ROUTER: "mapbox-walking" }, { WALKING_ROUTER: "fake" }, { WALKING_ROUTER: "graphhopper-foot" }]) {
      const router = resolveWalkingRouter(env, "supabase");
      expect(router.id).not.toBe("fake");
      expect(await routeLegs(router, [west, east, westToo])).toEqual([{ status: "unknown", reason: "not_configured" }, { status: "unknown", reason: "not_configured" }]);
    }
  });

  it("only the router name and its own server-side token together select the provider", () => {
    expect(resolveWalkingRouter({ WALKING_ROUTER: "mapbox-walking", MAPBOX_WALKING_TOKEN: "sk.x" }, "supabase").id).toBe("mapbox-walking");
    expect(createGraphhopperFootRouter().id).toBe("graphhopper-foot");
    expect(createUnconfiguredRouter().id).toBe("mapbox-walking");
  });

  it("the timeouts are 6.0's: 4 seconds a request, 8 a validation", () => {
    expect([REQUEST_TIMEOUT_MS, VALIDATION_TIMEOUT_MS]).toEqual([4000, 8000]);
  });
});

describe("one bounded call (routeLegs)", () => {
  const router = (legs: WalkingRouter["legs"]): WalkingRouter => ({ id: "mapbox-walking", legs });

  it("a router that hangs is cut off and every leg is a timeout", async () => {
    const started = Date.now();
    const hung = router(() => new Promise(() => {}));
    expect(await routeLegs(hung, [west, east, westToo], { timeoutMs: 40 })).toEqual([{ status: "unknown", reason: "timeout" }, { status: "unknown", reason: "timeout" }]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("a caller's deadline that has already passed asks nothing", async () => {
    const legs = vi.fn(async () => []);
    const gone = AbortSignal.abort();
    expect(await routeLegs(router(legs), [west, east], { signal: gone })).toEqual([{ status: "unknown", reason: "timeout" }]);
    expect(legs).not.toHaveBeenCalled();
  });

  it("a router that throws, or answers with the wrong shape, never reaches the caller as a walk", async () => {
    expect(await routeLegs(router(async () => { throw new Error("boom"); }), [west, east])).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(await routeLegs(router(async () => []), [west, east])).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(await routeLegs(router(async () => "nope" as unknown as LegResult[]), [west, east])).toEqual([{ status: "unknown", reason: "provider_error" }]);
    const odd = [{ status: "ok", seconds: "300", meters: 1 }, null, { status: "unknown", reason: "aliens" }, { status: "ok", seconds: 60, meters: 80, geometry: "abc", raw: { a: 1 } }] as unknown as LegResult[];
    expect(await routeLegs(router(async () => odd), [west, east, westToo, west, east])).toEqual([
      { status: "unknown", reason: "provider_error" }, { status: "unknown", reason: "provider_error" }, { status: "unknown", reason: "provider_error" }, { status: "ok", seconds: 60, meters: 80 },
    ]);
  });

  it("fewer than two points is no legs and no call", async () => {
    const legs = vi.fn(async () => []);
    expect(await routeLegs(router(legs), [west])).toEqual([]);
    expect(legs).not.toHaveBeenCalled();
  });
});

describe("the memo lives for one request", () => {
  const counting = () => {
    const inner = createFakeRouter(fixtures);
    const legs = vi.fn(inner.legs);
    return { router: { id: inner.id, legs } as WalkingRouter, legs };
  };

  it("the same legs are asked once within a request", async () => {
    const { router, legs } = counting();
    const memo = withRequestMemo(router);
    const first = await memo.legs([west, east, westToo], { signal: signal() });
    expect(await memo.legs([west, east, westToo], { signal: signal() })).toEqual(first);
    expect(await memo.legs([west, east], { signal: signal() })).toEqual([first[0]]);
    expect(legs).toHaveBeenCalledTimes(1);
    await memo.legs([west, westToo], { signal: signal() });
    expect(legs).toHaveBeenCalledTimes(2);
  });

  it("a failed answer is remembered for the request too, so a failing provider is not asked twice", async () => {
    const legs = vi.fn(async () => { throw new Error("down"); });
    const memo = withRequestMemo({ id: "mapbox-walking", legs });
    expect(await memo.legs([west, east], { signal: signal() })).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(await memo.legs([west, east], { signal: signal() })).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(legs).toHaveBeenCalledTimes(1);
  });

  it("the next request starts with nothing remembered", async () => {
    const { router, legs } = counting();
    await withRequestMemo(router).legs([west, east], { signal: signal() });
    await withRequestMemo(router).legs([west, east], { signal: signal() });
    expect(legs).toHaveBeenCalledTimes(2);
  });

  it("nothing in the routing code keeps state between requests, writes anywhere, or logs", () => {
    const dir = path.join(__dirname, "../src/server/trips/routing");
    for (const file of readdirSync(dir)) {
      const code = readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/^(export )?(const|let|var) \w+ = new (Map|Set|WeakMap|Array)\b/m);
      expect(code, file).not.toMatch(/console\.|getRepository|getDemoStore|@\/lib\/supabase|createSupabase|writeFile|localStorage|unstable_cache|from "react"/);
    }
  });
});

describe("route validation for a signed-in user: budget first", () => {
  const user = "00000000-0000-4000-8000-0000000000b7";
  const spyRouter = () => {
    const inner = createFakeRouter(fixtures);
    const legs = vi.fn(inner.legs);
    return { router: { id: inner.id, legs } as WalkingRouter, legs };
  };

  it("over the limit: refused with the wait, and no router is asked", async () => {
    const { router, legs } = spyRouter();
    const limit = vi.fn(async () => 1260);
    await expect(routeForValidation(user, [[west, east]], { limit, router })).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/Too many plan checks\. Try again in /) });
    expect(limit).toHaveBeenCalledWith(user);
    expect(legs).not.toHaveBeenCalled();
  });

  it("limiter unreachable: fails closed, and no router is asked", async () => {
    const { router, legs } = spyRouter();
    const limit = vi.fn(async () => { throw new DataError("Request protection is unavailable. Try again later.", "unavailable"); });
    await expect(routeForValidation(user, [[west, east]], { limit, router })).rejects.toMatchObject({ code: "unavailable" });
    expect(legs).not.toHaveBeenCalled();
  });

  it("no user: refused before the limiter or a router", async () => {
    const { router, legs } = spyRouter();
    const limit = vi.fn(async () => 0);
    await expect(routeForValidation("", [[west, east]], { limit, router })).rejects.toMatchObject({ code: "forbidden" });
    expect(limit).not.toHaveBeenCalled();
    expect(legs).not.toHaveBeenCalled();
  });

  it("admitted: one reservation, taken before any routing, and one memo for the whole validation", async () => {
    const order: string[] = [];
    const inner = createFakeRouter(fixtures);
    const router: WalkingRouter = { id: "fake", legs: vi.fn(async (p, o) => { order.push("route"); return inner.legs(p, o); }) };
    const limit = vi.fn(async () => { order.push("limit"); return 0; });
    const result = await routeForValidation(user, [[west, east, westToo], [west, east, westToo], [west, east]], { limit, router });
    expect(order).toEqual(["limit", "route"]);
    expect(result.router).toBe("fake");
    expect(result.legs[0]).toEqual(result.legs[1]);
    expect(result.legs[2]).toEqual([result.legs[0][0]]);
  });
});

describe("the route-validation limit (0095)", () => {
  const userA = "00000000-0000-4000-8000-0000000000a1";
  const userB = "00000000-0000-4000-8000-0000000000a2";
  const SECRET = "test-abuse-secret-at-least-32-characters-long";

  describe("on the real SQL, called as the service role", () => {
    let db: PGlite;
    beforeAll(async () => { db = await createSeededDb(); });
    afterAll(async () => { await db.close(); });
    beforeEach(async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
      vi.stubEnv("ABUSE_HMAC_SECRET", SECRET);
      await db.exec("delete from public.server_abuse_counters;");
      h.rpc = pgliteRpc(db);
      h.adminThrows = false;
    });

    it("admits 60 an hour for a user, then says how long to wait; another user is unaffected", async () => {
      for (let i = 0; i < 60; i++) expect(await limitRouteValidation(userA)).toBe(0);
      const wait = await limitRouteValidation(userA);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(3600);
      expect(await limitRouteValidation(userB)).toBe(0);
      const rows = await abuseRows(db);
      expect(rows.map((r) => [r.action, r.count]).sort()).toEqual([["route_validation", 1], ["route_validation", 60]]);
    });

    it("stores an HMAC of the user id under the server's secret, never the id", async () => {
      await limitRouteValidation(userA);
      const [row] = await abuseRows(db);
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_hash).toBe(abuseHash("user", userA));
      expect(JSON.stringify(row)).not.toContain(userA);
      vi.stubEnv("ABUSE_HMAC_SECRET", "another-secret-of-at-least-32-characters!");
      expect(abuseHash("user", userA)).not.toBe(row.key_hash);
    });

    it("fails closed: no service client, a database error, no secret or no user all refuse, and reserve nothing", async () => {
      h.adminThrows = true;
      await expect(limitRouteValidation(userA)).rejects.toMatchObject({ code: "unavailable" });
      h.adminThrows = false;
      h.rpc = async () => ({ data: null, error: { message: "connection reset" } });
      await expect(limitRouteValidation(userA)).rejects.toMatchObject({ code: "unavailable" });
      h.rpc = async () => { throw new Error("socket hang up"); };
      await expect(limitRouteValidation(userA)).rejects.toMatchObject({ code: "unavailable" });
      h.rpc = pgliteRpc(db);
      vi.stubEnv("ABUSE_HMAC_SECRET", "");
      await expect(limitRouteValidation(userA)).rejects.toMatchObject({ code: "unavailable" });
      vi.stubEnv("ABUSE_HMAC_SECRET", SECRET);
      await expect(limitRouteValidation("")).rejects.toMatchObject({ code: "unavailable" });
      expect(await abuseRows(db)).toEqual([]);
    });

    it("a denied or failed limiter means the provider is never asked, end to end", async () => {
      const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ legs: [{ duration: 300, distance: 400 }] }] }) }));
      const router = createMapboxWalkingRouter({ token: "sk.test", fetch });
      await db.exec(`insert into public.server_abuse_counters(action, key_hash, window_start, expires_at, count)
        select 'route_validation', '${abuseHash("user", userA)}', to_timestamp(floor(extract(epoch from now()) / 3600) * 3600), now() + interval '1 hour', 59`);
      // The last one in the budget goes through and reaches the (stubbed) provider once.
      expect((await routeForValidation(userA, [[west, east]], { limit: limitRouteValidation, router })).legs).toEqual([[{ status: "ok", seconds: 300, meters: 400 }]]);
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(routeForValidation(userA, [[west, east]], { limit: limitRouteValidation, router })).rejects.toMatchObject({ code: "rate_limited" });
      h.adminThrows = true;
      await expect(routeForValidation(userB, [[west, east]], { limit: limitRouteValidation, router })).rejects.toMatchObject({ code: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("on the demo twin", () => {
    it("same cap and isolation, with the fake router and no network", async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
      const store = getDemoStore();
      store.state.abuseCounters = store.state.abuseCounters.filter((c) => c.action !== "route_validation");
      const demoUser = "00000000-0000-4000-8000-0000000000d1";
      for (let i = 0; i < 60; i++) expect(await limitRouteValidation(demoUser)).toBe(0);
      expect(await limitRouteValidation(demoUser)).toBeGreaterThan(0);
      expect(await limitRouteValidation("00000000-0000-4000-8000-0000000000d2")).toBe(0);
      const mine = store.state.abuseCounters.filter((c) => c.action === "route_validation");
      expect(mine.map((c) => c.count).sort((a, b) => a - b)).toEqual([1, 60]);
      expect(JSON.stringify(mine)).not.toContain(demoUser);
      await expect(routeForValidation(demoUser, [[west, east]], { limit: limitRouteValidation, router: resolveWalkingRouter({}, "demo") })).rejects.toMatchObject({ code: "rate_limited" });
      store.state.abuseCounters = store.state.abuseCounters.filter((c) => c.action !== "route_validation");
    });
  });
});
