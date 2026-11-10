/**
 * Roadmap 4.3: minimum attendance, the decision deadline and the Readiness row
 * (0051_session_rules_and_readiness.sql, packages/shared/src/readiness.ts).
 * The clock is frozen by passing p_now to decide_sessions(); event times are in
 * the real future because the owner guard uses the database clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { formatConfirmBy, readinessParts, readinessText } from "../src/lib/readiness";
import { ALL_NOTIFICATION_TYPES, notificationText } from "../src/lib/notifications";

vi.mock("server-only", () => ({}));

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [theo, nina, maya, jules, lena, dev] = ["theo", "nina", "maya_r", "jules", "lena", "dev"].map(user);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const START = Date.now() + 3 * DAY;
const DEADLINE = START - DAY;

const CREATE = `select public.create_event_with_details($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null, null, $13::jsonb) as id`;
const UPDATE = `select public.update_event_with_tags($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null, null, $14::jsonb)`;
const base = (over: { title?: string; startsAt?: string; capacity?: number | null } = {}) => [
  over.title ?? "Session rules game", "Half court, all levels, bring water and a light shirt.", null, "Goodale Park courts", null, 39.97, -83.0,
  over.startsAt ?? iso(START), null, "pickup-sports", over.capacity === undefined ? 10 : over.capacity, ["pickup-sports"],
] as unknown[];
const rules = (min: number | null, deadline: number | null, venue = "confirmed") =>
  JSON.stringify({ min_attendance: min, decision_deadline: deadline === null ? null : iso(deadline), venue_status: venue });

describe("0051: session rules, readiness and the decision", () => {
  let db: PGlite;
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
    await db.exec("set role service_role");
    try { return (await db.query<T>(sql, p)).rows; } finally { await db.exec("reset role"); }
  };
  type Row = { status: string; decision: string; cancel_reason: string | null; min_attendance: number | null; decision_deadline: Date | null; venue_status: string; capacity: number | null };
  const row = async (id: string) => (await db.query<Row>("select status, decision, cancel_reason, min_attendance, decision_deadline, venue_status, capacity from public.events where id = $1", [id])).rows[0];
  const create = async (owner: string, r: string | null, over: Parameters<typeof base>[0] = {}) => (await as<{ id: string }>(owner, CREATE, [...base(over), r]))[0].id;
  // Seeded attendance, as the superuser (the join rules themselves are 4.4's subject).
  const going = async (id: string, ...users: string[]) => { for (const u of users) await db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [id, u]); };
  const decide = async (at: number) => Number((await service<{ n: number }>("select public.decide_sessions($1) as n", [iso(at)]))[0].n);
  const notes = async (id: string) => (await db.query<{ user_id: string; type: string; actor_id: string | null; dedupe_key: string; push_state: string }>(
    "select user_id, type, actor_id, dedupe_key, push_state from public.notifications where subject_id = $1 and type = 'event_not_happening' order by user_id", [id])).rows;

  beforeAll(async () => { db = await createSeededDb(); });
  afterAll(async () => { await db?.close(); });

  it("defaults: no minimum, venue confirmed, decision open", async () => {
    const id = await create(theo, null);
    expect(await row(id)).toMatchObject({ decision: "open", cancel_reason: null, min_attendance: null, decision_deadline: null, venue_status: "confirmed" });
  });

  it("creates with rules in the same transaction", async () => {
    const id = await create(theo, rules(4, DEADLINE, "unconfirmed"));
    const r = await row(id);
    expect(r).toMatchObject({ min_attendance: 4, venue_status: "unconfirmed", decision: "open" });
    expect(r.decision_deadline?.getTime()).toBe(DEADLINE);
  });

  it.each([
    ["a minimum under 2", rules(1, null), /events:bad_session_rules/],
    ["a minimum above the capacity", rules(11, null), /events:min_above_capacity/],
    ["a deadline after the start", rules(4, START + 1000), /events:bad_deadline/],
    ["a deadline that has passed", rules(4, Date.now() - 1000), /events:bad_deadline/],
    ["a deadline without a minimum", rules(null, DEADLINE), /events:bad_session_rules/],
    ["an unknown venue status", rules(4, DEADLINE, "maybe"), /venue_status/],
  ])("refuses %s on create, leaving no event", async (_n, r, error) => {
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.events")).rows[0].n;
    await expect(as(theo, CREATE, [...base(), r])).rejects.toThrow(error);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.events")).rows[0].n).toBe(before);
  });

  it("a creator cannot supply the outcome, on insert or by direct update", async () => {
    const [{ id }] = await as<{ id: string }>(theo, `insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, decision, cancel_reason)
      values ('Outcome supplied', 'Trying to pre-confirm my own event.', 'Somewhere', 39.9, -83, $1, auth.uid(), 'outdoors', 'happening', 'below_minimum') returning id`, [iso(START)]);
    expect(await row(id)).toMatchObject({ decision: "open", cancel_reason: null });
    for (const set of ["decision = 'happening'", "cancel_reason = 'below_minimum'", "min_attendance = 3", "decision_deadline = now()", "venue_status = 'unconfirmed'"]) {
      await expect(as(theo, `update public.events set ${set} where id = $1`, [id])).rejects.toThrow(/permission denied/);
    }
  });

  it("set_session_rules: the host only, on a future published event", async () => {
    const id = await create(theo, null);
    const set = (who: string | null, min: number | null, deadline: number | null, venue = "confirmed") =>
      as(who, "select public.set_session_rules($1, $2, $3, $4)", [id, min, deadline === null ? null : iso(deadline), venue]);
    await set(theo, 4, DEADLINE, "unconfirmed");
    expect(await row(id)).toMatchObject({ min_attendance: 4, venue_status: "unconfirmed" });
    await expect(set(nina, 2, null)).rejects.toThrow(/events:not_found/);
    await expect(set(null, 2, null)).rejects.toThrow(/permission denied|Authentication required/);
    await expect(set(theo, 1, null)).rejects.toThrow(/events:bad_session_rules/);
    await expect(set(theo, 11, null)).rejects.toThrow(/events:min_above_capacity/);
    await expect(set(theo, 4, START + 1)).rejects.toThrow(/events:bad_deadline/);
    await expect(set(theo, 4, Date.now() - 1)).rejects.toThrow(/events:bad_deadline/);
    await expect(set(theo, null, DEADLINE)).rejects.toThrow(/events:bad_session_rules/);
    await expect(set(theo, 4, DEADLINE, "maybe")).rejects.toThrow(/events:bad_session_rules/);
    expect(await row(id)).toMatchObject({ min_attendance: 4, venue_status: "unconfirmed" });
    await set(theo, null, null);
    expect(await row(id)).toMatchObject({ min_attendance: null, decision_deadline: null, venue_status: "confirmed" });
    // Suspended accounts are refused like every other write.
    await db.query("insert into public.suspensions (user_id, reason) values ($1, 'test')", [theo]);
    try { await expect(set(theo, 3, null)).rejects.toThrow(/account_suspended/); }
    finally { await db.query("delete from public.suspensions where user_id = $1", [theo]); }
    await as(theo, "update public.events set status = 'cancelled' where id = $1", [id]);
    await expect(set(theo, 3, null)).rejects.toThrow(/events:closed/);
  });

  it("update: omitted rules are kept, given rules replace, and a moved start carries the deadline", async () => {
    const id = await create(theo, rules(4, DEADLINE));
    const update = (r: string | null, over: Parameters<typeof base>[0] = {}) => as(theo, UPDATE, [id, ...base(over), r]);
    await update(null);
    expect((await row(id)).decision_deadline?.getTime()).toBe(DEADLINE);
    // Start moves two hours later with no rules given: same lead time.
    await update(null, { startsAt: iso(START + 2 * 3_600_000) });
    expect((await row(id)).decision_deadline?.getTime()).toBe(DEADLINE + 2 * 3_600_000);
    // Rules given are final, even with the start moving back in the same call.
    await update(rules(3, DEADLINE - 3_600_000, "unconfirmed"), { startsAt: iso(START) });
    const r = await row(id);
    expect(r).toMatchObject({ min_attendance: 3, venue_status: "unconfirmed" });
    expect(r.decision_deadline?.getTime()).toBe(DEADLINE - 3_600_000);
    await expect(update(null, { capacity: 2 })).rejects.toThrow(/events:min_above_capacity/);
    await expect(update(rules(3, START + 5))).rejects.toThrow(/events:bad_deadline/);
    expect((await row(id)).capacity).toBe(10);
  });

  it("a host cancellation records its reason", async () => {
    const id = await create(theo, rules(4, DEADLINE));
    await as(theo, "update public.events set status = 'cancelled' where id = $1", [id]);
    expect(await row(id)).toMatchObject({ status: "cancelled", cancel_reason: "host", decision: "not_happening" });
  });

  describe("events_readiness", () => {
    type R = { event_id: string; going: number; capacity: number | null; spots_open: number | null; min_attendance: number | null; more_needed: number | null; venue_status: string; decision: string; waitlist: number; time_zone: string };
    const ready = async (who: string | null, id: string) => (await as<R>(who, "select * from public.event_readiness($1)", [id]))[0];

    it("takes each number from its own field, and says null where there is no field", async () => {
      const open = await create(theo, null, { capacity: null });
      expect(await ready(null, open)).toMatchObject({ going: 1, capacity: null, spots_open: null, min_attendance: null, more_needed: null, venue_status: "confirmed", decision: "open", waitlist: 0, time_zone: "America/New_York" });
      const id = await create(theo, rules(4, DEADLINE, "unconfirmed"));
      await going(id, nina, maya);
      expect(await ready(nina, id)).toMatchObject({ going: 3, capacity: 10, spots_open: 7, min_attendance: 4, more_needed: 1, venue_status: "unconfirmed" });
      await going(id, jules, lena);
      expect(await ready(nina, id)).toMatchObject({ going: 5, spots_open: 5, more_needed: 0 });
    });

    it("counts a live paid hold as a seat that is not open, and stops when it expires", async () => {
      const id = await create(theo, null, { capacity: 3 });
      const hold = async (who: string, expires: string) => db.query(
        "insert into public.tickets (event_id, user_id, status, amount_cents, expires_at) values ($1, $2, 'pending', 500, now() + $3::interval)", [id, who, expires]);
      await hold(nina, "20 minutes");
      expect(await ready(null, id)).toMatchObject({ going: 1, spots_open: 1 });
      await hold(maya, "-1 minute");
      expect(await ready(null, id)).toMatchObject({ going: 1, spots_open: 1 });
    });

    it("answers only for events the caller can see, many at once", async () => {
      const a = await create(theo, null);
      const b = await create(theo, null);
      await as(theo, "update public.events set status = 'cancelled' where id = $1", [b]);
      const ids = async (who: string | null) => (await as<{ event_id: string }>(who, "select event_id from public.events_readiness($1)", [[a, b]])).map((r) => r.event_id).sort();
      expect(await ids(null)).toEqual([a]);
      expect(await ids(nina)).toEqual([a]);
      expect(await ids(theo)).toEqual([a, b].sort());
    });
  });

  describe("the decision at the deadline", () => {
    // Each case counts what one run decides, so earlier cases' events are settled first.
    beforeEach(async () => {
      await db.query("update public.events set decision = 'happening' where decision = 'open' and min_attendance is not null and status = 'published' and coalesce(ends_at, starts_at) > now()");
    });

    it("just before: nothing. At the deadline, below the minimum: cancelled, and each person going is told once", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      await going(id, nina, maya);
      expect(await decide(DEADLINE - 1000)).toBe(0);
      expect(await row(id)).toMatchObject({ status: "published", decision: "open" });
      expect(await decide(DEADLINE)).toBe(1);
      expect(await row(id)).toMatchObject({ status: "cancelled", cancel_reason: "below_minimum", decision: "not_happening" });
      // The host is going too. A null actor: nobody "did" this.
      const told = await notes(id);
      expect(told.map((n) => n.user_id).sort()).toEqual([theo, nina, maya].sort());
      expect(told.every((n) => n.actor_id === null && n.dedupe_key === `event_not_happening:${id}` && n.push_state === "pending")).toBe(true);
      // A re-run decides nothing and tells nobody again.
      expect(await decide(DEADLINE + 3_600_000)).toBe(0);
      expect((await notes(id)).length).toBe(3);
      // Nobody else hears about it, and no "cancelled by host" notification is sent on top.
      expect((await db.query("select 1 from public.notifications where subject_id = $1 and type = 'event_cancelled'", [id])).rows).toEqual([]);
    });

    it("the dedupe key holds even if the notification step runs twice", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      await going(id, nina);
      await decide(DEADLINE);
      for (let i = 0; i < 2; i++) {
        await service("select public.notify($1, 'event_not_happening', null, 'event', $2, 'x', null, $3)", [nina, id, `event_not_happening:${id}`]);
      }
      expect((await notes(id)).filter((n) => n.user_id === nina).length).toBe(1);
    });

    it("at the deadline with the minimum met: it is happening, and stays so if people leave later", async () => {
      const id = await create(theo, rules(3, DEADLINE));
      await going(id, nina, maya);
      expect(await decide(DEADLINE)).toBe(1);
      expect(await row(id)).toMatchObject({ status: "published", decision: "happening", cancel_reason: null });
      await db.query("delete from public.event_attendees where event_id = $1 and user_id = $2", [id, nina]);
      expect(await decide(DEADLINE + DAY / 2)).toBe(0);
      expect(await row(id)).toMatchObject({ status: "published", decision: "happening" });
      expect(await notes(id)).toEqual([]);
    });

    it("after the deadline (a late cron run) decides the same way", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      expect(await decide(DEADLINE + 6 * 3_600_000)).toBe(1);
      expect(await row(id)).toMatchObject({ status: "cancelled", cancel_reason: "below_minimum" });
    });

    it("a host confirm before the deadline blocks the automatic cancel", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      await expect(as(nina, "select public.confirm_session($1)", [id])).rejects.toThrow(/events:not_found/);
      await expect(as(null, "select public.confirm_session($1)", [id])).rejects.toThrow(/permission denied|Authentication required/);
      expect((await as<{ d: string }>(theo, "select public.confirm_session($1) as d", [id]))[0].d).toBe("happening");
      expect(await decide(DEADLINE + 1000)).toBe(0);
      expect(await row(id)).toMatchObject({ status: "published", decision: "happening" });
      expect(await notes(id)).toEqual([]);
    });

    it("leaves events without a minimum or a deadline alone", async () => {
      const none = await create(theo, null);
      const noDeadline = await create(theo, rules(5, null));
      await decide(START - 1000);
      expect(await row(none)).toMatchObject({ status: "published", decision: "open" });
      expect(await row(noDeadline)).toMatchObject({ status: "published", decision: "open" });
    });

    it("respects a muted type and a block-free null actor; other types are untouched", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      await going(id, dev);
      await as(dev, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['event_not_happening']) on conflict (user_id) do update set muted_types = excluded.muted_types");
      await decide(DEADLINE);
      expect((await notes(id)).map((n) => n.user_id)).toEqual([theo]);
      await db.query("delete from public.notification_settings where user_id = $1", [dev]);
    });

    it("refunds paid tickets through the existing cancel path", async () => {
      const id = await create(theo, rules(4, DEADLINE));
      await db.query("insert into public.tickets (event_id, user_id, status, amount_cents, expires_at, payment_intent_id) values ($1, $2, 'paid', 500, now(), 'pi_min')", [id, nina]);
      await decide(DEADLINE);
      expect((await db.query<{ status: string }>("select status from public.tickets where event_id = $1", [id])).rows).toEqual([{ status: "refund_pending" }]);
    });

    it("is for the service role only", async () => {
      await expect(as(theo, "select public.decide_sessions(now())")).rejects.toThrow(/permission denied/);
      await expect(as(null, "select public.decide_sessions(now())")).rejects.toThrow(/permission denied/);
    });
  });

  it("the new notification type is a known setting, pushed by default", async () => {
    await as(lena, "insert into public.notification_settings (user_id) values (auth.uid())");
    const [s] = (await db.query<{ push_types: string[] }>("select push_types from public.notification_settings where user_id = $1", [lena])).rows;
    expect(s.push_types).toContain("event_not_happening");
    await as(lena, "update public.notification_settings set muted_types = array['event_not_happening', 'new_message'] where user_id = auth.uid()");
    await expect(as(lena, "update public.notification_settings set muted_types = array['no_such_type'] where user_id = auth.uid()")).rejects.toThrow(/notifications:bad_type/);
    expect(ALL_NOTIFICATION_TYPES).toContain("event_not_happening");
  });
});

describe("the Readiness row", () => {
  const now = Date.parse("2026-11-12T15:00:00Z"); // 10:00 in New York
  const full = { going: 8, capacity: 12, spotsOpen: 4, minAttendance: 10, moreNeeded: 2, decisionDeadline: "2026-11-12T21:00:00Z", timeZone: "America/New_York", venueStatus: "confirmed" as const, decision: "open" as const, waitlist: 0 };

  it("reads like the founder's example", () => {
    expect(readinessText(full, { now })).toBe("8 going · 4 spots open · 2 more needed · host confirms by 4 p.m.");
  });

  it("says nothing about a field that is missing", () => {
    expect(readinessText({ going: 3 }, { now })).toBe("3 going");
    expect(readinessText({ going: 0, capacity: null, spotsOpen: null, minAttendance: null, moreNeeded: null, decisionDeadline: null }, { now })).toBe("0 going");
    // A capacity without the open count (the numbers could not be read) claims nothing about room.
    expect(readinessText({ going: 3, capacity: 10 }, { now })).toBe("3 going");
    // A minimum with no deadline promises no time.
    expect(readinessText({ ...full, decisionDeadline: null }, { now })).toBe("8 going · 4 spots open · 2 more needed");
    // A deadline without a zone cannot be worded correctly, so it is left out.
    expect(readinessText({ ...full, timeZone: undefined }, { now })).toBe("8 going · 4 spots open · 2 more needed");
  });

  it("never promises a deadline that has passed, or a need that is met", () => {
    expect(readinessText(full, { now: Date.parse(full.decisionDeadline) + 1 })).toBe("8 going · 4 spots open · 2 more needed");
    expect(readinessText({ ...full, going: 10, spotsOpen: 2, moreNeeded: 0 }, { now })).toBe("10 going · 2 spots open · host confirms by 4 p.m.");
    expect(readinessText({ ...full, decision: "happening" }, { now })).toBe("8 going · 4 spots open · It's on");
  });

  it("handles full, waitlist, unconfirmed venue, cancelled and ended", () => {
    expect(readinessParts({ ...full, going: 12, spotsOpen: 0, moreNeeded: 0, waitlist: 3 }, { now }).slice(0, 3)).toEqual(["12 going", "Full", "3 on the waitlist"]);
    expect(readinessText({ ...full, spotsOpen: 1, venueStatus: "unconfirmed" }, { now })).toContain("1 spot open");
    expect(readinessText({ ...full, venueStatus: "unconfirmed" }, { now }).endsWith("venue not confirmed yet")).toBe(true);
    expect(readinessText({ ...full, decision: "not_happening" }, { now })).toBe("8 going · Not happening");
    expect(readinessText(full, { now, cancelled: true })).toBe("8 going · Not happening");
    expect(readinessText(full, { now, ended: true })).toBe("8 going");
  });

  it("words the deadline in the event's zone, across a DST change", () => {
    expect(formatConfirmBy("2026-11-12T21:30:00Z", "America/New_York", now)).toBe("4:30 p.m.");
    expect(formatConfirmBy("2026-11-12T21:00:00Z", "America/Chicago", now)).toBe("3 p.m.");
    expect(formatConfirmBy("2026-11-13T15:00:00Z", "America/New_York", now)).toBe("Fri 10 a.m.");
    // 16:00 local on both sides of the 2026-11-01 fall-back: the instant differs by an hour, the wording does not.
    const before = Date.parse("2026-10-31T12:00:00Z");
    expect(formatConfirmBy("2026-10-31T20:00:00Z", "America/New_York", before)).toBe("4 p.m.");
    expect(formatConfirmBy("2026-11-01T21:00:00Z", "America/New_York", Date.parse("2026-11-01T12:00:00Z"))).toBe("4 p.m.");
  });

  it("names the event's zone when the viewer's clock differs, and not otherwise", () => {
    expect(formatConfirmBy("2026-11-12T21:00:00Z", "America/New_York", now, "America/New_York")).toBe("4 p.m.");
    // Detroit keeps the same clock as New York: no label needed.
    expect(formatConfirmBy("2026-11-12T21:00:00Z", "America/New_York", now, "America/Detroit")).toBe("4 p.m.");
    expect(formatConfirmBy("2026-11-12T21:00:00Z", "America/New_York", now, "America/Los_Angeles")).toBe("4 p.m. EST");
    expect(formatConfirmBy("2026-07-12T20:00:00Z", "America/New_York", Date.parse("2026-07-12T12:00:00Z"), "UTC")).toBe("4 p.m. EDT");
    expect(readinessText(full, { now, viewerTimeZone: "America/Los_Angeles" })).toBe("8 going · 4 spots open · 2 more needed · host confirms by 4 p.m. EST");
  });

  it("words the notification", () => {
    expect(notificationText({ type: "event_not_happening", label: "Thursday run", detail: null, count: 1, subjectType: "event", subjectId: "x", actorName: null }))
      .toBe("Thursday run isn't happening: not enough people signed up");
  });
});

describe("demo twin (4.3)", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    title: "Demo session rules", description: "Half court, all levels, bring water and a light shirt.", placeId: null, locationName: "Goodale Park courts", address: null,
    lat: 39.97, lng: -83.0, startsAt: iso(START), endsAt: null, categorySlug: "pickup-sports", capacity: 10 as number | null, tags: ["pickup-sports"],
    ...over,
  });
  const rule = (min: number | null, deadline: number | null, venue: "confirmed" | "unconfirmed" = "confirmed") =>
    ({ minAttendance: min, decisionDeadline: deadline === null ? null : iso(deadline), venueStatus: venue });
  const setup = () => {
    const store = createIsolatedStore();
    return { store, repo: createDemoRepository(store) };
  };

  it("refuses the same rules the database refuses", async () => {
    const { repo } = setup();
    await expect(repo.events.create(input({ sessionRules: rule(1, null) }), theo)).rejects.toThrow("Check the minimum and the decision time");
    await expect(repo.events.create(input({ sessionRules: rule(11, null) }), theo)).rejects.toThrow("The minimum can't be more than the capacity");
    await expect(repo.events.create(input({ sessionRules: rule(4, START + 1000) }), theo)).rejects.toThrow("The decision time must be before the start");
    await expect(repo.events.create(input({ sessionRules: rule(4, Date.now() - 1000) }), theo)).rejects.toThrow("The decision time must be before the start");
    await expect(repo.events.create(input({ sessionRules: rule(null, DEADLINE) }), theo)).rejects.toThrow("Check the minimum and the decision time");
    const ev = await repo.events.create(input(), theo);
    await expect(repo.events.setSessionRules(nina, ev.id, rule(2, null))).rejects.toThrow("That event isn't available");
    await repo.events.setSessionRules(theo, ev.id, rule(4, DEADLINE, "unconfirmed"));
    await expect(repo.events.update(ev.id, input({ capacity: 2 }), theo)).rejects.toThrow("The minimum can't be more than the capacity");
    expect((await repo.events.get(ev.id, theo))?.capacity).toBe(10);
  });

  it("update keeps, replaces and carries the deadline like the trigger", async () => {
    const { repo } = setup();
    const ev = await repo.events.create(input({ sessionRules: rule(4, DEADLINE) }), theo);
    let next = await repo.events.update(ev.id, input(), theo);
    expect(Date.parse(next.decisionDeadline!)).toBe(DEADLINE);
    next = await repo.events.update(ev.id, input({ startsAt: iso(START + 2 * 3_600_000) }), theo);
    expect(Date.parse(next.decisionDeadline!)).toBe(DEADLINE + 2 * 3_600_000);
    next = await repo.events.update(ev.id, input({ sessionRules: rule(3, DEADLINE - 3_600_000, "unconfirmed") }), theo);
    expect([next.minAttendance, Date.parse(next.decisionDeadline!), next.venueStatus]).toEqual([3, DEADLINE - 3_600_000, "unconfirmed"]);
  });

  it("readiness counts live paid holds and nothing else", async () => {
    const { repo, store } = setup();
    const ev = await repo.events.create(input({ capacity: 3, sessionRules: rule(3, DEADLINE) }), theo);
    store.state.tickets.push({ id: "t1", eventId: ev.id, userId: nina, status: "pending", amountCents: 500, currency: "usd", checkoutSessionId: null, paymentIntentId: null,
      expiresAt: iso(Date.now() + 20 * 60_000), createdAt: iso(Date.now()), paidAt: null, refundedAt: null });
    store.state.tickets.push({ id: "t2", eventId: ev.id, userId: maya, status: "pending", amountCents: 500, currency: "usd", checkoutSessionId: null, paymentIntentId: null,
      expiresAt: iso(Date.now() - 60_000), createdAt: iso(Date.now()), paidAt: null, refundedAt: null });
    expect((await repo.events.get(ev.id, null))?.readiness).toMatchObject({ going: 1, capacity: 3, spotsOpen: 1, minAttendance: 3, moreNeeded: 2, waitlist: 0, decision: "open" });
  });

  it("decides at the deadline exactly as the database does", async () => {
    const { repo, store } = setup();
    const below = await repo.events.create(input({ sessionRules: rule(4, DEADLINE) }), theo);
    const met = await repo.events.create(input({ sessionRules: rule(2, DEADLINE) }), theo);
    const confirmed = await repo.events.create(input({ sessionRules: rule(4, DEADLINE) }), theo);
    const plain = await repo.events.create(input(), theo);
    await repo.events.join(nina, below.id);
    await repo.events.join(nina, met.id);
    await expect(repo.events.confirmSession(nina, confirmed.id)).rejects.toThrow("That event isn't available");
    await repo.events.confirmSession(theo, confirmed.id);
    expect(await repo.events.decideSessions(iso(DEADLINE - 1000))).toBe(0);
    expect(await repo.events.decideSessions(iso(DEADLINE))).toBe(2);
    const get = async (id: string) => (await repo.events.get(id, theo))!;
    expect(await get(below.id)).toMatchObject({ status: "cancelled", cancelReason: "below_minimum", decision: "not_happening" });
    expect(await get(met.id)).toMatchObject({ status: "published", decision: "happening" });
    expect(await get(confirmed.id)).toMatchObject({ status: "published", decision: "happening" });
    expect(await get(plain.id)).toMatchObject({ status: "published", decision: "open" });
    const told = store.state.notifications.filter((n) => n.type === "event_not_happening");
    expect(told.map((n) => n.userId).sort()).toEqual([theo, nina].sort());
    expect(told.every((n) => n.actorId === null && n.subjectId === below.id && n.dedupeKey === `event_not_happening:${below.id}`)).toBe(true);
    // A re-run decides nothing and tells nobody again.
    expect(await repo.events.decideSessions(iso(DEADLINE + 3_600_000))).toBe(0);
    expect(store.state.notifications.filter((n) => n.type === "event_not_happening").length).toBe(2);
  });

  it("a host cancellation records its reason", async () => {
    const { repo } = setup();
    const ev = await repo.events.create(input(), theo);
    await repo.events.cancel(ev.id, theo);
    expect(await repo.events.get(ev.id, theo)).toMatchObject({ status: "cancelled", cancelReason: "host", decision: "not_happening" });
  });
});
