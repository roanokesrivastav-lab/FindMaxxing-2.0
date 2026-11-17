/**
 * Migration 0054 on real PostgreSQL: what two and three connections do at once
 * (4.0 Amendment A1 revision 3, A1.6 cases 10–14, 19, 20; revision 3 preflight
 * item 2's orderings; the backup-host path of item 3).
 *
 * Interleaving is controlled, not timed, as in tests/event-admission-pg.test.ts:
 * one connection holds a lock inside an open transaction, the test waits until
 * pg_blocking_pids() shows the other is really waiting on it, looks at what the
 * waiter holds, then lets go. Each scenario returns plain facts; they are
 * asserted on the migration as written and again with ONE guard removed, where
 * the named fact must change.
 *
 * Runs only against a local server (TEST_DATABASE_URL). Unset, the suite is
 * SKIPPED, which is not a pass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./helpers/postgres";
import { buildSeedSql } from "../scripts/generate-seed-sql";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { addDays, localDateOf } from "../packages/shared/src/series";

const url = testDatabaseUrl();
const dir = path.join(__dirname, "../supabase/migrations");
const MIGRATION = readFileSync(path.join(dir, "0054_event_series.sql"), "utf8");
const oldFunction = (file: string, name: string) => {
  const sql = readFileSync(path.join(dir, file), "utf8");
  const from = sql.lastIndexOf(`create or replace function public.${name}(`);
  return sql.slice(from, sql.indexOf("end $$;", from) + "end $$;".length);
};
const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [dev, maya, theo, lena] = ["dev", "maya_r", "theo", "lena"].map(user);
const NY = "America/New_York";
const RULE = { freq: "weekly", interval: 1, weekdays: [2, 4], start_local: "19:00", duration_minutes: 90 };
const key = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  if (/deadlock/i.test(m)) return "DEADLOCK";
  if (/not open for joining/i.test(m)) return "closed";
  if (/events:closed/.test(m)) return "series_closed";
  if (/events:not_found/.test(m)) return "not_found";
  if (/account_deletion_in_progress/.test(m)) return "closing";
  if (/violates foreign key/i.test(m)) return "fk_violation";
  if (/You do not own this event/.test(m)) return "not_owner";
  return `error: ${m}`;
};
const settle = <T,>(p: Promise<T>, ok: (v: T) => string) => p.then(ok, key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("0054 series: races on real PostgreSQL", () => {
  let t: TestDatabase;
  let a: Client, b: Client, c: Client, watch: Client;
  const pids = new Map<Client, number>();

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    await t.a.query(buildSeedSql());
    a = t.a; b = t.b; c = await t.connect(); watch = await t.connect();
    for (const conn of [a, b, c, watch]) pids.set(conn, (await conn.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid);
  }, 240_000);
  afterAll(async () => { await t?.drop(); });
  beforeEach(async () => {
    for (const conn of [a, b, c, watch]) await conn.query("rollback; reset role; select set_config('request.jwt.claim.sub', '', false)");
    await watch.query("delete from public.rate_limit_counters; delete from public.account_deletion_jobs");
  });

  const as = async (conn: Client, who: string | "service" | null) => {
    await conn.query("reset role");
    await conn.query("select set_config('request.jwt.claim.sub', $1, false)", [who && who !== "service" ? who : ""]);
    if (who) await conn.query(`set role ${who === "service" ? "service_role" : "authenticated"}`);
    return conn;
  };
  const blockedBy = async (waiter: Client, holder: Client, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const { rows } = await watch.query<{ pids: number[] }>("select pg_blocking_pids($1) as pids", [pids.get(waiter)]);
      if (rows[0].pids.includes(pids.get(holder)!)) return true;
      await sleep(25);
    }
    return false;
  };
  /** Can a bystander lock this row right now? False means someone holds it. */
  const free = async (table: "events" | "event_series" | "conversations", id: string) => {
    await watch.query("begin");
    try {
      await watch.query(`select 1 from public.${table} where id = $1 for update nowait`, [id]);
      return true;
    } catch {
      return false;
    } finally {
      await watch.query("rollback");
    }
  };
  const accountLock = (conn: Client, who: string) => conn.query("select pg_advisory_xact_lock(hashtextextended('account_close:' || $1::text, 0))", [who]);

  type Occ = { id: string; series_local_date: string; status: string; overridden: string[] };
  const occurrences = async (series: string) => (await watch.query<Occ>("select id, series_local_date::text as series_local_date, status, overridden from public.events where series_id = $1 order by series_local_date", [series])).rows;
  let n = 0;
  async function newSeries(owner = dev, over: Record<string, unknown> = {}): Promise<string> {
    await as(watch, owner);
    try {
      const p = { title: `Series race ${++n}`, description: "An easy 5k loop from the park gate; all paces welcome.", category_slug: "pickup-sports", location_name: "Goodale Park gate", lat: 39.97, lng: -83.0, time_zone: NY, rule: RULE, tags: [], capacity: 10, ...over };
      return (await watch.query<{ id: string }>("select public.create_event_series($1::jsonb) as id", [JSON.stringify(p)])).rows[0].id;
    } finally {
      await as(watch, null);
    }
  }
  const addBackup = async (series: string, who: string) => { await as(watch, dev); await watch.query("select public.add_series_host($1, $2)", [series, who]); await as(watch, null); };
  const join = (conn: Client, event: string) => settle(conn.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]), () => "ok");
  const going = async (event: string) => (await watch.query<{ u: string }>("select user_id as u from public.event_attendees where event_id = $1 order by user_id", [event])).rows.map((r) => r.u);
  const exists = async (event: string) => (await watch.query<{ n: number }>("select count(*)::int as n from public.events where id = $1", [event])).rows[0].n === 1;
  const changeRule = (conn: Client, event: string, rule: Record<string, unknown>) =>
    settle(conn.query<{ r: { moved: string[]; kept: string[]; deleted: number; created: number } }>("select public.update_series_from($1, $2::jsonb) as r", [event, JSON.stringify({ rule })]), (r) => `changed:${r.rows[0].r.deleted}:${r.rows[0].r.moved.length}`);
  const generate = (conn: Client, series: string | null, now?: string) =>
    settle(conn.query<{ n: number }>("select public.generate_series_occurrences($1, $2) as n", [series, now ?? null]), (r) => `generated:${r.rows[0].n}`);
  const WED = { ...RULE, weekdays: [3] };

  // --------------------------------------------------------------------------
  // Scenarios. Each returns facts; nothing in here asserts.
  // --------------------------------------------------------------------------
  /** Case 10: two generator runs for the same series at once, per-series (blocking) and batch (never waits). */
  async function twoGenerators(mode: "per series" | "batch") {
    const series = await newSeries();
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await as(a, "service"); await as(b, "service");
    await a.query("begin");
    const first = await generate(a, series, later);
    const second = generate(b, mode === "per series" ? series : null, later);
    const waited = await blockedBy(b, a, 1500);
    const secondBeforeRelease = await Promise.race([second.then((v) => v), sleep(600).then(() => "still running")]);
    await a.query("commit");
    const dates = (await occurrences(series)).map((o) => o.series_local_date);
    return { first, second: await second, waited, secondBeforeRelease, distinct: new Set(dates).size === dates.length, count: dates.length };
  }
  /** Case 11: cancelling an occurrence against a join; both orders. */
  async function cancelAgainstJoin(order: "cancel first" | "join first") {
    const series = await newSeries();
    const [occ] = await occurrences(series);
    await as(a, dev); await as(b, theo);
    const cancel = (conn: Client) => settle(conn.query("select public.cancel_occurrence($1)", [occ.id]), () => "cancelled");
    const [lead, follow] = order === "cancel first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "cancel first" ? await cancel(a) : await join(b, occ.id);
    const following = order === "cancel first" ? join(b, occ.id) : cancel(a);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const status = (await watch.query<{ s: string }>("select status as s from public.events where id = $1", [occ.id])).rows[0].s;
    return { leading, following: followed, waited, status, going: await going(occ.id) };
  }
  /** Case 13: a schedule change against a join on an uncommitted occurrence; both orders. */
  async function changeAgainstJoin(order: "join first" | "change first") {
    const series = await newSeries();
    await addBackup(series, maya);
    const occ = await occurrences(series);
    const target = occ[1];
    await as(a, theo); await as(b, maya);
    const [lead, follow] = order === "join first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "join first" ? await join(a, target.id) : await changeRule(b, occ[0].id, WED);
    const following = order === "join first" ? changeRule(b, occ[0].id, WED) : join(a, target.id);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const still = await exists(target.id);
    const after = still ? (await watch.query<Occ>("select id, series_local_date::text as series_local_date, status, overridden from public.events where id = $1", [target.id])).rows[0] : null;
    const orphan = (await watch.query<{ n: number }>("select count(*)::int as n from public.event_attendees a where a.event_id = $1 and not exists (select 1 from public.events e where e.id = a.event_id)", [target.id])).rows[0].n;
    return { leading, following: followed, waited, exists: still, movedTo: after?.series_local_date ?? null, going: still ? await going(target.id) : [], orphanRows: orphan };
  }
  /** Case 20: the owner's message against a backup host's schedule change on an otherwise uncommitted occurrence; both orders. */
  async function messageAgainstChange(order: "send first" | "change first") {
    const series = await newSeries();
    await addBackup(series, maya);
    const occ = await occurrences(series);
    const target = occ[1];
    const cid = (await watch.query<{ id: string }>("select id from public.conversations where event_id = $1", [target.id])).rows[0].id;
    await as(a, dev); await as(b, maya);
    const send = (conn: Client) => settle(conn.query("insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'Bring a headlamp')", [cid]), () => "sent");
    const [lead, follow] = order === "send first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "send first" ? await send(a) : await changeRule(b, occ[0].id, WED);
    const following = order === "send first" ? changeRule(b, occ[0].id, WED) : send(a);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const messages = (await watch.query<{ n: number }>("select count(*)::int as n from public.messages where conversation_id = $1", [cid])).rows[0].n;
    return { leading, following: followed, waited, exists: await exists(target.id), messages };
  }
  /**
   * Preflight item 2, ordering (i): the owner's direct leave against a backup host's schedule change that
   * deletes the (otherwise uncommitted) occurrence. A third connection stalls the change on the series row,
   * after it holds the owner's account lock, so the leave can interleave.
   */
  async function ownerLeaveAgainstRegeneration() {
    const series = await newSeries();
    await addBackup(series, maya);
    const occ = await occurrences(series);
    const target = occ[1];
    await c.query("begin");
    await c.query("select 1 from public.event_series where id = $1 for update", [series]);
    await as(b, maya);
    const change = changeRule(b, occ[0].id, WED);
    const changeStalled = await blockedBy(b, c);
    await as(a, dev);
    const leave = settle(a.query("delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [target.id]), (r) => `left:${r.rowCount}`);
    const leaveWaitsOnChange = await blockedBy(a, b);
    await c.query("commit");
    const [changed, left] = await Promise.all([change, leave]);
    return { changeStalled, leaveWaitsOnChange, changed, left, exists: await exists(target.id) };
  }
  /** Ordering (ii): the owner's direct edit of a committed occurrence against the backup host's schedule change. */
  async function ownerEditAgainstRegeneration() {
    const series = await newSeries();
    await addBackup(series, maya);
    const occ = await occurrences(series);
    const target = occ[1];
    await as(watch, theo); await watch.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [target.id]); await as(watch, null);
    await c.query("begin");
    await c.query("select 1 from public.event_series where id = $1 for update", [series]);
    await as(b, maya);
    const change = changeRule(b, occ[0].id, WED);
    const changeStalled = await blockedBy(b, c);
    await as(a, dev);
    const edit = settle(a.query("update public.events set title = 'Owner direct edit' where id = $1", [target.id]), (r) => `edited:${r.rowCount}`);
    const editWaitsOnChange = await blockedBy(a, b);
    await c.query("commit");
    const [changed, edited] = await Promise.all([change, edit]);
    const row = (await watch.query<{ title: string; d: string }>("select title, series_local_date::text as d from public.events where id = $1", [target.id])).rows[0];
    return { changeStalled, editWaitsOnChange, changed, edited, title: row.title, movedTo: row.d, movedAway: row.d !== target.series_local_date };
  }
  /** Lock order: a series change waiting for the owner's account lock holds neither the series nor any occurrence. */
  async function changeWaitsOnOwnerAccount() {
    const series = await newSeries();
    await addBackup(series, maya);
    const occ = await occurrences(series);
    await c.query("begin");
    await accountLock(c, dev);
    await as(b, maya);
    const change = changeRule(b, occ[0].id, WED);
    const waited = await blockedBy(b, c);
    const seriesFree = await free("event_series", series);
    const eventFree = await free("events", occ[0].id);
    await c.query("commit");
    return { waited, seriesFree, eventFree, changed: await change };
  }
  /** Lock order for the existing price and session-rule functions: waiting for the account, they hold no event. */
  async function priceWaitsOnOwnAccount(fn: "set_event_price" | "set_session_rules") {
    const series = await newSeries();
    const [occ] = await occurrences(series);
    await watch.query("select public.set_host_account($1, 'acct_dev', true)", [dev]);
    await c.query("begin");
    await accountLock(c, dev);
    await as(b, dev);
    const call = settle(fn === "set_event_price"
      ? b.query("select public.set_event_price($1, 1500)", [occ.id])
      : b.query("select public.set_session_rules($1, 3, null, 'confirmed')", [occ.id]), () => "done");
    const waited = await blockedBy(b, c);
    const eventFree = await free("events", occ.id);
    await c.query("commit");
    return { waited, eventFree, result: await call };
  }
  /** The batch generator against a held owner account: it must not wait; the per-series call must. */
  async function generatorAgainstHeldAccount(mode: "batch" | "per series") {
    const series = await newSeries();
    await c.query("begin");
    await accountLock(c, dev);
    await as(b, "service");
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const run = generate(b, mode === "batch" ? null : series, later);
    const waited = await blockedBy(b, c, 1200);
    const beforeRelease = await Promise.race([run, sleep(400).then(() => "still running")]);
    const createdWhileHeld = (await occurrences(series)).length;
    await c.query("commit");
    const result = await run;
    return { waited, beforeRelease, result, createdForHeldOwner: (await occurrences(series)).length - createdWhileHeld };
  }
  /** The owner's account closure against the backup host's series change; both orders. */
  async function changeAgainstOwnerClosure(order: "closure first" | "change first") {
    await as(watch, null); await watch.query("delete from public.account_deletion_jobs");
    const series = await newSeries(lena);
    await as(watch, lena); await watch.query("select public.add_series_host($1, $2)", [series, maya]); await as(watch, null);
    const occ = await occurrences(series);
    await as(b, maya); await as(c, "service");
    const close = (conn: Client) => settle(conn.query("select public.prepare_account_deletion($1)", [lena]), () => "prepared");
    const [lead, follow] = order === "closure first" ? [c, b] : [b, c];
    await lead.query("begin");
    const leading = order === "closure first" ? await close(c) : await changeRule(b, occ[0].id, WED);
    const following = order === "closure first" ? changeRule(b, occ[0].id, WED) : close(c);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const status = (await watch.query<{ s: string }>("select status as s from public.event_series where id = $1", [series])).rows[0].s;
    const statuses = (await occurrences(series)).map((o) => o.status);
    return { leading, following: followed, waited, series: status, allCancelled: statuses.every((s) => s === "cancelled"), any: statuses.length > 0 };
  }
  /** A1.6 case 12: decide_sessions at the deadline against a join that meets the minimum; both orders. */
  async function decideAgainstJoin(order: "join first" | "decide first") {
    const series = await newSeries(dev, { min_attendance: 2, decision_lead_minutes: 60 });
    const [occ] = await occurrences(series);
    const deadline = (await watch.query<{ d: string }>("select decision_deadline::text as d from public.events where id = $1", [occ.id])).rows[0].d;
    const atDeadline = new Date(new Date(deadline).getTime() + 1000).toISOString();
    await as(a, theo); await as(b, "service");
    const decide = (conn: Client) => settle(conn.query<{ n: number }>("select public.decide_sessions($1) as n", [atDeadline]), (r) => `decided:${r.rows[0].n}`);
    const [lead, follow] = order === "join first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "join first" ? await join(a, occ.id) : await decide(b);
    const following = order === "join first" ? decide(b) : join(a, occ.id);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const row = (await watch.query<{ status: string; decision: string }>("select status, decision from public.events where id = $1", [occ.id])).rows[0];
    return { leading, following: followed, waited, ...row, going: (await going(occ.id)).length };
  }

  /** Runs `scenario` with one guard removed, then puts the migration's functions and the statement triggers back as written. */
  async function without<T>(guard: { sql: string }, scenario: () => Promise<T>): Promise<T> {
    await as(watch, null);
    await watch.query(guard.sql);
    try {
      return await scenario();
    } finally {
      for (const conn of [a, b, c]) await conn.query("rollback").catch(() => undefined);
      await as(watch, null);
      await watch.query(reapply());
    }
  }
  const G = {
    stmtLockOnAttendees: ["create trigger event_attendees_a_lock_actor before insert or delete on public.event_attendees for each statement execute function findmaxxing_private.lock_actor_account();", "drop trigger event_attendees_a_lock_actor on public.event_attendees;"],
    stmtLockOnEvents: ["create trigger events_a_lock_actor before update or delete on public.events for each statement execute function findmaxxing_private.lock_actor_account();", "drop trigger events_a_lock_actor on public.events;"],
    tryLockInBatch: ["      continue when not pg_try_advisory_xact_lock(hashtextextended('account_close:' || r.owner_id::text, 0));", "      perform pg_advisory_xact_lock(hashtextextended('account_close:' || r.owner_id::text, 0));"],
    conversationLock: ["        perform 1 from public.conversations c where c.event_id = r.id for update;\n", ""],
    hostCheckInRpc: ["if not found or e.series_id is null or not findmaxxing_private.can_host_event(p_event, auth.uid()) then", "if not found then"],
  } as const;
  /** The 0054 migration is idempotent apart from its DDL; this is the part that can be re-run to restore a replaced function. */
  const FUNCTIONS_ONLY = MIGRATION.slice(MIGRATION.indexOf("-- 3. Visibility and roles"));
  async function withoutFunction<T>(guard: readonly [string, string], scenario: () => Promise<T>): Promise<T> {
    const sql = FUNCTIONS_ONLY.replace(guard[0], guard[1]);
    if (sql === FUNCTIONS_ONLY) throw new Error(`guard not found: ${guard[0].slice(0, 60)}`);
    return without({ sql: stripDdl(sql) }, scenario);
  }
  /** Function and trigger bodies only, so the migration can be re-applied to a database that already has its tables. */
  function stripDdl(sql: string): string {
    return sql
      .replace(/^alter table public\.moderation_actions[^\n]*\n/gm, "")
      .replace(/^create trigger [^\n]*\n/gm, "")
      .replace(/^create policy [\s\S]*?;\n/gm, "")
      .replace(/^revoke (insert|update|delete)[^\n]*\n/gm, "")
      .replace(/^alter table [^\n]* enable row level security;\n/gm, "")
      .replace(/^-- 10\. Checks[\s\S]*$/m, "");
  }
  /** The functions as written, plus the three statement-level lock triggers (DDL the function-only re-run leaves out). */
  const reapply = () => {
    const triggers = MIGRATION.split("\n").filter((l) => /^create trigger \w+_a_lock_actor /.test(l));
    if (triggers.length !== 3) throw new Error("expected three statement-level lock triggers in the migration");
    return stripDdl(FUNCTIONS_ONLY) + "\n" + triggers.map((l) => l.replace(/^create trigger (\w+) [^;]*on public\.(\w+)/, (m, name, table) => `drop trigger if exists ${name} on public.${table}; ${m}`)).join("\n");
  };

  // --------------------------------------------------------------------------
  // As written
  // --------------------------------------------------------------------------
  describe("as written", () => {
    it("case 10: two generator runs for one series: the second waits, then adds nothing; no date twice", async () => {
      expect(await twoGenerators("per series")).toMatchObject({ second: "generated:0", waited: true, secondBeforeRelease: "still running", distinct: true });
    });

    it("the batch generator never waits: with another run holding the series, it skips it at once and creates nothing for it", async () => {
      const r = await twoGenerators("batch");
      expect(r.waited).toBe(false);
      expect(r.secondBeforeRelease).toBe("generated:0");
      expect(r.distinct).toBe(true);
    });

    it("the batch generator against a held owner account: returns at once without that series; the per-series call waits for it", async () => {
      expect(await generatorAgainstHeldAccount("batch")).toMatchObject({ waited: false, beforeRelease: "generated:0", createdForHeldOwner: 0 });
      const r = await generatorAgainstHeldAccount("per series");
      expect(r.waited).toBe(true);
      expect(r.beforeRelease).toBe("still running");
      expect(r.result).toMatch(/^generated:\d+$/);
    });

    it("case 11: cancelling an occurrence against a join: no going row is added after the cancellation commits", async () => {
      expect(await cancelAgainstJoin("cancel first")).toMatchObject({ leading: "cancelled", following: "closed", waited: true, status: "cancelled", going: [dev] });
      const r = await cancelAgainstJoin("join first");
      expect(r).toMatchObject({ leading: "ok", following: "cancelled", waited: true, status: "cancelled" });
      expect(r.going.sort()).toEqual([dev, theo].sort());
    });

    it("case 13: a schedule change against a join on an uncommitted occurrence: the join lands and the occurrence moves, or it finds the row gone", async () => {
      const r1 = await changeAgainstJoin("join first");
      expect(r1).toMatchObject({ leading: "ok", waited: true, exists: true, orphanRows: 0 });
      expect(r1.following).toMatch(/^changed:/);
      expect(r1.going.sort()).toEqual([dev, theo].sort());
      expect(new Date(`${r1.movedTo}T12:00:00Z`).getUTCDay()).toBe(3);
      const r2 = await changeAgainstJoin("change first");
      expect(r2).toMatchObject({ following: "closed", waited: true, exists: false, going: [], orphanRows: 0 });
      expect(r2.leading).toMatch(/^changed:/);
    });

    it("case 20: a message against a schedule change on an otherwise uncommitted occurrence: sent first it is kept with its row; changed first the send fails and the row is gone", async () => {
      expect(await messageAgainstChange("send first")).toMatchObject({ leading: "sent", waited: true, exists: true, messages: 1 });
      expect(await messageAgainstChange("change first")).toMatchObject({ following: "fk_violation", waited: true, exists: false, messages: 0 });
    });

    it("preflight (i): the owner's direct leave against regeneration: the leave waits before any row, no deadlock, the occurrence goes", async () => {
      const r = await ownerLeaveAgainstRegeneration();
      expect(r).toMatchObject({ changeStalled: true, leaveWaitsOnChange: true, left: "left:0", exists: false });
      expect(r.changed).toMatch(/^changed:/);
    });

    it("preflight (ii): the owner's direct edit against regeneration of a committed occurrence: the edit waits before any row, no deadlock, both apply", async () => {
      const r = await ownerEditAgainstRegeneration();
      expect(r).toMatchObject({ changeStalled: true, editWaitsOnChange: true, edited: "edited:1", title: "Owner direct edit", movedAway: true });
      expect(r.changed).toMatch(/^changed:/);
    });

    it("lock order: a series change waiting for the owner's account holds neither the series nor an occurrence", async () => {
      const r = await changeWaitsOnOwnerAccount();
      expect(r).toMatchObject({ waited: true, seriesFree: true, eventFree: true });
      expect(r.changed).toMatch(/^changed:/);
    });

    it("lock order: price and session-rule changes waiting for the caller's account hold no event", async () => {
      expect(await priceWaitsOnOwnAccount("set_event_price")).toEqual({ waited: true, eventFree: true, result: "done" });
      expect(await priceWaitsOnOwnAccount("set_session_rules")).toEqual({ waited: true, eventFree: true, result: "done" });
    });

    it("the owner's account closure against a backup host's change: no deadlock; closure wins the series either way", async () => {
      expect(await changeAgainstOwnerClosure("closure first")).toMatchObject({ leading: "prepared", following: "series_closed", waited: true, series: "ended", allCancelled: true, any: true });
      const r = await changeAgainstOwnerClosure("change first");
      expect(r).toMatchObject({ following: "prepared", waited: true, series: "ended", allCancelled: true, any: true });
      expect(r.leading).toMatch(/^changed:/);
    });

    it("case 12: decide_sessions at the deadline against a join that meets the minimum: one consistent outcome in either order", async () => {
      expect(await decideAgainstJoin("join first")).toMatchObject({ leading: "ok", following: "decided:1", waited: true, status: "published", decision: "happening", going: 2 });
      expect(await decideAgainstJoin("decide first")).toMatchObject({ leading: "decided:1", following: "closed", waited: true, status: "cancelled", decision: "not_happening", going: 1 });
    });

    it("backup host on a real server: the function succeeds, a direct write changes nothing, and revocation is immediate", async () => {
      const series = await newSeries();
      await addBackup(series, maya);
      const [occ] = await occurrences(series);
      await as(a, maya);
      expect(await settle(a.query("select public.update_occurrence($1, $2::jsonb)", [occ.id, JSON.stringify({ title: "Backup edit" })]), () => "ok")).toBe("ok");
      expect((await a.query("update public.events set title = 'Direct' where id = $1 returning id", [occ.id])).rowCount).toBe(0);
      expect(await settle(a.query(`select public.update_event_with_tags($1, 'Direct', 'An easy 5k loop from the park gate; all paces welcome.', null, 'Goodale Park gate', null, 39.97, -83.0, now() + interval '2 days', null, 'pickup-sports', 10, '{}', null, null, null)`, [occ.id]), () => "ok")).toBe("not_owner");
      await as(watch, dev); await watch.query("select public.remove_series_host($1, $2)", [series, maya]); await as(watch, null);
      expect(await settle(a.query("select public.update_occurrence($1, $2::jsonb)", [occ.id, JSON.stringify({ title: "After revocation" })]), () => "ok")).toBe("not_found");
      expect((await watch.query<{ title: string }>("select title from public.events where id = $1", [occ.id])).rows[0].title).toBe("Backup edit");
    });

    it("case 14 on a real server: a colliding occurrence is kept and reported, a cancelled date is not reused, the index is never violated", async () => {
      const series = await newSeries();
      const occ = await occurrences(series);
      const day = (o: Occ) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay();
      const tues = occ.filter((o) => day(o) === 2);
      const thu = occ.filter((o) => day(o) === 4).find((t) => tues.some((u) => u.series_local_date < t.series_local_date) && tues.some((u) => u.series_local_date > t.series_local_date))!;
      const before = tues.filter((u) => u.series_local_date < thu.series_local_date).pop()!;
      const after = tues.find((u) => u.series_local_date > thu.series_local_date)!;
      await as(a, theo);
      for (const o of [before, after, thu]) expect(await join(a, o.id)).toBe("ok");
      const cancelled = tues.find((u) => u.series_local_date > after.series_local_date)!;
      await as(b, dev);
      await b.query("select public.cancel_occurrence($1)", [cancelled.id]);
      const r = (await b.query<{ r: { kept: string[] } }>("select public.update_series_from($1, $2::jsonb) as r", [occ[0].id, JSON.stringify({ rule: { ...RULE, weekdays: [2] } })])).rows[0].r;
      expect(r.kept).toEqual([thu.id]);
      const rows = await occurrences(series);
      expect(rows.find((o) => o.id === thu.id)).toMatchObject({ series_local_date: thu.series_local_date, overridden: ["schedule"] });
      expect(rows.find((o) => o.id === cancelled.id)).toMatchObject({ status: "cancelled", series_local_date: cancelled.series_local_date });
      expect(new Set(rows.map((o) => o.series_local_date)).size).toBe(rows.length);
      expect(rows.every((o) => o.series_local_date !== null)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // With one guard removed: the named fact must change.
  // --------------------------------------------------------------------------
  describe("with one guard removed", () => {
    it("no statement-level account lock on attendees: the owner's leave holds its row while waiting, and one side deadlocks", async () => {
      const r = await without({ sql: G.stmtLockOnAttendees[1] }, ownerLeaveAgainstRegeneration);
      expect(r.changeStalled).toBe(true);
      expect([r.changed, r.left]).toContain("DEADLOCK");
    });

    it("no statement-level account lock on events: the owner's edit holds the event while waiting, and one side deadlocks", async () => {
      const r = await without({ sql: G.stmtLockOnEvents[1] }, ownerEditAgainstRegeneration);
      expect(r.changeStalled).toBe(true);
      expect([r.changed, r.edited]).toContain("DEADLOCK");
    });

    it("the old set_event_price (event first): it waits for the caller's account while holding the event", async () => {
      const r = await without({ sql: oldFunction("0022_payments.sql", "set_event_price") }, () => priceWaitsOnOwnAccount("set_event_price"));
      expect(r).toMatchObject({ waited: true, eventFree: false });
    });

    it("a blocking lock in the batch generator: it waits on the held account instead of skipping", async () => {
      const r = await withoutFunction(G.tryLockInBatch, () => generatorAgainstHeldAccount("batch"));
      expect(r.waited).toBe(true);
      expect(r.beforeRelease).toBe("still running");
    });

    it("no host recheck in the function: the guard still refuses a revoked host", async () => {
      const r = await withoutFunction(G.hostCheckInRpc, async () => {
        const series = await newSeries();
        await addBackup(series, maya);
        await as(watch, dev); await watch.query("select public.remove_series_host($1, $2)", [series, maya]); await as(watch, null);
        const [occ] = await occurrences(series);
        await as(a, maya);
        return settle(a.query("select public.cancel_occurrence($1)", [occ.id]), () => "cancelled");
      });
      expect(r).toBe("not_owner");
    });

    it("no conversation lock before the empty-chat check: case 20 keeps its outcome, because the owner's account lock already orders the two (recorded finding)", async () => {
      // The only person who can write to an uncommitted occurrence's chat is its owner, and every series
      // function takes the owner's account lock before any row. So the conversation lock is a second line
      // that this removal cannot expose; see docs/features/0054-series.md.
      const r = await withoutFunction(G.conversationLock, () => messageAgainstChange("change first"));
      expect(r).toMatchObject({ following: "fk_violation", waited: true, exists: false, messages: 0 });
    });

    it("afterwards the migration is back as written", async () => {
      await watch.query(reapply());
      const def = (await watch.query<{ d: string }>("select pg_get_functiondef('public.generate_series_occurrences(uuid,timestamptz)'::regprocedure) as d")).rows[0].d;
      expect(def).toMatch(/pg_try_advisory_xact_lock/);
      const triggers = (await watch.query<{ n: number }>("select count(*)::int as n from pg_trigger where tgname in ('events_a_lock_actor', 'event_attendees_a_lock_actor', 'event_tags_a_lock_actor')")).rows[0].n;
      expect(triggers).toBe(3);
      expect(await ownerLeaveAgainstRegeneration()).toMatchObject({ left: "left:0", exists: false });
    });
  });

  it("today's local date helper agrees with the server", async () => {
    const [{ d }] = (await watch.query<{ d: string }>("select (clock_timestamp() at time zone $1)::date::text as d", [NY])).rows;
    expect([localDateOf(Date.now(), NY), addDays(localDateOf(Date.now(), NY), 1), addDays(localDateOf(Date.now(), NY), -1)]).toContain(d);
  });
});
