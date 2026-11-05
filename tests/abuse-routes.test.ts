/**
 * Security batch 1, part 0.1a (F7 and the ad request cap): the real /api/geocode and /api/ads route
 * handlers in Supabase mode, limited by the real 0040 SQL (PGlite as service_role). Provider fetches
 * and ad selection are spies, so denial can be shown to make zero provider calls and bill nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { abuseRows, pgliteRpc, type RpcCall } from "./helpers/abuseRpc";

const h = vi.hoisted(() => ({
  ip: "203.0.113.20" as string | null,
  viewer: null as null | { id: string },
  rpc: null as null | ((name: string, args?: Record<string, unknown>) => Promise<unknown>),
  serve: vi.fn(), isPlus: vi.fn(), placeGet: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.ip ? { "x-real-ip": h.ip } : {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: (n: string, a?: Record<string, unknown>) => h.rpc!(n, a) }) }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => h.viewer }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ({ payments: { isPlus: h.isPlus }, places: { get: h.placeGet } }) }));
vi.mock("@/server/serviceRepository", () => ({ serviceRepository: async () => ({ ads: { serve: h.serve } }) }));

const { GET: geocode } = await import("../src/app/api/geocode/route");
const { GET: ads } = await import("../src/app/api/ads/route");

let db: PGlite;
let calls: RpcCall[];
const fetchSpy = vi.fn();
let q = 0;
const lookup = () => geocode(new Request(`http://x/api/geocode?q=${encodeURIComponent(`${++q} High Street Columbus`)}`));
const ad = () => ads(new Request("http://x/api/ads?slot=places"));

beforeAll(async () => { db = await createSeededDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("ABUSE_HMAC_SECRET", "test-abuse-secret-at-least-32-characters-long");
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
  vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
  vi.stubEnv("NEXT_PUBLIC_FEATURES", "ads");
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockImplementation(async () => new Response("[]", { status: 200 }));
  await db.exec("delete from public.server_abuse_counters; update public.geocode_provider_gate set next_at = '-infinity';");
  calls = [];
  h.rpc = pgliteRpc(db, calls);
  h.ip = "203.0.113.20";
  h.viewer = null;
  h.isPlus.mockResolvedValue(false);
  h.serve.mockResolvedValue({ campaignId: "c1", kind: "place", targetId: "p1", headline: "Tea", body: "" });
  h.placeGet.mockResolvedValue({ id: "p1", name: "Corner Tea", neighborhood: "Short North", city: "Columbus" });
});

describe("geocode", () => {
  it("request 31 within a minute from one IP is 429 with Retry-After and zero provider fetches (Mapbox path)", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.test-token");
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
    for (let i = 0; i < 30; i++) expect((await lookup()).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(30);
    fetchSpy.mockClear();
    const res = await lookup();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Mapbox is never gated by the Nominatim slot.
    expect(calls.some((c) => c.name === "claim_geocode_provider")).toBe(false);
    // Another IP is unaffected.
    h.ip = "198.51.100.3";
    expect((await lookup()).status).toBe(200);
  });

  it("Nominatim: concurrent lookups get at most one provider slot per 1.1 s; the rest are 503 with Retry-After, no queue", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => lookup()));
    expect(results.map((r) => r.status).sort()).toEqual([200, 503, 503, 503, 503, 503]);
    for (const r of results.filter((x) => x.status === 503)) expect(r.headers.get("retry-after")).toBe("2");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\//);
    await new Promise((r) => setTimeout(r, 1150));
    expect((await lookup()).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("D1: requests with no trusted IP share the generous geocode_unknown bucket", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.test-token");
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
    h.ip = null;
    for (let i = 0; i < 40; i++) expect((await lookup()).status).toBe(200);
    expect((await abuseRows(db)).map((r) => [r.action, r.count])).toEqual([["geocode_unknown", 40]]);
  });

  it("limiter unavailable → 503 and zero provider fetches; a failed slot claim → 503", async () => {
    h.rpc = async () => ({ data: null, error: { message: "down" } });
    const res = await lookup();
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    const real = pgliteRpc(db);
    h.rpc = async (name, args) => name === "claim_geocode_provider" ? { data: null, error: { message: "down" } } : real(name, args);
    expect((await lookup()).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.stubEnv("ABUSE_HMAC_SECRET", "");
    h.rpc = pgliteRpc(db);
    expect((await lookup()).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ads request cap", () => {
  it("request 121 within an hour from one IP gets { card: null } without selecting (so without billing)", async () => {
    let shown = 0;
    for (let i = 0; i < 125; i++) if ((await (await ad()).json()).card) shown++;
    expect(shown).toBe(120);
    expect(h.serve).toHaveBeenCalledTimes(120);
    h.ip = "198.51.100.40";
    expect((await (await ad()).json()).card).toMatchObject({ campaignId: "c1", title: "Corner Tea" });
  });

  it("limiter unavailable or HMAC secret missing → no card, never an error, never selected", async () => {
    h.rpc = async () => ({ data: null, error: { message: "down" } });
    const res = await ad();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ card: null });
    vi.stubEnv("ABUSE_HMAC_SECRET", "");
    h.rpc = pgliteRpc(db);
    expect(await (await ad()).json()).toEqual({ card: null });
    expect(h.serve).not.toHaveBeenCalled();
  });

  it("Plus members still see nothing and spend no limiter budget", async () => {
    h.viewer = { id: "plus-member" };
    h.isPlus.mockResolvedValue(true);
    expect(await (await ad()).json()).toEqual({ card: null });
    expect(calls).toEqual([]);
    expect(h.serve).not.toHaveBeenCalled();
  });
});
