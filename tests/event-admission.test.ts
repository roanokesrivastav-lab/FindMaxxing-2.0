/**
 * Migration 0053 (4.0 Amendment A1 revision 3, A1.2): event admission.
 *
 * One capacity rule on every way in: seats taken are the people going plus live
 * paid holds. This file runs the real SQL in PGlite (one connection) and the
 * demo twin, step for step, on the same scripts. What two transactions do at
 * once is in tests/event-admission-pg.test.ts, on real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const people = { host: user("dev"), x: user("maya_r"), y: user("theo"), z: user("jules"), w: user("nina") };
type Who = keyof typeof people;
const PRICE = 1500;
const soon = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
const MIGRATION = readFileSync(path.join(__dirname, "../supabase/migrations/0053_event_admission.sql"), "utf8");

/** One word per outcome, so SQL and demo answers can be compared directly. */
function key(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/event is full/i.test(m)) return "full";
  if (/capacity cannot be below/i.test(m)) return "capacity_floor";
  if (/ticket_required|needs a ticket/i.test(m)) return "ticket_required";
  if (/already_going|already going|already have a ticket/i.test(m)) return "already_going";
  if (/not open for joining|event_closed|Event not found|no longer/i.test(m)) return "closed";
  return `error: ${m}`;
}
const attempt = (run: () => Promise<unknown>, ok = "ok") => run().then((r) => (typeof r === "string" ? r : ok), key);

/** The same small vocabulary on both sides. */
interface Backend {
  join(who: Who): Promise<string>;
  leave(who: Who): Promise<string>;
  reserve(who: Who): Promise<string>;
  confirm(who: Who, amount?: number): Promise<string>;
  /** Make this person's hold run out, as time passing would. */
  lapse(who: Who): Promise<void>;
  /** A hold that exists without a capacity check: the state a capacity cut could leave behind before 0053. */
  strandHold(who: Who): Promise<void>;
  setCapacity(n: number): Promise<string>;
  retitle(): Promise<string>;
  cancel(): Promise<string>;
  state(): Promise<{ going: Who[]; tickets: Record<string, string>; intents: Record<string, string | null> }>;
}
const nameOf = (id: string | null) => (Object.entries(people).find(([, v]) => v === id)?.[0] ?? "nobody") as Who;

let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); }, 120_000);
afterAll(async () => { await db?.close(); });
const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
  await db.exec("set role service_role");
  try { return (await db.query<T>(sql, p)).rows; } finally { await db.exec("reset role"); }
};
let n = 0;

async function sqlEvent(capacity: number | null, priced: boolean): Promise<{ id: string } & Backend> {
  const cat = (await db.query<{ category_slug: string }>("select category_slug from public.events limit 1")).rows[0].category_slug;
  const id = (await queryAs<{ id: string }>(db, people.host, `insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, capacity)
    values ($1, 'A long enough description', 'Somewhere', 39.96, -83, $2, auth.uid(), $3, $4) returning id`, [`Admission ${++n}`, soon(), cat, capacity]))[0].id;
  await queryAs(db, people.host, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [id]);
  if (priced) {
    await service("select public.set_host_account($1, 'acct_host', true)", [people.host]);
    await queryAs(db, people.host, "select public.set_event_price($1, $2)", [id, PRICE]);
  }
  const session = (who: Who) => `cs_${id}_${who}`;
  return {
    id,
    join: (who) => attempt(() => queryAs(db, people[who], "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [id])),
    leave: (who) => attempt(() => queryAs(db, people[who], "delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [id])),
    reserve: (who) => attempt(async () => {
      const [r] = await queryAs<{ ticket_id: string }>(db, people[who], "select * from public.reserve_ticket($1)", [id]);
      await service("select public.attach_checkout_session($1, $2)", [r.ticket_id, session(who)]);
    }, "held"),
    confirm: (who, amount = PRICE) => attempt(async () => (await service<{ r: string }>("select public.confirm_ticket($1, $2, $3) as r", [session(who), `pi_${id}_${who}`, amount]))[0].r),
    lapse: async (who) => { await db.query("update public.tickets set expires_at = now() - interval '1 minute' where event_id = $1 and user_id = $2 and status = 'pending'", [id, people[who]]); },
    strandHold: async (who) => {
      await db.query(`insert into public.tickets (event_id, user_id, status, amount_cents, currency, checkout_session_id, expires_at)
        values ($1, $2, 'pending', $3, 'usd', $4, now() + interval '30 minutes')`, [id, people[who], PRICE, session(who)]);
    },
    setCapacity: (c) => attempt(() => queryAs(db, people.host, "update public.events set capacity = $2 where id = $1", [id, c])),
    retitle: () => attempt(() => queryAs(db, people.host, "update public.events set title = title || ' (updated)' where id = $1", [id])),
    cancel: () => attempt(() => queryAs(db, people.host, "update public.events set status = 'cancelled' where id = $1", [id])),
    state: async () => {
      const going = (await db.query<{ user_id: string }>("select user_id from public.event_attendees where event_id = $1", [id])).rows.map((r) => nameOf(r.user_id)).sort();
      const rows = (await db.query<{ user_id: string; status: string; payment_intent_id: string | null }>("select user_id, status, payment_intent_id from public.tickets where checkout_session_id like $1", [`cs_${id}_%`])).rows;
      return { going, tickets: Object.fromEntries(rows.map((r) => [nameOf(r.user_id), r.status])), intents: Object.fromEntries(rows.map((r) => [nameOf(r.user_id), r.payment_intent_id ? "set" : null])) };
    },
  };
}

async function demoEvent(capacity: number | null, priced: boolean): Promise<{ repo: DataRepository } & Backend> {
  const handle = createIsolatedStore();
  const repo = createDemoRepository(handle);
  const input = { title: "Admission demo", description: "A long enough description", locationName: "Somewhere", lat: 39.96, lng: -83, startsAt: soon(), categorySlug: handle.state.events[0].categorySlug, capacity, tags: [] as string[] };
  const ev = await repo.events.create(input, people.host);
  if (priced) await repo.payments.setEventPrice(people.host, ev.id, PRICE);
  const held = new Map<Who, string>();
  const mine = (who: Who) => handle.state.tickets.find((t) => t.eventId === ev.id && t.userId === people[who] && t.checkoutSessionId === `cs_${who}`);
  return {
    repo,
    join: (who) => attempt(() => repo.events.join(people[who], ev.id)),
    leave: (who) => attempt(() => repo.events.leave(people[who], ev.id)),
    reserve: (who) => attempt(async () => {
      const r = await repo.payments.reserveTicket(people[who], ev.id);
      held.set(who, r.ticketId);
      await repo.payments.attachCheckout(r.ticketId, `cs_${who}`);
    }, "held"),
    confirm: (who, amount = PRICE) => attempt(() => repo.payments.confirmTicket(`cs_${who}`, `pi_${who}`, amount)),
    lapse: async (who) => { const t = mine(who); if (t && t.status === "pending") t.expiresAt = new Date(Date.now() - 60_000).toISOString(); },
    strandHold: async (who) => {
      handle.state.tickets.push({ id: `stranded-${who}`, eventId: ev.id, userId: people[who], status: "pending", amountCents: PRICE, currency: "usd", checkoutSessionId: `cs_${who}`, paymentIntentId: null,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), createdAt: new Date().toISOString(), paidAt: null, refundedAt: null });
    },
    setCapacity: (c) => attempt(async () => { await repo.events.update(ev.id, { ...input, capacity: c }, people.host); }),
    retitle: () => attempt(async () => { await repo.events.update(ev.id, { ...input, capacity: handle.state.events.find((e) => e.id === ev.id)!.capacity, title: "Admission demo (updated)" }, people.host); }),
    cancel: () => attempt(() => repo.events.cancel(ev.id, people.host)),
    state: async () => {
      const rows = handle.state.tickets.filter((t) => t.eventId === ev.id || t.checkoutSessionId?.startsWith("cs_"));
      return {
        going: handle.state.eventAttendees.filter((a) => a.eventId === ev.id).map((a) => nameOf(a.userId)).sort(),
        tickets: Object.fromEntries(rows.map((t) => [nameOf(t.userId), t.status])),
        intents: Object.fromEntries(rows.map((t) => [nameOf(t.userId), t.paymentIntentId ? "set" : null])),
      };
    },
  };
}

type Step = (b: Backend) => Promise<string | void>;
/** Runs one script on SQL and on the demo twin and returns both transcripts. */
async function both(capacity: number | null, priced: boolean, steps: [string, Step][]) {
  const run = async (b: Backend) => {
    const out: string[] = [];
    for (const [label, step] of steps) out.push(`${label}: ${(await step(b)) ?? "done"}`);
    return { out, state: await b.state() };
  };
  return { sql: await run(await sqlEvent(capacity, priced)), demo: await run(await demoEvent(capacity, priced)) };
}

describe("one capacity rule on every way in (SQL and the demo twin, step for step)", () => {
  it("a free event: the last seat goes to one person and the next is refused", async () => {
    const r = await both(3, false, [
      ["x joins", (b) => b.join("x")],
      ["y joins", (b) => b.join("y")],
      ["z joins", (b) => b.join("z")],
      ["y leaves", (b) => b.leave("y")],
      ["z joins", (b) => b.join("z")],
      ["y comes back", (b) => b.join("y")],
    ]);
    expect(r.sql.out).toEqual(["x joins: ok", "y joins: ok", "z joins: full", "y leaves: ok", "z joins: ok", "y comes back: full"]);
    expect(r.demo).toEqual(r.sql);
    expect(r.sql.state.going).toEqual(["host", "x", "z"]);
  });

  it("an old paid ticket does not get back in past someone who is paying for the last seat", async () => {
    // Capacity 2. x pays and is seated, then leaves. y holds the freed seat while paying. Only one person is
    // going, but both seats are spoken for, so x's old ticket is refused. Before 0053 x got in and y, having
    // paid, was refunded.
    const r = await both(2, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["x pays", (b) => b.confirm("x")],
      ["z reserves", (b) => b.reserve("z")],
      ["x leaves", (b) => b.leave("x")],
      ["y reserves", (b) => b.reserve("y")],
      ["x comes back on the old ticket", (b) => b.join("x")],
      ["y pays", (b) => b.confirm("y")],
      ["x tries again", (b) => b.join("x")],
      ["x cannot buy another", (b) => b.reserve("x")],
    ]);
    expect(r.sql.out).toEqual([
      "x reserves: held", "x pays: confirmed", "z reserves: full", "x leaves: ok", "y reserves: held",
      "x comes back on the old ticket: full", "y pays: confirmed", "x tries again: full", "x cannot buy another: already_going",
    ]);
    expect(r.demo).toEqual(r.sql);
    // x left by choice and was not refunded; the old ticket stays paid and holds no seat.
    expect(r.sql.state).toEqual({ going: ["host", "y"], tickets: { x: "paid", y: "paid" }, intents: { x: "set", y: "set" } });
  });

  it("a host who left cannot push back in past live holds, and gets the seat once a hold runs out", async () => {
    const r = await both(2, true, [
      ["host leaves", (b) => b.leave("host")],
      ["x reserves", (b) => b.reserve("x")],
      ["y reserves", (b) => b.reserve("y")],
      ["host rejoins", (b) => b.join("host")],
      ["x's hold runs out", (b) => b.lapse("x")],
      ["host rejoins", (b) => b.join("host")],
      ["x pays late", (b) => b.confirm("x")],
      ["y pays", (b) => b.confirm("y")],
      ["z reserves", (b) => b.reserve("z")],
    ]);
    expect(r.sql.out).toEqual([
      "host leaves: ok", "x reserves: held", "y reserves: held", "host rejoins: full", "x's hold runs out: done",
      "host rejoins: ok", "x pays late: refund", "y pays: confirmed", "z reserves: full",
    ]);
    expect(r.demo).toEqual(r.sql);
    expect(r.sql.state).toEqual({ going: ["host", "y"], tickets: { x: "refund_pending", y: "paid" }, intents: { x: "set", y: "set" } });
  });

  it("capacity cannot be lowered under a live hold; raising it and other edits are never refused", async () => {
    const r = await both(4, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["lower to 1", (b) => b.setCapacity(1)],
      ["lower to 2", (b) => b.setCapacity(2)],
      ["y reserves", (b) => b.reserve("y")],
      ["x pays", (b) => b.confirm("x")],
      ["retitle", (b) => b.retitle()],
      ["raise to 5", (b) => b.setCapacity(5)],
      ["y reserves", (b) => b.reserve("y")],
      ["lower to 2", (b) => b.setCapacity(2)],
      ["lower to 3", (b) => b.setCapacity(3)],
      ["y's hold runs out", (b) => b.lapse("y")],
      ["lower to 2", (b) => b.setCapacity(2)],
    ]);
    expect(r.sql.out).toEqual([
      "x reserves: held", "lower to 1: capacity_floor", "lower to 2: ok", "y reserves: full", "x pays: confirmed", "retitle: ok",
      "raise to 5: ok", "y reserves: held", "lower to 2: capacity_floor", "lower to 3: ok", "y's hold runs out: done", "lower to 2: ok",
    ]);
    expect(r.demo).toEqual(r.sql);
  });

  it("a hold stranded before this migration: nobody new gets in while over the limit, and the hold is refunded when paid", async () => {
    // Capacity 2, two people going, and a live hold on top: what lowering capacity under a hold left behind.
    const r = await both(2, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["x pays", (b) => b.confirm("x")],
      ["a stranded hold for y", (b) => b.strandHold("y")],
      ["z reserves", (b) => b.reserve("z")],
      ["w reserves", (b) => b.reserve("w")],
      ["x leaves", (b) => b.leave("x")],
      ["x comes back", (b) => b.join("x")],
      ["z reserves", (b) => b.reserve("z")],
      ["the host can still edit", (b) => b.retitle()],
      ["lower to 1", (b) => b.setCapacity(1)],
      ["x comes back", (b) => b.join("x")],
      ["y pays", (b) => b.confirm("y")],
    ]);
    expect(r.sql.out).toEqual([
      "x reserves: held", "x pays: confirmed", "a stranded hold for y: done", "z reserves: full", "w reserves: full", "x leaves: ok",
      // One going and one live hold: the event is exactly full again, so x and z are still refused.
      "x comes back: full", "z reserves: full", "the host can still edit: ok", "lower to 1: capacity_floor", "x comes back: full", "y pays: confirmed",
    ]);
    expect(r.demo).toEqual(r.sql);
  });

  it("the stranded hold, paid while the event is still over its limit, is refunded with its payment kept on record", async () => {
    const r = await both(2, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["x pays", (b) => b.confirm("x")],
      ["a stranded hold for y", (b) => b.strandHold("y")],
      ["y pays", (b) => b.confirm("y")],
      ["y pays again (redelivery)", (b) => b.confirm("y")],
      ["z reserves", (b) => b.reserve("z")],
    ]);
    expect(r.sql.out).toEqual(["x reserves: held", "x pays: confirmed", "a stranded hold for y: done", "y pays: refund", "y pays again (redelivery): duplicate", "z reserves: full"]);
    expect(r.demo).toEqual(r.sql);
    expect(r.sql.state).toEqual({ going: ["host", "x"], tickets: { x: "paid", y: "refund_pending" }, intents: { x: "set", y: "set" } });
  });

  it("the stranded hold simply runs out if it is never paid; raising capacity instead lets it be seated", async () => {
    const aged = await both(2, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["x pays", (b) => b.confirm("x")],
      ["a stranded hold for y", (b) => b.strandHold("y")],
      ["y's hold runs out", (b) => b.lapse("y")],
      ["z reserves", (b) => b.reserve("z")],
      ["y pays after it ran out", (b) => b.confirm("y")],
    ]);
    expect(aged.sql.out).toEqual(["x reserves: held", "x pays: confirmed", "a stranded hold for y: done", "y's hold runs out: done", "z reserves: full", "y pays after it ran out: refund"]);
    expect(aged.demo).toEqual(aged.sql);
    const raised = await both(2, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["x pays", (b) => b.confirm("x")],
      ["a stranded hold for y", (b) => b.strandHold("y")],
      ["raise to 3", (b) => b.setCapacity(3)],
      ["y pays", (b) => b.confirm("y")],
    ]);
    expect(raised.sql.out.slice(3)).toEqual(["raise to 3: ok", "y pays: confirmed"]);
    expect(raised.demo).toEqual(raised.sql);
    expect(raised.sql.state.going).toEqual(["host", "x", "y"]);
  });

  it("confirmation keeps its four answers and its refunds, with the payment kept on record", async () => {
    const r = await both(3, true, [
      ["x reserves", (b) => b.reserve("x")],
      ["y reserves", (b) => b.reserve("y")],
      ["x pays the wrong amount", (b) => b.confirm("x", 999)],
      ["x pays again", (b) => b.confirm("x")],
      ["the host cancels", (b) => b.cancel()],
      ["y pays after the cancellation", (b) => b.confirm("y")],
      ["z pays for nothing", (b) => b.confirm("z")],
    ]);
    expect(r.sql.out).toEqual([
      "x reserves: held", "y reserves: held", "x pays the wrong amount: refund", "x pays again: duplicate", "the host cancels: ok",
      "y pays after the cancellation: refund", "z pays for nothing: unknown",
    ]);
    expect(r.demo).toEqual(r.sql);
    expect(r.sql.state).toEqual({ going: ["host"], tickets: { x: "refund_pending", y: "refund_pending" }, intents: { x: "set", y: "set" } });
  });
});

describe("0053 in the database", () => {
  it("a deleted event, an anonymized buyer and a closing account are each refunded, never seated", async () => {
    // The event is deleted after the hold was made: the ticket keeps no event.
    const gone = await sqlEvent(3, true);
    await gone.reserve("x");
    await db.query("delete from public.events where id = $1", [gone.id]);
    expect(await gone.confirm("x")).toBe("refund");
    // The buyer was anonymized: the ticket keeps no user.
    const anon = await sqlEvent(3, true);
    await anon.reserve("y");
    await db.query("update public.tickets set user_id = null where checkout_session_id = $1", [`cs_${anon.id}_y`]);
    expect(await anon.confirm("y")).toBe("refund");
    // The buyer's account is closing: the attendee insert is refused and the payment refunded.
    const closing = await sqlEvent(3, true);
    await closing.reserve("z");
    await db.query("insert into public.account_deletion_jobs (user_id) values ($1)", [people.z]);
    try {
      expect(await closing.confirm("z")).toBe("refund");
    } finally {
      await db.query("delete from public.account_deletion_jobs where user_id = $1", [people.z]);
    }
    const rows = (await db.query<{ status: string; payment_intent_id: string | null }>("select status, payment_intent_id from public.tickets where checkout_session_id = any($1)",
      [[`cs_${gone.id}_x`, `cs_${anon.id}_y`, `cs_${closing.id}_z`]])).rows;
    expect(rows.map((r) => r.status)).toEqual(["refund_pending", "refund_pending", "refund_pending"]);
    expect(rows.every((r) => !!r.payment_intent_id)).toBe(true);
    expect((await closing.state()).going).toEqual(["host"]);
  });

  it("the capacity message is the one clients already map, and a new hold lasts 30 minutes", async () => {
    const ev = await sqlEvent(4, true);
    await ev.reserve("x");
    await expect(queryAs(db, people.host, "update public.events set capacity = 1 where id = $1", [ev.id])).rejects.toThrow("Capacity cannot be below the existing attendee count");
    const [{ left }] = (await db.query<{ left: number }>("select extract(epoch from (expires_at - clock_timestamp()))::float as left from public.tickets where checkout_session_id = $1", [`cs_${ev.id}_x`])).rows;
    expect(left).toBeGreaterThan(29 * 60);
    expect(left).toBeLessThanOrEqual(30 * 60);
  });

  it("only the owner reaches the capacity floor: someone else is told nothing about seats", async () => {
    const ev = await sqlEvent(4, true);
    await ev.reserve("x");
    // RLS hides the row from a non-owner's update, so no trigger runs and nothing is revealed.
    expect(await queryAs(db, people.y, "update public.events set capacity = 1 where id = $1 returning id", [ev.id])).toEqual([]);
    expect((await db.query<{ capacity: number }>("select capacity from public.events where id = $1", [ev.id])).rows[0].capacity).toBe(4);
    const order = (await db.query<{ tgname: string }>(`select tgname from pg_trigger where tgrelid = 'public.events'::regclass and not tgisinternal and tgname like 'guard_owner%' order by tgname`)).rows.map((r) => r.tgname);
    expect(order).toEqual(["guard_owner_event_change", "guard_owner_event_change_capacity_floor"]);
  });

  it("the seat count stays private: no API role can call it, yet joins, edits and confirmations use it", async () => {
    const ev = await sqlEvent(3, true);
    for (const fn of [`findmaxxing_private.seats_taken('${ev.id}')`, `findmaxxing_private.seats_taken_at('${ev.id}', now())`]) {
      await expect(queryAs(db, people.host, `select ${fn}`)).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, null, `select ${fn}`)).rejects.toThrow(/permission denied/);
      await expect(service(`select ${fn}`)).rejects.toThrow(/permission denied/);
    }
    // The same roles get right answers through the guarded paths.
    expect(await ev.reserve("x")).toBe("held");
    expect(await ev.setCapacity(2)).toBe("ok");
    expect(await ev.confirm("x")).toBe("confirmed");
    const [row] = await queryAs<{ spots_open: number }>(db, people.y, "select spots_open from public.event_readiness($1)", [ev.id]);
    expect(row.spots_open).toBe(0);
  });

  it("existing permissions are exactly as they were", async () => {
    const fn = (await db.query<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(`
      select p.oid::regprocedure::text fn, has_function_privilege('anon', p.oid, 'execute') anon,
        has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('service_role', p.oid, 'execute') service
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('reserve_ticket', 'confirm_ticket') order by 1`)).rows;
    expect(fn).toEqual([
      { fn: "confirm_ticket(text,text,integer)", anon: false, auth: false, service: true },
      { fn: "reserve_ticket(uuid)", anon: false, auth: true, service: true },
    ]);
    // The legacy direct join and leave from web and native.
    const table = (await db.query<{ ins: boolean; del: boolean }>("select has_table_privilege('authenticated', 'public.event_attendees', 'insert') ins, has_table_privilege('authenticated', 'public.event_attendees', 'delete') del")).rows[0];
    expect(table).toEqual({ ins: true, del: true });
    const policies = (await db.query<{ policyname: string }>("select policyname from pg_policies where schemaname = 'public' and tablename = 'event_attendees' order by 1")).rows.map((r) => r.policyname);
    expect(policies).toEqual(["users join visible events", "users leave as self", "visible event attendees"]);
    // Tickets are still not writable by clients.
    await expect(queryAs(db, people.x, "update public.tickets set status = 'paid' where user_id = auth.uid()")).rejects.toThrow(/permission denied/);
  });

  it("each function takes its locks in the one order: account, event, ticket", async () => {
    const def = async (sig: string) => (await db.query<{ d: string }>("select pg_get_functiondef($1::regprocedure) as d", [sig])).rows[0].d;
    const order = (text: string, ...parts: RegExp[]) => parts.map((p) => text.search(p));
    const confirm = await def("public.confirm_ticket(text,text,integer)");
    const c = order(confirm, /pg_advisory_xact_lock\(hashtextextended\('account_close:'/, /from public\.events where id = seen\.event_id for update/, /from public\.tickets where id = seen\.id for update/, /clock_timestamp\(\)/, /insert into public\.event_attendees/);
    expect(c.every((i) => i >= 0)).toBe(true);
    expect([...c].sort((a, b) => a - b)).toEqual(c);
    expect(confirm).not.toMatch(/expires_at <= now\(\)/);
    const reserve = await def("public.reserve_ticket(uuid)");
    const r = order(reserve, /pg_advisory_xact_lock\(hashtextextended\('account_close:'/, /from public\.events where id = p_event for update/, /clock_timestamp\(\)/, /update public\.tickets set status = 'expired'/, /insert into public\.tickets/);
    expect(r.every((i) => i >= 0)).toBe(true);
    expect([...r].sort((a, b) => a - b)).toEqual(r);
    expect(reserve).toMatch(/v_at \+ interval '30 minutes'/);
    const join = await def("public.check_event_join()");
    expect(join.search(/for update/)).toBeLessThan(join.search(/seats_taken_at/));
    // The owner guard no longer has its own floor.
    expect(await def("public.guard_owner_event_change()")).not.toMatch(/Capacity cannot be below/);
  });

  it("the migration is functions and one trigger only, and 0052 is still reserved", () => {
    const code = MIGRATION.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/create table|alter table|create policy|drop policy|create index|drop function/i);
    expect(code).not.toMatch(/waitlist|event_participants|offered|event_series/i);
    // Grants are only restated for the two functions that already had them.
    expect([...code.matchAll(/grant execute on function ([\w.]+)\([^)]*\) to (\w+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(["public.reserve_ticket authenticated", "public.confirm_ticket service_role"]);
    expect(code).not.toMatch(/to anon/);
    const files = readdirSync(path.join(__dirname, "../supabase/migrations"));
    expect(files.filter((f) => f.startsWith("0052"))).toEqual([]);
    expect(files).toContain("0053_event_admission.sql");
  });
});
