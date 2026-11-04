/**
 * Security batch 1, part 0.1a, acceptance criterion 12: two independent PostgreSQL connections racing
 * the 0040 limiter functions. Runs only against a real local server (TEST_DATABASE_URL); when it is
 * unset these tests are SKIPPED, which does not satisfy the criterion. Results print as [race] lines.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { assertLocalDatabaseUrl, createTestDatabase, testDatabaseUrl, type TestDatabase } from "./helpers/postgres";

const url = testDatabaseUrl();
const hex = (s: string) => Buffer.from(s).toString("hex").padEnd(64, "0").slice(0, 64);
const keys = (...k: [string, string][]) => JSON.stringify(k.map(([action, key]) => ({ action, key: hex(key) })));

describe("harness self-test (no database needed)", () => {
  it("refuses any TEST_DATABASE_URL that is not on this machine", () => {
    expect(() => assertLocalDatabaseUrl("postgres://u@db.example.supabase.co:5432/postgres")).toThrow(/localhost/);
    expect(() => assertLocalDatabaseUrl("postgres://u@10.0.0.5/postgres")).toThrow(/localhost/);
    expect(() => assertLocalDatabaseUrl("mysql://u@localhost/x")).toThrow(/postgres/);
    expect(() => assertLocalDatabaseUrl("not a url")).toThrow(/valid URL/);
    expect(assertLocalDatabaseUrl("postgres://u@localhost:5433/postgres").port).toBe("5433");
    expect(assertLocalDatabaseUrl("postgresql://u@127.0.0.1/postgres").hostname).toBe("127.0.0.1");
    expect(() => testDatabaseUrl({ CI: "true" })).toThrow(/required in CI/);
  });
});

describe.skipIf(!url)("two PostgreSQL connections racing the 0040 limiter", () => {
  let t: TestDatabase;
  beforeAll(async () => { t = await createTestDatabase(url!); }, 180_000);
  afterAll(async () => { await t?.drop(); });
  beforeEach(async () => {
    await t.a.query("delete from public.server_abuse_counters; update public.geocode_provider_gate set next_at = '-infinity'");
  });

  const consume = async (c: Client, k: string, at?: string) =>
    (await c.query<{ r: number }>(`select public.consume_server_abuse($1::jsonb${at ? ", $2::timestamptz" : ""}) as r`, at ? [k, at] : [k])).rows[0].r;

  it("1,000 alternating consume_server_abuse calls for one key never admit more than the cap", async () => {
    const k = keys(["ads", "race-one-key"]);
    const run = async (c: Client) => { let n = 0; for (let i = 0; i < 500; i++) if ((await consume(c, k)) === 0) n++; return n; };
    const [na, nb] = await Promise.all([run(t.a), run(t.b)]);
    const stored = (await t.a.query<{ count: number }>("select count from public.server_abuse_counters where action = 'ads'")).rows[0].count;
    console.log(`[race] ads cap 120: 1000 calls over 2 connections admitted ${na}+${nb}=${na + nb}; stored count ${stored}`);
    expect(na + nb).toBe(120);
    expect(stored).toBe(120);
    expect(na).toBeGreaterThan(0);
    expect(nb).toBeGreaterThan(0);
  });

  it("multi-key (IP + email) races keep both budgets exact and never overshoot", async () => {
    const run = async (c: Client, tag: string) => {
      let n = 0;
      for (let i = 0; i < 200; i++) if ((await consume(c, keys(["signin_ip", "ip-1"], ["signin_email", `${tag}-${i % 8}`]))) === 0) n++;
      return n;
    };
    const [na, nb] = await Promise.all([run(t.a, "a"), run(t.b, "b")]);
    const rows = (await t.a.query<{ action: string; count: number }>("select action, count from public.server_abuse_counters order by action, key_hash")).rows;
    const ip = rows.find((r) => r.action === "signin_ip")!.count;
    console.log(`[race] signin ip cap 20 / email cap 5: admitted ${na + nb}; ip count ${ip}; max email count ${Math.max(...rows.filter((r) => r.action === "signin_email").map((r) => r.count))}`);
    expect(na + nb).toBe(20);
    expect(ip).toBe(20);
    for (const r of rows.filter((x) => x.action === "signin_email")) expect(r.count).toBeLessThanOrEqual(5);
    expect(rows.filter((r) => r.action === "signin_email").reduce((s, r) => s + r.count, 0)).toBe(20);
  });

  it("a race straddling a window boundary admits at most cap per window", async () => {
    const k = keys(["signin_email", "boundary"]);
    const before = "2026-11-04T12:14:59.999Z", after = "2026-11-04T12:15:00.000Z";
    const run = async (c: Client) => {
      const admitted = { before: 0, after: 0 };
      for (let i = 0; i < 100; i++) {
        const at = i % 2 ? after : before;
        if ((await consume(c, k, at)) === 0) admitted[at === before ? "before" : "after"]++;
      }
      return admitted;
    };
    const [ra, rb] = await Promise.all([run(t.a), run(t.b)]);
    const w1 = ra.before + rb.before, w2 = ra.after + rb.after;
    console.log(`[race] signin_email cap 5 at a 15-min boundary: window 1 admitted ${w1}, window 2 admitted ${w2}`);
    expect(w1).toBeLessThanOrEqual(5);
    expect(w2).toBeLessThanOrEqual(5);
  });

  it("claim_geocode_provider admits at most one claim per 1.1 s across two connections", async () => {
    const claim = async (c: Client): Promise<Date | null> => {
      await c.query("begin");
      try {
        const ok = (await c.query<{ ok: boolean }>("select public.claim_geocode_provider() as ok")).rows[0].ok;
        // Still inside the transaction that holds the gate row, so next_at is this claim's own.
        const next = ok ? (await c.query<{ at: Date }>("select next_at - interval '1.1 seconds' as at from public.geocode_provider_gate")).rows[0].at : null;
        await c.query("commit");
        return next;
      } catch (err) {
        await c.query("rollback");
        throw err;
      }
    };
    // Simultaneous first claims: exactly one wins.
    const first = await Promise.all([claim(t.a), claim(t.b)]);
    expect(first.filter(Boolean)).toHaveLength(1);
    // Then hammer from both connections for ~3.5 s.
    const admits: Date[] = [first.find(Boolean)!];
    let attempts = 2;
    const end = Date.now() + 3500;
    const run = async (c: Client) => { while (Date.now() < end) { attempts++; const at = await claim(c); if (at) admits.push(at); } };
    await Promise.all([run(t.a), run(t.b)]);
    const times = admits.map((d) => d.getTime()).sort((x, y) => x - y);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    console.log(`[race] geocode gate: ${attempts} claims over ~3.6 s from 2 connections admitted ${times.length}; min gap ${Math.min(...gaps)} ms`);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(1100);
    expect(times.length).toBeLessThanOrEqual(5);
    expect(times.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("drops its throwaway database afterwards", async () => {
    const extra = await createTestDatabase(url!);
    const name = extra.name;
    await extra.drop();
    const check = await t.connect();
    expect((await check.query("select 1 from pg_database where datname = $1", [name])).rows).toEqual([]);
  }, 180_000);
});
