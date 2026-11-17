/**
 * Migration 0055 on real PostgreSQL: changes to one event from two sessions at
 * once. Controlled interleaving as in tests/event-admission-pg.test.ts.
 * Runs only against a local server (TEST_DATABASE_URL); unset, it is SKIPPED,
 * which is not a pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./helpers/postgres";
import { buildSeedSql } from "../scripts/generate-seed-sql";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const url = testDatabaseUrl();
const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [owner, maya, theo] = ["marcus", "maya_r", "theo"].map(user);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("0055 notifications: two sessions at once on real PostgreSQL", () => {
  let t: TestDatabase;
  let a: Client, b: Client, watch: Client;
  const pids = new Map<Client, number>();

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    await t.a.query(buildSeedSql());
    a = t.a; b = t.b; watch = await t.connect();
    for (const c of [a, b, watch]) pids.set(c, (await c.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid);
  }, 240_000);
  afterAll(async () => { await t?.drop(); });
  beforeEach(async () => {
    for (const c of [a, b, watch]) await c.query("rollback; reset role; select set_config('request.jwt.claim.sub', '', false)");
    await watch.query("delete from public.rate_limit_counters; delete from public.notifications");
  });

  const as = async (c: Client, who: string | "service") => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claim.sub', $1, false)", [who === "service" ? "" : who]);
    await c.query(`set role ${who === "service" ? "service_role" : "authenticated"}`);
  };
  const blockedBy = async (waiter: Client, holder: Client) => {
    for (let i = 0; i < 160; i++) {
      const { rows } = await watch.query<{ p: number[] }>("select pg_blocking_pids($1) as p", [pids.get(waiter)]);
      if (rows[0].p.includes(pids.get(holder)!)) return true;
      await sleep(25);
    }
    return false;
  };
  async function sessionWithAttendees(over: Record<string, unknown> = {}) {
    await as(watch, owner);
    const wd = new Date(Date.now() + 3 * 86_400_000).getUTCDay() || 7;
    const { rows } = await watch.query<{ id: string }>("select public.create_event_series($1::jsonb) as id", [JSON.stringify({
      title: "Thursday run club", description: "An easy loop from the fountain, every week.", category_slug: "fitness", location_name: "Fountain",
      lat: 39.96, lng: -83.0, time_zone: "America/New_York", tags: [], capacity: 12,
      rule: { freq: "weekly", interval: 1, weekdays: [wd], start_local: "19:00", duration_minutes: 90 }, ...over })]);
    const event = (await watch.query<{ id: string }>("select id from public.events where series_id = $1 order by series_local_date limit 1", [rows[0].id])).rows[0].id;
    for (const who of [maya, theo]) {
      await as(watch, who);
      await watch.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]);
    }
    await watch.query("reset role");
    return { series: rows[0].id, event };
  }
  const keys = async (who: string) =>
    (await watch.query<{ k: string }>("select coalesce(dedupe_key, batch_key) as k from public.notifications where user_id = $1 and type <> 'event_joined' order by k", [who])).rows.map((r) => r.k);

  it("two edits to one event at once: the second waits, each is its own change, and each person going hears both, once", async () => {
    const { event } = await sessionWithAttendees();
    await as(a, owner); await as(b, owner);
    await a.query("begin");
    await a.query("update public.events set location_name = 'North steps' where id = $1", [event]);
    const second = b.query("update public.events set starts_at = starts_at + interval '15 minutes', ends_at = ends_at + interval '15 minutes' where id = $1", [event]);
    const waited = await blockedBy(b, a);
    await a.query("commit");
    await second;
    expect(waited).toBe(true);
    expect((await watch.query<{ c: number }>("select change_seq as c from public.events where id = $1", [event])).rows[0].c).toBe(2);
    for (const who of [maya, theo]) expect(await keys(who)).toEqual([`event_changed:${event}:1`, `event_changed:${event}:2`]);
  });

  it("the deadline cron racing the host's own cancel: whichever is first decides the message, and nobody gets two", async () => {
    for (const hostFirst of [true, false]) {
      await watch.query("delete from public.notifications");
      const { event } = await sessionWithAttendees({ min_attendance: 5, decision_lead_minutes: 60 });
      const due = (await watch.query<{ d: string }>("select (decision_deadline + interval '1 minute')::text as d from public.events where id = $1", [event])).rows[0].d;
      await as(a, owner); await as(b, "service");
      const [lead, follow] = hostFirst ? [a, b] : [b, a];
      await lead.query("begin");
      if (hostFirst) await a.query("select public.cancel_occurrence($1)", [event]);
      else await b.query("select public.decide_sessions($1::timestamptz)", [due]);
      const following = hostFirst ? b.query("select public.decide_sessions($1::timestamptz)", [due]) : a.query("select public.cancel_occurrence($1)", [event]).catch((e: Error) => e);
      const waited = await blockedBy(follow, lead);
      await lead.query("commit");
      await following;
      expect(waited).toBe(true);
      const expected = hostFirst ? `event_cancelled:${event}` : `event_not_happening:${event}`;
      for (const who of [maya, theo]) expect(await keys(who), `host first: ${hostFirst}`).toEqual([expected]);
    }
  });
});
