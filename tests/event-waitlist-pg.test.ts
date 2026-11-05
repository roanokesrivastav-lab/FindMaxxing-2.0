/**
 * Roadmap 4.4 HARD GATE: the 4.0 spec §15 concurrency cases on REAL PostgreSQL with two independent
 * connections (tests/helpers/postgres.ts). Cases 1–7 and 9–11 belong to batch 4.4 (8 is 4.5a). Each
 * connection acts as an API user (`set local role authenticated` + request.jwt.claim.sub), or as the
 * service where the spec says service. When TEST_DATABASE_URL is unset these SKIP, which is NOT passing.
 * Results print as [race] lines.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./helpers/postgres";

const url = testDatabaseUrl();

describe.skipIf(!url)("4.4 waitlist and offers: two PostgreSQL connections racing", () => {
  let t: TestDatabase;
  let c3: Client;
  const users: string[] = [];
  beforeAll(async () => {
    t = await createTestDatabase(url!);
    c3 = await t.connect();
    for (let i = 0; i < 12; i++) {
      const id = randomUUID();
      users.push(id);
      await t.a.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `u${i}@race.test`, JSON.stringify({ username: `racer${i}`, display_name: `Racer ${i}` })]);
    }
  }, 180_000);
  afterAll(async () => { await t?.drop(); });

  /** One RPC/statement in its own transaction as an API user (uid) or as the service (uid null). */
  const run = async <T = Record<string, unknown>>(c: Client, uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> => {
    await c.query("begin");
    try {
      if (uid) {
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      }
      const r = await c.query(sql, params);
      await c.query("commit");
      return r.rows as T[];
    } catch (err) {
      await c.query("rollback");
      throw err;
    }
  };
  const settle = async <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e: e.message }));
  const rpc = (c: Client, uid: string, fn: string, ev: string) => run<{ r: string }>(c, uid, `select public.${fn}($1) as r`, [ev]).then((rows) => rows[0].r);

  const host = () => users[0];
  /** A free future event (service insert, triggers apply) with the host going. */
  const makeEvent = async (capacity: number | null, opts: { startsInMinutes?: number; price?: number } = {}) => {
    const starts = new Date(Date.now() + (opts.startsInMinutes ?? 3 * 24 * 60) * 60_000).toISOString();
    const [{ id }] = await run<{ id: string }>(t.a, null,
      "insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, capacity, price_cents) values ('Race', 'Race test event.', 'Court', 40, -83, $1, $2, 'pickup-sports', $3, $4) returning id",
      [starts, host(), capacity, opts.price ?? null]);
    await run(t.a, null, "insert into public.event_attendees (event_id, user_id) values ($1, $2)", [id, host()]);
    return id;
  };
  const going = async (ev: string, c: Client = t.a) => (await run<{ user_id: string }>(c, null, "select user_id from public.event_attendees where event_id = $1", [ev])).map((r) => r.user_id);
  const parts = async (ev: string, c: Client = t.a) => run<{ user_id: string; status: string; queue_position: string | null; reason: string | null }>(c, null, "select user_id, status, queue_position, reason from public.event_participants where event_id = $1 order by queue_position nulls last", [ev]);
  const statusOf = async (ev: string, uid: string) => (await parts(ev)).find((p) => p.user_id === uid)?.status ?? ((await going(ev)).includes(uid) ? "going" : null);
  /** All counts from one statement, so one snapshot (separate reads would race the other connection). */
  const invariants = async (ev: string, c: Client = t.a) => {
    const [r] = await run<{ capacity: number | null; going: number; live_offers: number; both: number; max_offered: string | null; min_waiting: string | null; waiting: number }>(c, null, `
      select e.capacity,
        (select count(*)::int from public.event_attendees a where a.event_id = e.id) as going,
        (select count(*)::int from public.event_participants p where p.event_id = e.id and p.status = 'offered' and p.offer_expires_at > clock_timestamp()) as live_offers,
        (select count(*)::int from public.event_participants p join public.event_attendees a on a.event_id = p.event_id and a.user_id = p.user_id where p.event_id = e.id) as both,
        (select max(queue_position) from public.event_participants p where p.event_id = e.id and p.status = 'offered') as max_offered,
        (select min(queue_position) from public.event_participants p where p.event_id = e.id and p.status = 'waitlisted') as min_waiting,
        (select count(*)::int from public.event_participants p where p.event_id = e.id and p.status = 'waitlisted') as waiting
      from public.events e where e.id = $1`, [ev]);
    if (r.capacity !== null) expect(r.going + r.live_offers).toBeLessThanOrEqual(r.capacity);
    expect(r.both).toBe(0); // nobody both going and participating
    // Queue order: every live offer was made to someone ahead of everyone still waiting.
    if (r.max_offered !== null && r.min_waiting !== null) expect(Number(r.max_offered)).toBeLessThan(Number(r.min_waiting));
    return { going: r.going, liveOffers: r.live_offers, waiting: r.waiting };
  };

  it("1. last seat: two join_event calls → exactly one going, the other waitlisted (20 rounds)", async () => {
    let outcomes = "";
    for (let round = 0; round < 20; round++) {
      const ev = await makeEvent(2);
      const [ra, rb] = await Promise.all([rpc(t.a, users[1], "join_event", ev), rpc(t.b, users[2], "join_event", ev)]);
      expect([ra, rb].sort()).toEqual(["going", "waitlisted"]);
      expect((await going(ev)).length).toBe(2);
      await invariants(ev);
      outcomes += ra === "going" ? "a" : "b";
    }
    console.log(`[race] case 1: 20 rounds, winner per round ${outcomes} (exactly one going each time)`);
  });

  /** Capacity 2: host + users[1] going, users[2] waitlisted; users[1] leaves → users[2] holds an offer. */
  const withOffer = async () => {
    const ev = await makeEvent(2);
    expect(await rpc(t.a, users[1], "join_event", ev)).toBe("going");
    expect(await rpc(t.a, users[2], "join_event", ev)).toBe("waitlisted");
    expect(await rpc(t.a, users[1], "leave_event", ev)).toBe("left");
    expect(await statusOf(ev, users[2])).toBe("offered");
    return ev;
  };

  it("2. a direct insert racing accept_offer for the last held seat → the offer holder is going; the direct insert is refused", async () => {
    const log: string[] = [];
    for (let round = 0; round < 10; round++) {
      const ev = await withOffer();
      // The trigger path (what any remaining direct writer, e.g. a service insert, goes through) …
      const [acc, direct] = await Promise.all([
        settle(rpc(t.a, users[2], "accept_offer", ev)),
        settle(run(t.b, null, "insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, users[3]])),
      ]);
      expect(acc).toEqual({ ok: true, v: "going" });
      expect(direct.ok).toBe(false);
      expect(direct.ok ? "" : direct.e).toMatch(/This event is full/);
      expect((await going(ev)).sort()).toEqual([host(), users[2]].sort());
      await invariants(ev);
      log.push(direct.ok ? "?" : "full");
    }
    // … and a PostgREST-style direct insert by an API user is refused outright (phase 2, D-I).
    const ev = await withOffer();
    const [acc, api] = await Promise.all([
      settle(rpc(t.a, users[2], "accept_offer", ev)),
      settle(run(t.b, users[3], "insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, users[3]])),
    ]);
    expect(acc).toEqual({ ok: true, v: "going" });
    // Refused either way: by the trigger (seat already taken) or by RLS (no direct insert policy).
    expect(api.ok ? "" : api.e).toMatch(/row-level security|This event is full/);
    // Uncontended, with seats open, a PostgREST-style insert and delete by an API user are still refused.
    const open = await makeEvent(10);
    await expect(run(t.a, users[3], "insert into public.event_attendees (event_id, user_id) values ($1, $2)", [open, users[3]])).rejects.toThrow(/row-level security/);
    await rpc(t.a, users[3], "join_event", open);
    expect(await run(t.a, users[3], "delete from public.event_attendees where event_id = $1 and user_id = $2 returning user_id", [open, users[3]])).toEqual([]);
    expect(await going(open)).toContain(users[3]);
    console.log(`[race] case 2: 10 rounds trigger path → ${log.join(",")}; API direct insert → RLS refusal; offer holder going every time`);
  });

  it("3. expire_offers racing accept_offer at offer_expires_at (frozen and real clock) → exactly one outcome", async () => {
    const tally = { going: 0, expired: 0 };
    for (let round = 0; round < 16; round++) {
      const ev = await withOffer();
      // Move the expiry 150 ms ahead, then race the two paths around it.
      const [{ x }] = await run<{ x: Date }>(t.a, null, "update public.event_participants set offer_expires_at = clock_timestamp() + interval '150 milliseconds' where event_id = $1 and user_id = $2 returning offer_expires_at as x", [ev, users[2]]);
      const frozen = round % 2 === 0; // even rounds: frozen p_now = the expiry; odd: real clock just after it
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const until = x.getTime() - Date.now();
      const [acc, exp] = await Promise.all([
        (async () => { await wait(Math.max(0, until + (round % 4) * 3 - 6)); return settle(rpc(t.a, users[2], "accept_offer", ev)); })(),
        (async () => { await wait(Math.max(0, until + (frozen ? -2 : 2))); return settle(run<{ n: number }>(t.b, null, frozen ? "select public.expire_offers($1) as n" : "select public.expire_offers(now()) as n", frozen ? [x] : [])); })(),
      ]);
      expect(acc.ok && exp.ok).toBe(true);
      const isGoing = (await going(ev)).includes(users[2]);
      const st = (await parts(ev)).find((p) => p.user_id === users[2]);
      const expired = st?.status === "declined" && st.reason === "expired";
      expect(isGoing !== expired).toBe(true); // never both, never neither
      expect(acc.ok && acc.v).toBe(isGoing ? "going" : "offer_expired");
      tally[isGoing ? "going" : "expired"]++;
      await invariants(ev);
    }
    console.log(`[race] case 3: 16 rounds at the expiry instant → going ${tally.going}, expired-and-passed-on ${tally.expired}; never both, never neither`);
  });

  it("4. double accept of the same offer from two connections → one going row, one no-op", async () => {
    for (let round = 0; round < 10; round++) {
      const ev = await withOffer();
      const [ra, rb] = await Promise.all([rpc(t.a, users[2], "accept_offer", ev), rpc(t.b, users[2], "accept_offer", ev)]);
      expect([ra, rb]).toEqual(["going", "going"]);
      expect((await going(ev)).filter((u) => u === users[2])).toHaveLength(1);
      expect(await parts(ev)).toEqual([]);
    }
    console.log("[race] case 4: 10 rounds of double accept → one going row each, the second call a no-op");
  });

  it("5. leave racing a new join for the freed seat → the seat goes to the next waitlisted person (offer), not the newcomer", async () => {
    for (let round = 0; round < 12; round++) {
      const ev = await makeEvent(2);
      await rpc(t.a, users[1], "join_event", ev);
      await rpc(t.a, users[2], "join_event", ev); // waitlisted, first in line
      const [left, joined] = await Promise.all([rpc(t.a, users[1], "leave_event", ev), rpc(t.b, users[3], "join_event", ev)]);
      expect(left).toBe("left");
      expect(joined).toBe("waitlisted");
      expect(await statusOf(ev, users[2])).toBe("offered");
      expect(await statusOf(ev, users[3])).toBe("waitlisted");
      await invariants(ev);
    }
    console.log("[race] case 5: 12 rounds → the waitlisted person got the offer, the newcomer was waitlisted every time");
  });

  it("6. host lowers capacity racing a join → never going + live offers > capacity", async () => {
    const tally = { capacityFirst: 0, joinFirst: 0 };
    for (let round = 0; round < 12; round++) {
      const ev = await makeEvent(3);
      await rpc(t.a, users[1], "join_event", ev); // 2 going, 1 open
      const [lower, join] = await Promise.all([
        settle(run(t.a, host(), "update public.events set capacity = 2 where id = $1", [ev])),
        settle(rpc(t.b, users[2], "join_event", ev)),
      ]);
      expect(join.ok).toBe(true);
      if (lower.ok) { tally.capacityFirst++; expect(join.ok && join.v).toBe("waitlisted"); }
      else { tally.joinFirst++; expect(lower.e).toMatch(/Capacity cannot be below/); expect(join.ok && join.v).toBe("going"); }
      await invariants(ev);
    }
    console.log(`[race] case 6: 12 rounds → capacity lowered first ${tally.capacityFirst} (join waitlisted), join first ${tally.joinFirst} (lowering refused); invariant held`);
  });

  it("7. paid event: reserve_ticket racing reserve_ticket for the last seat (unchanged) and confirm_ticket still inserting the going row", async () => {
    for (let round = 0; round < 8; round++) {
      const ev = await makeEvent(2, { price: 1500 });
      const reserve = (c: Client, uid: string) => settle(run<{ ticket_id: string }>(c, uid, "select ticket_id from public.reserve_ticket($1)", [ev]));
      const [ra, rb] = await Promise.all([reserve(t.a, users[1]), reserve(t.b, users[2])]);
      expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
      const loser = ra.ok ? rb : ra;
      expect(loser.ok ? "" : loser.e).toMatch(/This event is full/);
      const winner = ra.ok ? users[1] : users[2];
      const ticket = (ra.ok ? ra.v : (rb as { ok: true; v: { ticket_id: string }[] }).v)[0].ticket_id;
      await run(t.a, null, "update public.tickets set checkout_session_id = $2 where id = $1", [ticket, `cs_${ticket}`]);
      const [{ r }] = await run<{ r: string }>(t.a, null, "select public.confirm_ticket($1, $2, 1500) as r", [`cs_${ticket}`, `pi_${ticket}`]);
      expect(r).toBe("confirmed");
      expect((await going(ev)).sort()).toEqual([host(), winner].sort());
      // No waitlist on paid events (D-L): the API says ticket_required, and a refund never makes offers.
      await expect(rpc(t.a, users[3], "join_event", ev)).rejects.toThrow(/payments:ticket_required/);
      await run(t.a, null, "select public.mark_ticket_refunded($1)", [`pi_${ticket}`]);
      expect(await going(ev)).toEqual([host()]);
      expect(await parts(ev)).toEqual([]);
    }
    console.log("[race] case 7: 8 rounds → one reservation wins, the other 'This event is full'; confirm_ticket inserts the going row; no waitlist on paid events");
  });

  it("9. cancel racing joins and an accept → nothing added after the cancellation; offers stop", async () => {
    const tally = { cancelFirst: 0, joinFirst: 0 };
    for (let round = 0; round < 10; round++) {
      const ev = await withOffer(); // host going, users[2] offered (1 seat held)
      await run(t.a, null, "update public.events set capacity = 3 where id = $1", [ev]); // one more open seat → offer_next has nobody; open
      const [cancel, join, accept] = await Promise.all([
        settle(run(t.a, host(), "update public.events set status = 'cancelled' where id = $1", [ev])),
        settle(rpc(t.b, users[4], "join_event", ev)),
        settle(rpc(c3, users[2], "accept_offer", ev)),
      ]);
      expect(cancel.ok).toBe(true);
      // Either the join committed before the cancel (going), or it saw the cancel and was refused.
      if (join.ok) { tally.joinFirst++; expect(join.v).toBe("going"); } else { tally.cancelFirst++; expect(join.e).toMatch(/not open|not found/); }
      expect(accept.ok).toBe(true);
      expect(["going", "offer_expired"]).toContain(accept.ok && accept.v);
      // No live offers survive a cancellation, and no new offers or joins happen afterwards.
      expect((await parts(ev)).filter((p) => p.status === "offered")).toEqual([]);
      const before = (await going(ev)).length;
      await expect(rpc(t.a, users[5], "join_event", ev)).rejects.toThrow(/not open|not found/);
      expect((await run<{ n: number }>(t.a, null, "select public.offer_next($1) as n", [ev]))[0].n).toBe(0);
      expect((await going(ev)).length).toBe(before);
    }
    console.log(`[race] case 9: 10 rounds → cancel first ${tally.cancelFirst} (join refused), join first ${tally.joinFirst}; no offers survive; nothing joins afterwards`);
  });

  it("10. duplicate delivery: offer_next and expire_offers run twice at once → one notification per offer", async () => {
    const ev = await makeEvent(2);
    await rpc(t.a, users[1], "join_event", ev);
    await rpc(t.a, users[2], "join_event", ev);
    await rpc(t.a, users[3], "join_event", ev);
    // Free the seat behind the trigger's back, then run offer_next twice concurrently.
    await run(t.a, null, "alter table public.event_attendees disable trigger event_attendees_offer_next");
    await run(t.a, null, "delete from public.event_attendees where event_id = $1 and user_id = $2", [ev, users[1]]);
    await run(t.a, null, "alter table public.event_attendees enable trigger event_attendees_offer_next");
    const [na, nb] = await Promise.all([
      run<{ n: number }>(t.a, null, "select public.offer_next($1) as n", [ev]),
      run<{ n: number }>(t.b, null, "select public.offer_next($1) as n", [ev]),
    ]);
    expect(na[0].n + nb[0].n).toBe(1);
    const offers = await run<{ user_id: string }>(t.a, null, "select user_id from public.notifications where subject_id = $1 and type = 'event_offer'", [ev]);
    expect(offers.map((o) => o.user_id)).toEqual([users[2]]);
    // Expire it, twice at once: one expiry notice, and exactly one new offer to the next in line.
    await run(t.a, null, "update public.event_participants set offer_expires_at = clock_timestamp() - interval '1 second' where event_id = $1 and status = 'offered'", [ev]);
    const [ea, eb] = await Promise.all([
      run<{ n: number }>(t.a, null, "select public.expire_offers() as n"),
      run<{ n: number }>(t.b, null, "select public.expire_offers() as n"),
    ]);
    expect(ea[0].n + eb[0].n).toBe(1);
    const notes = await run<{ user_id: string; type: string }>(t.a, null, "select user_id, type from public.notifications where subject_id = $1 order by created_at", [ev]);
    expect(notes.filter((n) => n.type === "event_offer_expired").map((n) => n.user_id)).toEqual([users[2]]);
    expect(notes.filter((n) => n.type === "event_offer").map((n) => n.user_id)).toEqual([users[2], users[3]]);
    console.log("[race] case 10: offer_next ×2 concurrently → 1 offer, 1 notice; expire_offers ×2 concurrently → 1 expiry notice, 1 next offer");
  });

  it("11. 1,000 alternating join/leave calls over two connections on a capacity-5 event → invariants hold", async () => {
    const ev = await makeEvent(5);
    const pool = [users.slice(1, 6), users.slice(6, 11)];
    let errors = 0;
    const worker = async (c: Client, mine: string[], seed: number) => {
      for (let i = 0; i < 500; i++) {
        const uid = mine[(i * 7 + seed) % mine.length];
        const fn = i % 2 === 0 ? "join_event" : (i % 6 === 1 ? "accept_offer" : "leave_event");
        const r = await settle(rpc(c, uid, fn, ev));
        if (!r.ok) errors++;
        if (i % 100 === 99) await invariants(ev, c);
      }
    };
    await Promise.all([worker(t.a, pool[0], 1), worker(t.b, pool[1], 3)]);
    const final = await invariants(ev);
    // The queue is FIFO: positions only ever come from the one sequence, so they are unique.
    const pos = (await parts(ev)).filter((p) => p.queue_position !== null).map((p) => p.queue_position);
    expect(new Set(pos).size).toBe(pos.length);
    expect(errors).toBe(0);
    console.log(`[race] case 11: 1000 calls over 2 connections, ${errors} errors; final going ${final.going}/5, live offers ${final.liveOffers}, waiting ${final.waiting}; going+offers ≤ capacity, nobody both going and participating, offers ahead of the queue`);
  }, 300_000);
});
