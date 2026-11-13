/**
 * Security batch 1, part 0.1a: the 0040 limiter SQL (PGlite), its demo twin, the trusted client IP
 * policy (D1) and the production startup refusal. Two-connection races run against real PostgreSQL
 * in tests/abuse-limits-pg.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { abuseRows, pgliteRpc } from "./helpers/abuseRpc";
import { ABUSE_LIMITS, type AbuseAction, type AbuseKey } from "../src/lib/abuseLimits";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { claimDemoGeocode, consumeDemoAbuse, purgeDemoAbuse } from "../src/lib/data/demo/abuse";
import { abuseHash, createDurableLimiter } from "../src/server/limiters";
import { UNKNOWN_CLIENT, trustedClientIp } from "../src/server/http/clientIp";
import { trustedProxyRefusal } from "../src/lib/config";

const key = (n: number | string) => String(n).padStart(64, "0").replace(/[^0-9a-f]/g, "a");
const K = (action: AbuseAction, n: number | string): AbuseKey => ({ action, key: key(n) });
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0); // on a 15-min, hour and minute boundary

let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec("delete from public.server_abuse_counters;"); });

async function consume(keys: AbuseKey[], at: number): Promise<number> {
  const r = await db.query<{ r: number }>("select public.consume_server_abuse($1::jsonb, $2::timestamptz) as r", [JSON.stringify(keys), new Date(at).toISOString()]);
  return r.rows[0].r;
}

describe("policy table", () => {
  const policyRows = (file: string) => {
    const sql = readFileSync(path.join(__dirname, "../supabase/migrations", file), "utf8");
    return { sql, rows: Object.fromEntries([...sql.matchAll(/\('([a-z_]+)', (\d+), (\d+)\)/g)].map((m) => [m[1], { max: Number(m[2]), seconds: Number(m[3]) }])) };
  };

  it("SQL and ABUSE_LIMITS hold the same caps and windows (no beacon until 0.1b)", async () => {
    // The policy function is defined in 0040 and replaced in 0095 (6.1), which adds route_validation.
    const first = policyRows("0040_durable_abuse_limits.sql");
    const latest = policyRows("0095_route_validation_limit.sql");
    expect(latest.rows).toEqual(ABUSE_LIMITS);
    // 0095 keeps every earlier budget exactly as it was and adds one action.
    const { route_validation, ...earlier } = latest.rows;
    expect(earlier).toEqual(first.rows);
    expect(route_validation).toEqual({ max: 60, seconds: 3600 });
    // The effective policy, asked of the database itself once every migration has run.
    const keys = (Object.keys(ABUSE_LIMITS) as AbuseAction[]).map((action) => ({ action, key: key(1) }));
    const effective = await db.query<{ action: string; cap: number; seconds: number }>("select action, cap, seconds from public.server_abuse_budgets($1::jsonb, now())", [JSON.stringify(keys)]);
    expect(Object.fromEntries(effective.rows.map((r) => [r.action, { max: r.cap, seconds: r.seconds }]))).toEqual(ABUSE_LIMITS);
    for (const { sql } of [first, latest]) expect(sql.replace(/--.*$/gm, "")).not.toMatch(/beacon|ad_client_daily|record_ad_impression|serve_ad|ad_impressions/);
    // 0095 touches the policy function only: no table, grant or other function.
    expect(latest.sql.replace(/--.*$/gm, "")).not.toMatch(/create table|alter table|grant |drop |consume_server_abuse|security definer/i);
  });

  it("rejects unknown actions, malformed keys and oversized batches", async () => {
    await expect(consume([{ action: "beacon" as AbuseAction, key: key(1) }], T0)).rejects.toThrow(/Unknown limiter action/);
    await expect(consume([{ action: "ads", key: "203.0.113.1" }], T0)).rejects.toThrow(/Invalid limiter key/);
    await expect(consume([1, 2, 3, 4, 5].map((n) => K("ads", n)), T0)).rejects.toThrow(/Invalid limiter keys/);
    await expect(db.query("select public.consume_server_abuse('{}'::jsonb)")).rejects.toThrow(/Invalid limiter keys/);
  });
});

describe("window boundaries (injected p_now)", () => {
  it.each([
    ["signin_email", 5, 900], ["signin_ip", 20, 900], ["geocode", 30, 60], ["ads", 120, 3600],
  ] as const)("%s: cap %i, blocked to the last second, fresh at the first second of the next window", async (action, cap, seconds) => {
    for (let i = 0; i < cap; i++) expect(await consume([K(action, 1)], T0 + i)).toBe(0);
    expect(await consume([K(action, 1)], T0)).toBe(seconds);
    const last = T0 + (seconds - 1) * 1000;
    expect(await consume([K(action, 1)], last)).toBe(1);
    expect(await consume([K(action, 1)], last + 999)).toBe(1);
    expect(await consume([K(action, 1)], T0 + seconds * 1000)).toBe(0);
    expect((await abuseRows(db)).find((r) => r.action === action)!.count).toBe(1);
  });

  it("a burst straddling a boundary admits at most cap per window", async () => {
    let admitted = 0;
    for (let i = 0; i < 10; i++) if ((await consume([K("signin_email", 2)], T0 + 900_000 - 500)) === 0) admitted++;
    for (let i = 0; i < 10; i++) if ((await consume([K("signin_email", 2)], T0 + 900_000)) === 0) admitted++;
    expect(admitted).toBe(10);
  });
});

describe("out-of-order p_now (found by the real-Postgres race test)", () => {
  it("a stale-stamped request never moves a key back to an older window and resets its count", async () => {
    const before = T0 + 900_000 - 1, after = T0 + 900_000;
    let admitted = 0;
    for (let i = 0; i < 40; i++) if ((await consume([K("signin_email", 3)], i % 2 ? after : before)) === 0) admitted++;
    // One in the old window (the very first call), then the key sits in the new window: 5 more.
    expect(admitted).toBe(6);
    expect((await abuseRows(db)).map((r) => r.count)).toEqual([5]);
  });
});

describe("multi-key check-before-reserve", () => {
  it("an email at its cap does not spend the IP budget, and an IP at its cap does not spend the email budget", async () => {
    const ip = K("signin_ip", "1"), email = K("signin_email", "2");
    for (let i = 0; i < 5; i++) expect(await consume([ip, email], T0)).toBe(0);
    for (let i = 0; i < 10; i++) expect(await consume([ip, email], T0)).toBe(900);
    const counts = Object.fromEntries((await abuseRows(db)).map((r) => [r.action, r.count]));
    expect(counts).toEqual({ signin_ip: 5, signin_email: 5 });
    // Fill the IP with other emails; the blocked email budget stays where it was.
    for (let i = 0; i < 15; i++) expect(await consume([ip, K("signin_email", `e${i}`)], T0)).toBe(0);
    expect(await consume([ip, K("signin_email", "new")], T0)).toBe(900);
    expect((await abuseRows(db)).filter((r) => r.action === "signin_email" && r.key_hash === key("new"))).toEqual([]);
  });

  it("returns the longest wait among blocked keys", async () => {
    for (let i = 0; i < 30; i++) await consume([K("geocode", 1)], T0);
    for (let i = 0; i < 5; i++) await consume([K("signup_ip", 1)], T0);
    expect(await consume([K("geocode", 1), K("signup_ip", 1)], T0 + 10_000)).toBe(3590);
  });
});

describe("two separately constructed durable limiters share one budget", () => {
  it("alternating calls through two clients never exceed the cap", async () => {
    const a = createDurableLimiter(pgliteRpc(db));
    const b = createDurableLimiter(pgliteRpc(db));
    let admitted = 0;
    for (let i = 0; i < 200; i++) if ((await (i % 2 ? a : b)([K("ads", 7)])) === 0) admitted++;
    expect(admitted).toBe(120);
  });
});

describe("privileges and storage", () => {
  it("consume_server_abuse, claim_geocode_provider, purge_server_abuse and the tables are denied to anon and authenticated", async () => {
    const user = "00000000-0000-4000-8000-000000000001";
    for (const who of [null, user]) {
      await expect(queryAs(db, who, `select public.consume_server_abuse('[{"action":"ads","key":"${key(1)}"}]'::jsonb)`)).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, who, "select public.claim_geocode_provider()")).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, who, "select public.purge_server_abuse()")).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, who, "select public.server_abuse_budgets('[]'::jsonb, now())")).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, who, "select * from public.server_abuse_counters")).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, who, "update public.geocode_provider_gate set next_at = now()")).rejects.toThrow(/permission denied/);
    }
    const grants = (await db.query<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(`
      select p.oid::regprocedure::text fn, has_function_privilege('anon', p.oid, 'execute') anon,
        has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') service
      from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('consume_server_abuse', 'claim_geocode_provider', 'purge_server_abuse') order by 1`)).rows;
    expect(grants).toEqual([
      { fn: "claim_geocode_provider()", anon: false, auth: false, service: true },
      { fn: "consume_server_abuse(jsonb,timestamp with time zone)", anon: false, auth: false, service: true },
      { fn: "purge_server_abuse(integer,timestamp with time zone)", anon: false, auth: false, service: true },
    ]);
  });

  it("keys are HMACs of the normalized value under ABUSE_HMAC_SECRET", () => {
    vi.stubEnv("ABUSE_HMAC_SECRET", "x".repeat(32));
    const a = abuseHash("ip", "203.0.113.1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(abuseHash("email", "203.0.113.1")).not.toBe(a);
    vi.stubEnv("ABUSE_HMAC_SECRET", "y".repeat(32));
    expect(abuseHash("ip", "203.0.113.1")).not.toBe(a);
    vi.unstubAllEnvs();
  });
});

describe("purge_server_abuse", () => {
  it("removes expired rows, keeps live ones, and is bounded per call", async () => {
    await db.exec(`insert into public.server_abuse_counters(action, key_hash, window_start, expires_at, count)
      select 'ads', lpad(to_hex(g), 64, '0'), now() - interval '2 hours', now() - interval '1 hour', 1 from generate_series(1, 25) g`);
    await consume([K("ads", "live")], Date.now());
    expect((await db.query<{ n: number }>("select public.purge_server_abuse(10) as n")).rows[0].n).toBe(10);
    expect((await db.query<{ n: number }>("select public.purge_server_abuse(10) as n")).rows[0].n).toBe(10);
    expect((await db.query<{ n: number }>("select public.purge_server_abuse(10) as n")).rows[0].n).toBe(5);
    expect((await db.query<{ n: number }>("select public.purge_server_abuse() as n")).rows[0].n).toBe(0);
    expect((await abuseRows(db)).map((r) => r.key_hash)).toEqual([key("live")]);
  });
});

describe("demo twin parity (consumeDemoAbuse)", () => {
  it("same admits, waits and windows as SQL for every action, including multi-key denial", async () => {
    const handle = createIsolatedStore();
    const script: [AbuseKey[], number][] = [];
    for (const action of Object.keys(ABUSE_LIMITS) as AbuseAction[]) {
      const { max, seconds } = ABUSE_LIMITS[action];
      for (let i = 0; i < max + 2; i++) script.push([[K(action, 1)], T0 + i * 7]);
      script.push([[K(action, 1)], T0 + (seconds - 1) * 1000 + 400]);
      script.push([[K(action, 1)], T0 + seconds * 1000]);
    }
    for (let i = 0; i < 7; i++) script.push([[K("reset_ip", 9), K("reset_email", 9)], T0 + i]);
    for (let i = 0; i < 12; i++) script.push([[K("signin_email", 8)], i % 2 ? T0 + 900_000 : T0 + 899_999]);
    for (const [keys, at] of script) expect([keys[0].action, consumeDemoAbuse(handle, keys, at)]).toEqual([keys[0].action, await consume(keys, at)]);
  });

  it("geocode gate and purge mirror SQL", () => {
    const handle = createIsolatedStore();
    expect(claimDemoGeocode(handle, T0)).toBe(true);
    expect(claimDemoGeocode(handle, T0 + 1099)).toBe(false);
    expect(claimDemoGeocode(handle, T0 + 1100)).toBe(true);
    consumeDemoAbuse(handle, [K("geocode", 1)], T0);
    expect(purgeDemoAbuse(handle, T0 + 30_000)).toBe(1); // the expired gate row only
    expect(purgeDemoAbuse(handle, T0 + 61_000)).toBe(1);
    expect(handle.state.abuseCounters).toEqual([]);
  });
});

describe("trusted client IP (D1)", () => {
  const ip = (name: string | undefined, headers: Record<string, string>) => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", name ?? "");
    try { return trustedClientIp(new Headers(headers)); } finally { vi.unstubAllEnvs(); }
  };
  it.each([
    ["header unset", undefined, { "x-forwarded-for": "203.0.113.1" }, UNKNOWN_CLIENT],
    ["wrong header name configured", "forwarded", { forwarded: "203.0.113.1" }, UNKNOWN_CLIENT],
    ["configured header missing on the request", "x-real-ip", { "x-forwarded-for": "203.0.113.1" }, UNKNOWN_CLIENT],
    ["single IPv4", "x-forwarded-for", { "x-forwarded-for": " 203.0.113.1 " }, "203.0.113.1"],
    ["chain", "x-forwarded-for", { "x-forwarded-for": "203.0.113.1, 10.0.0.1" }, UNKNOWN_CLIENT],
    ["IPv4 with port", "x-real-ip", { "x-real-ip": "203.0.113.1:443" }, UNKNOWN_CLIENT],
    ["IPv6 canonicalized", "x-real-ip", { "x-real-ip": "2001:DB8:0:0:0:0:0:1" }, "2001:db8::1"],
    ["IPv4-mapped IPv6", "x-real-ip", { "x-real-ip": "::ffff:203.0.113.9" }, "203.0.113.9"],
    ["bracketed IPv6 with port", "x-real-ip", { "x-real-ip": "[2001:db8::1]:443" }, UNKNOWN_CLIENT],
    ["garbage", "x-real-ip", { "x-real-ip": "not-an-ip" }, UNKNOWN_CLIENT],
    ["empty", "x-real-ip", { "x-real-ip": "" }, UNKNOWN_CLIENT],
  ])("%s", (_name, header, headers, expected) => {
    expect(ip(header, headers as Record<string, string>)).toBe(expected);
  });

  it("production refuses to start without a valid TRUSTED_PROXY_HEADER", async () => {
    expect(trustedProxyRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(trustedProxyRefusal({ NODE_ENV: "test" })).toBeNull();
    expect(trustedProxyRefusal({ NODE_ENV: "production" })).toMatch(/without TRUSTED_PROXY_HEADER/);
    expect(trustedProxyRefusal({ NODE_ENV: "production", TRUSTED_PROXY_HEADER: "forwarded" })).toMatch(/TRUSTED_PROXY_HEADER/);
    expect(trustedProxyRefusal({ NODE_ENV: "production", TRUSTED_PROXY_HEADER: "x-forwarded-for" })).toBeNull();
    expect(trustedProxyRefusal({ NODE_ENV: "production", TRUSTED_PROXY_HEADER: "x-real-ip" })).toBeNull();

    const { register } = await import("../src/instrumentation");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "k");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(register()).rejects.toThrow(/TRUSTED_PROXY_HEADER/);
      vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
      await expect(register()).resolves.toBeUndefined();
    } finally {
      err.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
