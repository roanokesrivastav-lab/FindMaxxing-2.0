/**
 * Migration 0053 on real PostgreSQL: what two and three connections do at once
 * (4.0 Amendment A1 revision 3, A1.6, the admission subset).
 *
 * Interleaving is controlled, not timed: one connection takes the lock another
 * needs inside an open transaction, the test waits until pg_blocking_pids()
 * shows the second is really waiting on it, looks at what the waiter holds,
 * then lets go. Each scenario returns plain facts. They are asserted once on
 * the migration as written, and again with ONE guard removed, where the named
 * fact must change: a race test that passes without its guard proves nothing.
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

const url = testDatabaseUrl();
const dir = path.join(__dirname, "../supabase/migrations");
const MIGRATION = readFileSync(path.join(dir, "0053_event_admission.sql"), "utf8");
const oldFunction = (file: string, name: string) => {
  const sql = readFileSync(path.join(dir, file), "utf8");
  const from = sql.lastIndexOf(`create or replace function public.${name}(`);
  return sql.slice(from, sql.indexOf("end $$;", from) + "end $$;".length);
};
const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const host = user("dev");
const [x, y, z, closer, host2] = ["maya_r", "theo", "jules", "lena", "marcus"].map(user);
const PRICE = 1500;
const key = (err: unknown): string => {
  const m = err instanceof Error ? err.message : String(err);
  if (/event is full/i.test(m)) return "full";
  if (/capacity cannot be below/i.test(m)) return "capacity_floor";
  if (/deadlock/i.test(m)) return "DEADLOCK";
  return `error: ${m}`;
};
const settle = <T,>(p: Promise<T>, ok: (v: T) => string) => p.then(ok, key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("0053 admission: races on real PostgreSQL", () => {
  let t: TestDatabase;
  let a: Client, b: Client, c: Client, watch: Client;
  const pids = new Map<Client, number>();

  beforeAll(async () => {
    t = await createTestDatabase(url!);
    await t.a.query(buildSeedSql());
    a = t.a; b = t.b; c = await t.connect(); watch = await t.connect();
    for (const conn of [a, b, c, watch]) pids.set(conn, (await conn.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid);
    await watch.query("select public.set_host_account($1, 'acct_host', true)", [host]);
    await watch.query("select public.set_host_account($1, 'acct_host2', true)", [host2]);
  }, 240_000);
  afterAll(async () => { await t?.drop(); });
  beforeEach(async () => {
    for (const conn of [a, b, c, watch]) await conn.query("rollback; reset role; select set_config('request.jwt.claim.sub', '', false)");
    await watch.query("delete from public.rate_limit_counters; delete from public.account_deletion_jobs");
  });

  /** Act as a signed-in user, the service role, or (null) the database owner on this connection. */
  const as = async (conn: Client, who: string | "service" | null) => {
    await conn.query("reset role");
    await conn.query("select set_config('request.jwt.claim.sub', $1, false)", [who && who !== "service" ? who : ""]);
    if (who) await conn.query(`set role ${who === "service" ? "service_role" : "authenticated"}`);
    return conn;
  };
  /** True once `waiter` is blocked by `holder`; false if that has not happened in time. */
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
  const free = async (table: "events" | "tickets", id: string) => {
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
  let n = 0;
  async function newEvent(capacity: number, priced: boolean, owner = host): Promise<string> {
    await as(watch, owner);
    try {
      const cat = (await watch.query<{ slug: string }>("select slug from public.categories limit 1")).rows[0].slug;
      const id = (await watch.query<{ id: string }>(`insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, capacity)
        values ($1, 'A long enough description', 'Somewhere', 39.96, -83, now() + interval '2 days', auth.uid(), $2, $3) returning id`, [`Race ${++n}`, cat, capacity])).rows[0].id;
      await watch.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [id]);
      if (priced) await watch.query("select public.set_event_price($1, $2)", [id, PRICE]);
      return id;
    } finally {
      await as(watch, null);
    }
  }
  /** A closure test leaves a deletion job behind; clear it so the same person can act in the next ordering. */
  const reopenAccounts = async () => { await as(watch, null); await watch.query("delete from public.account_deletion_jobs"); };
  /** A live hold for `who`, with a checkout session attached. Returns the ticket id and session. */
  async function hold(event: string, who: string) {
    await as(watch, who);
    let ticket: string;
    try {
      ticket = (await watch.query<{ ticket_id: string }>("select * from public.reserve_ticket($1)", [event])).rows[0].ticket_id;
    } finally {
      await as(watch, null);
    }
    const session = `cs_${ticket}`;
    await watch.query("update public.tickets set checkout_session_id = $2 where id = $1", [ticket, session]);
    return { ticket, session };
  }
  const confirm = (conn: Client, session: string) =>
    settle(conn.query<{ r: string }>("select public.confirm_ticket($1, $2, $3) as r", [session, `pi_${session}`, PRICE]), (r) => r.rows[0].r);
  const join = (conn: Client, event: string) => settle(conn.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]), () => "ok");
  const reserve = (conn: Client, event: string) => settle(conn.query("select * from public.reserve_ticket($1)", [event]), () => "held");
  const seats = async (event: string) => (await watch.query<{ going: number; live: number; capacity: number; total: number }>(`
    select (select count(*)::int from public.event_attendees where event_id = e.id) as going,
           (select count(*)::int from public.tickets where event_id = e.id and status = 'pending' and expires_at > clock_timestamp()) as live,
           e.capacity, findmaxxing_private.seats_taken(e.id) as total from public.events e where e.id = $1`, [event])).rows[0];
  const ticket = async (id: string) => (await watch.query<{ status: string; payment_intent_id: string | null; user_id: string | null }>("select status, payment_intent_id, user_id from public.tickets where id = $1", [id])).rows[0];

  // --------------------------------------------------------------------------
  // Scenarios. Each returns facts; nothing in here asserts.
  // --------------------------------------------------------------------------
  /** Two people insert for the last free seat. */
  async function lastSeat() {
    const event = await newEvent(2, false);
    await as(a, x); await as(b, y);
    await a.query("begin");
    const first = await join(a, event);
    const second = join(b, event);
    const waited = await blockedBy(b, a, 1500);
    await a.query("commit");
    return { first, second: await second, waited, ...(await seats(event)) };
  }
  /** Two people reserve the last paid seat. */
  async function lastHold() {
    const event = await newEvent(2, true);
    await as(a, x); await as(b, y);
    await a.query("begin");
    const first = await reserve(a, event);
    const second = reserve(b, event);
    const waited = await blockedBy(b, a, 1500);
    await a.query("commit");
    return { first, second: await second, waited, ...(await seats(event)) };
  }
  /** The host lowers capacity to the going count while someone joins; both orders. */
  async function capacityAgainstJoin(order: "edit first" | "join first") {
    const event = await newEvent(3, false);
    await as(watch, x); await watch.query("insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]); await as(watch, null);
    await as(a, host); await as(b, y);
    const edit = (conn: Client) => settle(conn.query("update public.events set capacity = 2 where id = $1", [event]), () => "ok");
    const [lead, follow] = order === "edit first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "edit first" ? await edit(a) : await join(b, event);
    const following = order === "edit first" ? join(b, event) : edit(a);
    const waited = await blockedBy(follow, lead, 1500);
    await lead.query("commit");
    return { leading, following: await following, waited, ...(await seats(event)) };
  }
  /** Two buyers hold seats; the host tries to lower capacity under them; one buyer then pays. */
  async function capacityUnderHold() {
    const event = await newEvent(4, true);
    const h = await hold(event, x);
    await hold(event, y);
    await as(a, host);
    // One person going and two live holds: three seats spoken for. Two is below that.
    const lowered = await settle(a.query("update public.events set capacity = 2 where id = $1", [event]), () => "ok");
    await as(b, "service");
    const paid = await confirm(b, h.session);
    return { lowered, paid, ticket: (await ticket(h.ticket)).status, ...(await seats(event)) };
  }
  /** x paid, left, and the seat is now being paid for by y. x comes back on the old ticket. */
  async function oldTicketAgainstLiveHold() {
    const event = await newEvent(2, true);
    const hx = await hold(event, x);
    await as(b, "service");
    await confirm(b, hx.session);
    await as(a, x);
    await a.query("delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [event]);
    const hy = await hold(event, y);
    const before = await seats(event);
    const back = await join(a, event);
    const after = await seats(event);
    const yPays = await confirm(b, hy.session);
    return { before, back, after, yPays, yTicket: (await ticket(hy.ticket)).status, xTicket: (await ticket(hx.ticket)).status };
  }
  /** The same seat, raced: y's reservation against x's return on an old ticket; both orders. */
  async function oldTicketRacesReservation(order: "reserve first" | "return first") {
    const event = await newEvent(2, true);
    const hx = await hold(event, x);
    await as(c, "service");
    await confirm(c, hx.session);
    await as(a, x); await as(b, y);
    await a.query("delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [event]);
    const [lead, follow] = order === "reserve first" ? [b, a] : [a, b];
    await lead.query("begin");
    const leading = order === "reserve first" ? await reserve(b, event) : await join(a, event);
    const following = order === "reserve first" ? join(a, event) : reserve(b, event);
    const waited = await blockedBy(follow, lead, 1500);
    await lead.query("commit");
    return { leading, following: await following, waited, ...(await seats(event)) };
  }
  /** While someone else holds the event, what does a waiting confirmation hold? */
  async function confirmWaitsOnEvent() {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await c.query("begin");
    await c.query("select 1 from public.events where id = $1 for update", [event]);
    await as(b, "service");
    const result = confirm(b, h.session);
    const waited = await blockedBy(b, c);
    const ticketFree = await free("tickets", h.ticket);
    await c.query("commit");
    return { waited, ticketFree, result: await result, ticket: (await ticket(h.ticket)).status };
  }
  /** While someone else holds the buyer's account lock (as account closure does), what does a waiting confirmation hold? */
  async function confirmWaitsOnBuyerAccount() {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended('account_close:' || $1::text, 0))", [x]);
    await as(b, "service");
    const result = confirm(b, h.session);
    const waited = await blockedBy(b, c);
    const eventFree = await free("events", event);
    const ticketFree = await free("tickets", h.ticket);
    await c.query("commit");
    return { waited, eventFree, ticketFree, result: await result };
  }
  /** The real thing: the buyer's account closure against their payment confirmation; both orders. */
  async function confirmAgainstClosure(order: "closure first" | "confirmation first") {
    await reopenAccounts();
    const event = await newEvent(3, true);
    const h = await hold(event, closer);
    await as(b, "service"); await as(c, "service");
    const close = (conn: Client) => settle(conn.query("select public.prepare_account_deletion($1)", [closer]), () => "prepared");
    const [lead, follow] = order === "closure first" ? [c, b] : [b, c];
    await lead.query("begin");
    const leading = order === "closure first" ? await close(c) : await confirm(b, h.session);
    const following = order === "closure first" ? confirm(b, h.session) : close(c);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const row = await ticket(h.ticket);
    return { leading, following: followed, waited, ticket: row.status, intent: !!row.payment_intent_id, ...(await seats(event)) };
  }
  /** While someone else holds the caller's account lock, what does a waiting reservation hold? */
  async function reserveWaitsOnOwnAccount() {
    const event = await newEvent(3, true);
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtextextended('account_close:' || $1::text, 0))", [x]);
    await as(b, x);
    const result = reserve(b, event);
    const waited = await blockedBy(b, c);
    const eventFree = await free("events", event);
    await c.query("commit");
    return { waited, eventFree, result: await result };
  }
  /** Payment confirmation against the host cancelling; both orders. */
  async function confirmAgainstCancel(order: "cancel first" | "confirmation first") {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await as(a, host); await as(b, "service");
    const cancel = (conn: Client) => settle(conn.query("update public.events set status = 'cancelled' where id = $1", [event]), () => "cancelled");
    const [lead, follow] = order === "cancel first" ? [a, b] : [b, a];
    await lead.query("begin");
    const leading = order === "cancel first" ? await cancel(a) : await confirm(b, h.session);
    const following = order === "cancel first" ? confirm(b, h.session) : cancel(a);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const row = await ticket(h.ticket);
    return { leading, following: followed, waited, ticket: row.status, intent: !!row.payment_intent_id };
  }
  /** The last seat: a confirmation of its hold against a new reservation for it; both orders. */
  async function confirmAgainstReservation(order: "confirmation first, hold live" | "reservation first, hold lapsed") {
    const event = await newEvent(2, true);
    const h = await hold(event, x);
    await as(a, y); await as(b, "service");
    if (order === "reservation first, hold lapsed") await watch.query("update public.tickets set expires_at = clock_timestamp() - interval '1 second' where id = $1", [h.ticket]);
    const [lead, follow] = order === "confirmation first, hold live" ? [b, a] : [a, b];
    await lead.query("begin");
    const leading = order === "confirmation first, hold live" ? await confirm(b, h.session) : await reserve(a, event);
    const following = order === "confirmation first, hold live" ? reserve(a, event) : confirm(b, h.session);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    return { leading, following: await following, waited, ticket: (await ticket(h.ticket)).status, ...(await seats(event)) };
  }
  /** Payment confirmation against the host's account being closed; both orders. */
  async function confirmAgainstHostClosure(order: "closure first" | "confirmation first") {
    await reopenAccounts();
    const event = await newEvent(3, true, host2);
    const h = await hold(event, x);
    await as(b, "service"); await as(c, "service");
    const close = (conn: Client) => settle(conn.query("select public.prepare_account_deletion($1)", [host2]), () => "prepared");
    const [lead, follow] = order === "closure first" ? [c, b] : [b, c];
    await lead.query("begin");
    const leading = order === "closure first" ? await close(c) : await confirm(b, h.session);
    const following = order === "closure first" ? confirm(b, h.session) : close(c);
    const waited = await blockedBy(follow, lead);
    await lead.query("commit");
    const followed = await following;
    const row = await ticket(h.ticket);
    const status = (await watch.query<{ status: string }>("select status from public.events where id = $1", [event])).rows[0].status;
    return { leading, following: followed, waited, ticket: row.status, intent: !!row.payment_intent_id, event: status };
  }
  /** A confirmation that starts while the hold is live but gets the event lock only after it has run out. */
  async function confirmGetsTheLockTooLate() {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await c.query("begin");
    await c.query("select 1 from public.events where id = $1 for update", [event]);
    await watch.query("update public.tickets set expires_at = clock_timestamp() + interval '1200 milliseconds' where id = $1", [h.ticket]);
    await as(b, "service");
    const result = confirm(b, h.session);
    const waited = await blockedBy(b, c);
    await sleep(1800);
    await c.query("commit");
    return { waited, result: await result, ticket: (await ticket(h.ticket)).status };
  }
  /** A reservation that waits for the event lock: how long is its hold from the moment it could act? */
  async function reservationThatWaited() {
    const event = await newEvent(3, true);
    await c.query("begin");
    await c.query("select 1 from public.events where id = $1 for update", [event]);
    await as(b, x);
    const result = b.query<{ expires_at: Date }>("select * from public.reserve_ticket($1)", [event]);
    const waited = await blockedBy(b, c);
    await sleep(1500);
    const released = (await c.query<{ at: Date }>("select clock_timestamp() as at")).rows[0].at;
    await c.query("commit");
    const expires = (await result).rows[0].expires_at;
    return { waited, holdMinutesFromRelease: (expires.getTime() - released.getTime()) / 60_000 };
  }
  /** The same payment delivered twice at once. */
  async function sameConfirmationTwice() {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await as(a, "service"); await as(b, "service");
    await b.query("begin");
    const first = await confirm(b, h.session);
    const second = confirm(a, h.session);
    const waited = await blockedBy(a, b);
    await b.query("commit");
    return { first, second: await second, waited, ...(await seats(event)) };
  }
  /** A ticket that points at a different buyer by the time it is locked. */
  async function ticketChangesUnderneath() {
    const event = await newEvent(3, true);
    const h = await hold(event, x);
    await c.query("begin");
    await c.query("select 1 from public.events where id = $1 for update", [event]);
    await as(b, "service");
    const result = confirm(b, h.session);
    const waited = await blockedBy(b, c);
    await watch.query("update public.tickets set user_id = $2 where id = $1", [h.ticket, z]);
    await c.query("commit");
    const outcome = await result;
    const row = await ticket(h.ticket);
    return { waited, result: outcome, ticket: row.status, intent: !!row.payment_intent_id, ...(await seats(event)) };
  }

  /** Runs `scenario` with one guard removed, then puts the migration back exactly as written. */
  async function without<T>(guard: string | { sql: string }, scenario: () => Promise<T>, replacement = ""): Promise<T> {
    const sql = typeof guard === "string" ? MIGRATION.replace(guard, replacement) : guard.sql;
    if (typeof guard === "string" && sql === MIGRATION) throw new Error(`the guard text was not found in the migration: ${guard.slice(0, 60)}`);
    await as(watch, null);
    await watch.query(sql);
    try {
      return await scenario();
    } finally {
      for (const conn of [a, b, c]) await conn.query("rollback").catch(() => undefined);
      await as(watch, null);
      await watch.query(MIGRATION);
    }
  }
  const G = {
    eventLockInJoin: ["select * into ev from public.events where id = new.event_id for update;", "select * into ev from public.events where id = new.event_id;"],
    liveHoldsInJoin: ["if findmaxxing_private.seats_taken_at(ev.id, v_at) >= ev.capacity then", "if (select count(*) from public.event_attendees a where a.event_id = ev.id) >= ev.capacity then"],
    buyerLockInConfirm: ["  if seen.user_id is not null then\n    perform pg_advisory_xact_lock(hashtextextended('account_close:' || seen.user_id::text, 0));\n  end if;\n", ""],
    rereadInConfirm: ["select * into t from public.tickets where id = seen.id for update;", "perform 1 from public.tickets where id = seen.id for update; t := seen;"],
    clockInConfirm: ["  -- One clock, read after all three locks.\n  v_at := clock_timestamp();", "  v_at := now();"],
    expiryInReserve: ["v_at + interval '30 minutes'", "now() + interval '30 minutes'"],
  } as const;

  // --------------------------------------------------------------------------
  // As written
  // --------------------------------------------------------------------------
  describe("as written", () => {
    it("the last free seat: the second insert waits, then is told the event is full", async () => {
      expect(await lastSeat()).toMatchObject({ first: "ok", second: "full", waited: true, going: 2, capacity: 2 });
    });

    it("the last paid seat: the second reservation waits, then is told the event is full", async () => {
      expect(await lastHold()).toMatchObject({ first: "held", second: "full", waited: true, going: 1, live: 1, total: 2 });
    });

    it("lowering capacity against a join: whoever commits first wins and seats never exceed capacity", async () => {
      expect(await capacityAgainstJoin("edit first")).toMatchObject({ leading: "ok", following: "full", waited: true, going: 2, capacity: 2 });
      expect(await capacityAgainstJoin("join first")).toMatchObject({ leading: "ok", following: "capacity_floor", waited: true, going: 3, capacity: 3 });
    });

    it("capacity cannot be lowered under a live hold, and the hold then becomes a seat", async () => {
      expect(await capacityUnderHold()).toMatchObject({ lowered: "capacity_floor", paid: "confirmed", ticket: "paid", going: 2, live: 1, capacity: 4 });
    });

    it("the live-hold guard: an old paid ticket is refused while the last seat is being paid for", async () => {
      const r = await oldTicketAgainstLiveHold();
      // One person going and one live hold: fewer attendees than capacity, and still no seat to give.
      expect(r.before).toMatchObject({ going: 1, live: 1, capacity: 2, total: 2 });
      expect(r).toMatchObject({ back: "full", yPays: "confirmed", yTicket: "paid", xTicket: "paid" });
      expect(r.after.total).toBeLessThanOrEqual(r.after.capacity);
    });

    it("that last seat, raced between a reservation and the old ticket: exactly one gets it, in either order", async () => {
      expect(await oldTicketRacesReservation("reserve first")).toMatchObject({ leading: "held", following: "full", waited: true, total: 2, capacity: 2 });
      expect(await oldTicketRacesReservation("return first")).toMatchObject({ leading: "ok", following: "full", waited: true, total: 2, capacity: 2 });
    });

    it("lock order: a confirmation waiting for the event holds no ticket", async () => {
      expect(await confirmWaitsOnEvent()).toEqual({ waited: true, ticketFree: true, result: "confirmed", ticket: "paid" });
    });

    it("lock order: a confirmation waiting for the buyer's account holds neither the event nor the ticket", async () => {
      expect(await confirmWaitsOnBuyerAccount()).toEqual({ waited: true, eventFree: true, ticketFree: true, result: "confirmed" });
    });

    it("the buyer's account closure against their payment: no deadlock, and the money ends in the right place", async () => {
      // Closure first: it expires the hold; the payment that arrives is refunded, with its intent kept.
      expect(await confirmAgainstClosure("closure first")).toMatchObject({ leading: "prepared", following: "refund", waited: true, ticket: "refund_pending", intent: true, going: 1 });
      // Confirmation first: the buyer is seated; closure then runs its own course.
      expect(await confirmAgainstClosure("confirmation first")).toMatchObject({ leading: "confirmed", following: "prepared", waited: true, ticket: "paid", intent: true, going: 2 });
    });

    it("lock order: a reservation waiting for the caller's own account holds no event", async () => {
      expect(await reserveWaitsOnOwnAccount()).toEqual({ waited: true, eventFree: true, result: "held" });
    });

    it("confirmation against cancellation: either order ends with a refund queued, never a seat on a cancelled event", async () => {
      expect(await confirmAgainstCancel("cancel first")).toEqual({ leading: "cancelled", following: "refund", waited: true, ticket: "refund_pending", intent: true });
      expect(await confirmAgainstCancel("confirmation first")).toEqual({ leading: "confirmed", following: "cancelled", waited: true, ticket: "refund_pending", intent: true });
    });

    it("confirmation against a new reservation for the last seat: one or the other, never both", async () => {
      expect(await confirmAgainstReservation("confirmation first, hold live")).toMatchObject({ leading: "confirmed", following: "full", waited: true, ticket: "paid", going: 2, live: 0, capacity: 2 });
      expect(await confirmAgainstReservation("reservation first, hold lapsed")).toMatchObject({ leading: "held", following: "refund", waited: true, ticket: "refund_pending", going: 1, live: 1, capacity: 2 });
    });

    it("confirmation against the host's account closure: no deadlock, and never paid on a cancelled event", async () => {
      expect(await confirmAgainstHostClosure("closure first")).toEqual({ leading: "prepared", following: "refund", waited: true, ticket: "refund_pending", intent: true, event: "cancelled" });
      expect(await confirmAgainstHostClosure("confirmation first")).toEqual({ leading: "confirmed", following: "prepared", waited: true, ticket: "refund_pending", intent: true, event: "cancelled" });
    });

    it("a hold is dead at its expiry by the clock read after the lock: a confirmation that got the lock late is refunded", async () => {
      expect(await confirmGetsTheLockTooLate()).toEqual({ waited: true, result: "refund", ticket: "refund_pending" });
    });

    it("a reservation that waited for the lock still gets its full 30 minutes", async () => {
      const r = await reservationThatWaited();
      expect(r.waited).toBe(true);
      expect(r.holdMinutesFromRelease).toBeGreaterThanOrEqual(30 - 0.002);
      expect(r.holdMinutesFromRelease).toBeLessThan(30.05);
    });

    it("the same payment delivered twice at once: one confirmation, one duplicate", async () => {
      expect(await sameConfirmationTwice()).toMatchObject({ first: "confirmed", second: "duplicate", waited: true, going: 2 });
    });

    it("a ticket that points at a different buyer once locked is not acted on at all", async () => {
      const r = await ticketChangesUnderneath();
      expect(r.waited).toBe(true);
      expect(r.result).toMatch(/payments:ticket_changed/);
      expect(r).toMatchObject({ ticket: "pending", intent: false, going: 1 });
    });

    it("the seat count is private to every API role on a real server too", async () => {
      const event = await newEvent(2, false);
      for (const who of [x, "service"] as const) {
        await as(a, who);
        await expect(a.query("select findmaxxing_private.seats_taken($1)", [event])).rejects.toThrow(/permission denied/);
        await expect(a.query("select findmaxxing_private.seats_taken_at($1, now())", [event])).rejects.toThrow(/permission denied/);
      }
    });
  });

  // --------------------------------------------------------------------------
  // With one guard removed: the named fact must change.
  // --------------------------------------------------------------------------
  describe("with one guard removed", () => {
    it("no event lock in the join: both inserts go through and the event is over capacity", async () => {
      const r = await without(G.eventLockInJoin[0], lastSeat, G.eventLockInJoin[1]);
      // The second insert may still queue briefly behind the first on a later, unrelated lock; what the
      // event lock was for is that it then counts again. Without it, it does not.
      expect(r).toMatchObject({ first: "ok", second: "ok", going: 3, capacity: 2 });
    });

    it("live holds left out of the join count: the old ticket gets in and the buyer who paid is refunded", async () => {
      const r = await without(G.liveHoldsInJoin[0], oldTicketAgainstLiveHold, G.liveHoldsInJoin[1]);
      expect(r.back).toBe("ok");
      expect(r.after.total).toBeGreaterThan(r.after.capacity);
      expect(r).toMatchObject({ yPays: "refund", yTicket: "refund_pending" });
    });

    it("no capacity floor: the host lowers capacity under the hold and the buyer who then pays is refunded", async () => {
      const r = await without({ sql: "drop trigger guard_owner_event_change_capacity_floor on public.events" }, capacityUnderHold);
      expect(r).toMatchObject({ lowered: "ok", paid: "refund", ticket: "refund_pending" });
    });

    it("the old confirm_ticket (ticket first): it waits for the event while holding the ticket", async () => {
      const r = await without({ sql: oldFunction("0028_payment_event_processing.sql", "confirm_ticket") }, confirmWaitsOnEvent);
      expect(r).toMatchObject({ waited: true, ticketFree: false });
    });

    it("no buyer account lock first: it waits for the account while holding the event and the ticket", async () => {
      const r = await without(G.buyerLockInConfirm[0], confirmWaitsOnBuyerAccount, G.buyerLockInConfirm[1]);
      expect(r).toMatchObject({ waited: true, eventFree: false, ticketFree: false });
    });

    it("the old reserve_ticket (event first): it waits for the caller's account while holding the event", async () => {
      const r = await without({ sql: oldFunction("0022_payments.sql", "reserve_ticket") }, reserveWaitsOnOwnAccount);
      expect(r).toMatchObject({ waited: true, eventFree: false });
    });

    it("no re-read after locking: a second delivery is acted on as if the ticket were still pending", async () => {
      const r = await without(G.rereadInConfirm[0], sameConfirmationTwice, G.rereadInConfirm[1]);
      expect(r).toMatchObject({ first: "confirmed", second: "confirmed" });
    });

    it("the transaction's start time instead of the post-lock clock: a hold that has run out is confirmed", async () => {
      const r = await without(G.clockInConfirm[0], confirmGetsTheLockTooLate, G.clockInConfirm[1]);
      expect(r).toMatchObject({ waited: true, result: "confirmed", ticket: "paid" });
    });

    it("the transaction's start time for a new hold's expiry: the hold is shorter by however long it waited", async () => {
      const r = await without(G.expiryInReserve[0], reservationThatWaited, G.expiryInReserve[1]);
      expect(r.waited).toBe(true);
      expect(r.holdMinutesFromRelease).toBeLessThan(30 - 1 / 60);
    });

    it("afterwards the migration is back as written", async () => {
      const def = (await watch.query<{ d: string }>("select pg_get_functiondef('public.confirm_ticket(text,text,integer)'::regprocedure) as d")).rows[0].d;
      expect(def).toMatch(/account_close/);
      expect(def).toMatch(/where id = seen\.id for update/);
      const triggers = (await watch.query<{ n: number }>("select count(*)::int as n from pg_trigger where tgname = 'guard_owner_event_change_capacity_floor'")).rows[0].n;
      expect(triggers).toBe(1);
      expect(await lastSeat()).toMatchObject({ second: "full", going: 2 });
    });
  });
});
