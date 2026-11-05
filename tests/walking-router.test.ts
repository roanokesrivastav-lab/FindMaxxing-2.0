import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LatLng } from "@/lib/itinerary/types";
import { validateItinerary, type ValidateInput } from "@/lib/itinerary/validate";
import { afterRevalidation, storedVerdict } from "@/lib/itinerary/verdict";
import {
  DETOUR_FACTOR,
  FIXTURE_ISLAND,
  crossesFixtureRiver,
  fakeLeg,
  fakeWalkingRouter,
  haversineMeters,
} from "@/server/trips/routing/fake";
import { graphHopperFootRouter } from "@/server/trips/routing/graphhopper";
import { MAPBOX_DIRECTIONS_BASE, mapboxWalkingUrl, parseMapboxWalking } from "@/server/trips/routing/mapbox";
import {
  PLAN_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createRequestMemo,
  routeLegs,
  selectWalkingRouter,
  withRequestTimeout,
  type WalkingRouter,
} from "@/server/trips/routing/router";

/**
 * 6.1 routing adapter. No test may reach a network: fetch is spied for the whole file and must never be
 * called, so the Mapbox client is provably never invoked (only its pure URL builder and response parser
 * are exercised). No keys are set anywhere.
 */
const fetchSpy = vi.fn(async () => {
  throw new Error("no network in tests");
});
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  globalThis.fetch = realFetch;
});
afterEach(() => vi.useRealTimers());

const signal = () => new AbortController().signal;
const CENTER: LatLng = { lat: 39.9686, lng: -83.0037 };
const NEARBY: LatLng = { lat: 39.975, lng: -82.995 };
const WEST_BANK: LatLng = { lat: 39.95, lng: -83.012 };
const EAST_BANK: LatLng = { lat: 39.95, lng: -82.998 };

describe("fake router contract", () => {
  it("haversine x 1.3 at 80 m/min, rounded up to whole minutes", async () => {
    const legs = await fakeWalkingRouter.legs([CENTER, NEARBY, CENTER], { signal: signal() });
    const meters = Math.round(haversineMeters(CENTER, NEARBY) * DETOUR_FACTOR);
    expect(meters).toBe(1336);
    expect(legs).toEqual([
      { status: "ok", seconds: 17 * 60, meters }, // 1336 / 80 = 16.7, up to 17
      { status: "ok", seconds: 17 * 60, meters },
    ]);
    expect(fakeWalkingRouter.id).toBe("fake");
    expect(await fakeWalkingRouter.legs([CENTER], { signal: signal() })).toEqual([]);
  });

  it("a straight line across the fixture river detours over the nearest bridge", () => {
    expect(crossesFixtureRiver(WEST_BANK, EAST_BANK)).toBe(true);
    expect(crossesFixtureRiver(CENTER, NEARBY)).toBe(false);
    const straight = haversineMeters(WEST_BANK, EAST_BANK);
    expect(Math.round(straight)).toBe(1193);
    expect(fakeLeg(WEST_BANK, EAST_BANK)).toEqual({ status: "ok", seconds: 50 * 60, meters: 3980 });
  });

  it("the fixture island has no route, either way", () => {
    expect(fakeLeg(CENTER, FIXTURE_ISLAND.center)).toEqual({ status: "unknown", reason: "no_route" });
    expect(fakeLeg(FIXTURE_ISLAND.center, CENTER)).toEqual({ status: "unknown", reason: "no_route" });
  });

  it("is deterministic", async () => {
    const points = [CENTER, WEST_BANK, EAST_BANK, NEARBY];
    expect(await fakeWalkingRouter.legs(points, { signal: signal() })).toEqual(await fakeWalkingRouter.legs(points, { signal: signal() }));
  });
});

describe("required cases end to end: router legs into the 6.2 validator", () => {
  const SIX_PM = "2026-11-07T18:00:00-05:00";
  const base = (legsFor: LatLng[]): Omit<ValidateInput, "legs"> => ({
    timeZone: "America/New_York",
    window: { startLocal: "2026-11-07T17:30", endLocal: "2026-11-07T23:00" },
    startPoint: legsFor[0],
    stops: legsFor.slice(1).map((point, i) => ({ id: `s${i}`, point, durationMin: 60, ...(i === 0 ? { fixedStart: SIX_PM } : {}) })),
  });

  it("a straight-line shortcut across the river: the old estimate says it fits, the router's detour says no", async () => {
    const points = [WEST_BANK, EAST_BANK];
    // The current planner's straight-line estimate (src/server/trips/tools.ts): metres / 80 + 1.
    const straightMin = Math.round(haversineMeters(WEST_BANK, EAST_BANK) / 80) + 1;
    const straight = validateItinerary({ ...base(points), maxWalkMin: { perLeg: 60, total: 90 }, legs: [{ status: "ok", seconds: straightMin * 60, meters: 0 }] });
    expect(straight.status).toBe("feasible");
    const legs = await routeLegs(fakeWalkingRouter, points);
    // With a 60-minute leg allowance, the 50-minute detour reaches the 6 p.m. reservation at 6:20.
    expect(validateItinerary({ ...base(points), maxWalkMin: { perLeg: 60, total: 90 }, legs })).toMatchObject({
      status: "infeasible", failing: { code: "fixed_start_missed", stopId: "s0", lateByMin: 25 },
    });
    // With the default 30-minute leg limit (R-4), the leg itself is over.
    expect(validateItinerary({ ...base(points), legs })).toMatchObject({ status: "infeasible", failing: { code: "leg_over_max", walkMin: 50 } });
  });

  it("an unreachable stop is uncertain", async () => {
    const points = [CENTER, FIXTURE_ISLAND.center];
    const legs = await routeLegs(fakeWalkingRouter, points);
    expect(validateItinerary({ ...base(points), window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" }, legs })).toMatchObject({ status: "uncertain", stopId: "s0" });
  });

  it("provider timeout: every leg times out at 8 s, the plan is uncertain, and the last valid plan is kept", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const hanging: WalkingRouter = {
      id: "mapbox-walking",
      legs: (_points, { signal }) => new Promise(() => signal.addEventListener("abort", () => { sawAbort = true; })),
    };
    const points = [CENTER, NEARBY];
    const pending = routeLegs(hanging, points);
    await vi.advanceTimersByTimeAsync(PLAN_TIMEOUT_MS - 1);
    expect(sawAbort).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const legs = await pending;
    expect(sawAbort).toBe(true);
    expect(legs).toEqual([{ status: "unknown", reason: "timeout" }]);

    const input = { ...base(points), window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" } };
    const meta = { validatedAt: "2026-11-07T15:00:00.000Z", router: "fake" as const };
    const saved = { plan: { version: 3 }, verdict: storedVerdict(validateItinerary({ ...input, legs: await routeLegs(fakeWalkingRouter, points) }), meta) };
    expect(saved.verdict.status).toBe("feasible");
    const fresh = validateItinerary({ ...input, legs });
    expect(fresh.status).toBe("uncertain");
    expect(afterRevalidation(saved, fresh, { validatedAt: "2026-11-07T16:00:00.000Z", router: "mapbox-walking" })).toEqual({ plan: saved.plan, verdict: saved.verdict, possiblyOutdated: true });
  });
});

describe("routeLegs never throws", () => {
  it("a throwing router gives provider_error; a malformed answer too", async () => {
    const throwing: WalkingRouter = { id: "mapbox-walking", legs: async () => { throw new Error("boom"); } };
    const syncThrowing: WalkingRouter = { id: "mapbox-walking", legs: () => { throw new Error("boom"); } };
    const wrongCount: WalkingRouter = { id: "mapbox-walking", legs: async () => [] };
    const negative: WalkingRouter = { id: "mapbox-walking", legs: async () => [{ status: "ok", seconds: -1, meters: 5 }] };
    for (const router of [throwing, syncThrowing, wrongCount, negative]) {
      expect(await routeLegs(router, [CENTER, NEARBY])).toEqual([{ status: "unknown", reason: "provider_error" }]);
    }
  });

  it("a cancelled validation gives timeouts; no points gives no legs", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await routeLegs(fakeWalkingRouter, [CENTER, NEARBY, CENTER], { signal: controller.signal })).toEqual([
      { status: "unknown", reason: "timeout" }, { status: "unknown", reason: "timeout" },
    ]);
    expect(await routeLegs(fakeWalkingRouter, [CENTER])).toEqual([]);
  });

  it("the per-request timeout is 4 s and the plan budget 8 s", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(4_000);
    expect(PLAN_TIMEOUT_MS).toBe(8_000);
    vi.useFakeTimers();
    let aborted: string | undefined;
    const pending = withRequestTimeout(signal(), REQUEST_TIMEOUT_MS, (s) => new Promise<string>((_, reject) => {
      s.addEventListener("abort", () => { aborted = (s.reason as Error).name; reject(s.reason); });
    }));
    const settled = pending.catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await settled).toBe("TimeoutError");
    expect(aborted).toBe("TimeoutError");
  });
});

describe("per-request memo (R-2)", () => {
  it("repeats no identical leg within one request, and does not persist across requests", async () => {
    const calls: number[] = [];
    const counting: WalkingRouter = { id: "fake", legs: async (points, opts) => { calls.push(points.length); return fakeWalkingRouter.legs(points, opts); } };
    const first = createRequestMemo(counting);
    const a = await first.legs([CENTER, NEARBY, WEST_BANK], { signal: signal() });
    expect(await first.legs([CENTER, NEARBY, WEST_BANK], { signal: signal() })).toEqual(a);
    expect(await first.legs([NEARBY, WEST_BANK], { signal: signal() })).toEqual([a[1]]);
    expect(calls).toEqual([3]);
    const second = createRequestMemo(counting); // the next request starts empty
    await second.legs([CENTER, NEARBY, WEST_BANK], { signal: signal() });
    expect(calls).toEqual([3, 3]);
  });
});

describe("which router runs (R-1): the fake until keys, never a live provider in tests", () => {
  const pilot = { NEXT_PUBLIC_FEATURES: "pilot" };
  it("no key: the fake in demo mode, all legs not_configured in Supabase mode", async () => {
    expect(selectWalkingRouter(pilot, "demo")).toBe(fakeWalkingRouter);
    const supabase = selectWalkingRouter(pilot, "supabase");
    expect(supabase.id).toBe("mapbox-walking");
    const legs = await routeLegs(supabase, [CENTER, NEARBY, CENTER]);
    expect(legs).toEqual([{ status: "unknown", reason: "not_configured" }, { status: "unknown", reason: "not_configured" }]);
    // Nothing claims "fits" on a not-configured router.
    expect(validateItinerary({
      timeZone: "America/New_York", window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" }, startPoint: CENTER,
      stops: [{ id: "a", point: NEARBY, durationMin: 30 }, { id: "b", point: CENTER, durationMin: 30 }], legs,
    }).status).toBe("uncertain");
  });

  it("the test process has no routing keys, and its default selection is the fake", () => {
    expect(process.env.MAPBOX_ROUTING_TOKEN).toBeUndefined();
    expect(process.env.GRAPHHOPPER_URL).toBeUndefined();
    expect(selectWalkingRouter().id).toBe("fake");
  });

  it("a key alone is not enough: the pilotItinerary flag must be on too (and \"all\" does not turn it on)", async () => {
    for (const env of [{ MAPBOX_ROUTING_TOKEN: "pk.test" }, { NEXT_PUBLIC_FEATURES: "all", MAPBOX_ROUTING_TOKEN: "pk.test" }]) {
      expect(selectWalkingRouter(env, "demo")).toBe(fakeWalkingRouter);
      expect(await routeLegs(selectWalkingRouter(env, "supabase"), [CENTER, NEARBY])).toEqual([{ status: "unknown", reason: "not_configured" }]);
    }
  });

  it("with the flag and a key the Mapbox client is constructed but not called here", () => {
    const router = selectWalkingRouter({ ...pilot, MAPBOX_ROUTING_TOKEN: "pk.test" }, "supabase");
    expect(router.id).toBe("mapbox-walking");
    expect(router).not.toBe(fakeWalkingRouter);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GraphHopper foot is the named fallback, a stub that is never 'fits'", async () => {
    expect(selectWalkingRouter({ ...pilot, WALKING_ROUTER: "graphhopper-foot", GRAPHHOPPER_URL: "http://gh.invalid" }, "supabase")).toBe(graphHopperFootRouter);
    expect(selectWalkingRouter({ ...pilot, WALKING_ROUTER: "graphhopper-foot" }, "supabase").id).toBe("graphhopper-foot");
    expect(await routeLegs(graphHopperFootRouter, [CENTER, NEARBY])).toEqual([{ status: "unknown", reason: "not_configured" }]);
  });
});

describe("Mapbox client pieces that need no network", () => {
  it("requests walking only, durations and distances only: no steps, no geometry", () => {
    const url = new URL(mapboxWalkingUrl([CENTER, NEARBY], "pk.test"));
    expect(url.href.startsWith(MAPBOX_DIRECTIONS_BASE)).toBe(true);
    expect(url.pathname).toBe("/directions/v5/mapbox/walking/-83.003700,39.968600;-82.995000,39.975000");
    expect(Object.fromEntries(url.searchParams)).toEqual({ alternatives: "false", overview: "false", steps: "false", access_token: "pk.test" });
  });

  it("parses legs and maps failures to unknowns", () => {
    expect(parseMapboxWalking({ code: "Ok", routes: [{ legs: [{ duration: 612.4, distance: 801.2, steps: [] }] }] }, 1)).toEqual([{ status: "ok", seconds: 612.4, meters: 801.2 }]);
    expect(parseMapboxWalking({ code: "NoRoute" }, 2)).toEqual([{ status: "unknown", reason: "no_route" }, { status: "unknown", reason: "no_route" }]);
    expect(parseMapboxWalking({ code: "InvalidInput" }, 1)).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(parseMapboxWalking({ code: "Ok", routes: [{ legs: [] }] }, 1)).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(parseMapboxWalking({ code: "Ok", routes: [{ legs: [{ duration: "x", distance: 1 }] }] }, 1)).toEqual([{ status: "unknown", reason: "provider_error" }]);
    expect(parseMapboxWalking(null, 1)).toEqual([{ status: "unknown", reason: "provider_error" }]);
  });
});

describe("nothing persists provider results (R-2)", () => {
  it("routing modules have no write path: no repository, demo store, Supabase, logging or module-level cache", () => {
    const dir = path.join(process.cwd(), "src/server/trips/routing");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.sort()).toEqual(["adapter.ts", "fake.ts", "graphhopper.ts", "mapbox.ts", "router.ts"]);
    for (const file of files) {
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/@\/lib\/data|supabase|demo\/store|repository|console\.|logError|reportError|localStorage|writeFile/);
      // The only Map lives inside createRequestMemo (per call), never at module scope.
      for (const line of src.split("\n").filter((l) => /new Map\(/.test(l))) expect(line, file).toMatch(/^\s{4,}/);
    }
  });

  it("the stored verdict from a Mapbox-routed validation carries no provider durations or distances", () => {
    const legs = parseMapboxWalking({ code: "Ok", routes: [{ legs: [{ duration: 612.4, distance: 801.2 }] }] }, 1);
    const result = validateItinerary({
      timeZone: "America/New_York", window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" }, startPoint: CENTER,
      stops: [{ id: "a", point: NEARBY, durationMin: 30 }], legs,
    });
    expect(result.status).toBe("feasible");
    const stored = JSON.stringify(storedVerdict(result, { validatedAt: "2026-11-07T15:00:00.000Z", router: "mapbox-walking" }));
    expect(stored).not.toMatch(/612|801|seconds|meters|walkMin|geometry/);
  });
});
