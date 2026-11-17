/**
 * Migration 0054 (4.0 §3, §4, §8, §10; Amendment A1.4; revision 3 preflight
 * items 2 and 3): recurring series. Logic and RLS in PGlite, on the real SQL.
 * What two connections do at once is in tests/event-series-pg.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { addDays, localDateOf, occurrenceWindow, seriesDates, type SeriesRule } from "../packages/shared/src/series";
import { zonedTimeToUtc } from "../packages/shared/src/timezone";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [dev, maya, theo, jules, lena, nina, mo] = ["dev", "maya_r", "theo", "jules", "lena", "nina", "mo_moderator"].map(user);
const NY = "America/New_York";
const RULE: SeriesRule = { freq: "weekly", interval: 1, weekdays: [2, 4], start_local: "19:00", duration_minutes: 90 };
const PRICE = 1500;
const MIGRATION = readFileSync(path.join(__dirname, "../supabase/migrations/0054_event_series.sql"), "utf8");

type Occ = { id: string; series_local_date: string; starts_at: Date; ends_at: Date | null; status: string; overridden: string[]; title: string; capacity: number | null; decision_deadline: Date | null; cancel_reason: string | null; price_cents: number | null };

describe("0054: recurring series (PGlite)", () => {
  let db: PGlite;
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
    await db.exec("set role service_role");
    try { return (await db.query<T>(sql, p)).rows; } finally { await db.exec("reset role"); }
  };
  const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.query<T>(q, p).then((r) => r.rows);
  const today = () => localDateOf(Date.now(), NY);
  const template = (over: Record<string, unknown> = {}) => ({
    title: "Tuesday and Thursday run", description: "An easy 5k loop from the park gate; all paces welcome.", category_slug: "pickup-sports",
    location_name: "Goodale Park gate", lat: 39.97, lng: -83.0, time_zone: NY, rule: RULE, tags: ["pickup-sports"], capacity: 10, ...over,
  });
  const createSeries = async (owner: string, over: Record<string, unknown> = {}) =>
    (await as<{ id: string }>(owner, "select public.create_event_series($1::jsonb) as id", [JSON.stringify(template(over))]))[0].id;
  const occurrences = (series: string) => sql<Occ>(
    "select id, series_local_date::text as series_local_date, starts_at, ends_at, status, overridden, title, capacity, decision_deadline, cancel_reason, price_cents from public.events where series_id = $1 order by series_local_date", [series]);
  const generate = async (now?: string, series?: string) => Number((await service<{ n: number }>("select public.generate_series_occurrences($1, $2) as n", [series ?? null, now ?? null]))[0].n);
  const expectedDates = (startsOn: string, now: number, rule = RULE) => {
    const from = localDateOf(now, NY);
    return seriesDates(rule, startsOn, from, addDays(from, 28)).filter((d) => occurrenceWindow(d, rule, NY).startsAt.getTime() > now);
  };
  const key = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const attempt = (run: () => Promise<unknown>) => run().then(() => "ok", key);
  const join = (who: string, event: string) => attempt(() => as(who, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]));
  /** An occurrence that has ended, for attendance: moved into the past without the guards that stop a person doing that. */
  const endOccurrence = async (event: string) => {
    await db.exec("alter table public.events disable trigger guard_owner_event_change; alter table public.events disable trigger events_a_lock_actor");
    try { await sql("update public.events set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour', decision_deadline = null where id = $1", [event]); }
    finally { await db.exec("alter table public.events enable trigger guard_owner_event_change; alter table public.events enable trigger events_a_lock_actor"); }
  };

  beforeAll(async () => { db = await createSeededDb(); }, 120_000);
  afterAll(async () => { await db?.close(); });

  describe("generation", () => {
    it("creates the series, its owner row and tags, and the first four weeks of occurrences the way a one-off event is created", async () => {
      const now = Date.now();
      const id = await createSeries(dev, { decision_lead_minutes: 120, min_attendance: 3 });
      const [s] = await sql<{ owner_id: string; status: string; rule_version: number; starts_on: string; time_zone: string }>("select owner_id, status, rule_version, starts_on::text as starts_on, time_zone from public.event_series where id = $1", [id]);
      expect(s).toMatchObject({ owner_id: dev, status: "active", rule_version: 1, starts_on: today(), time_zone: NY });
      expect(await sql("select user_id, role from public.event_series_hosts where series_id = $1", [id])).toEqual([{ user_id: dev, role: "owner" }]);
      expect(await sql("select interest_slug from public.event_series_tags where series_id = $1", [id])).toEqual([{ interest_slug: "pickup-sports" }]);
      const occ = await occurrences(id);
      const dates = expectedDates(today(), now);
      expect(occ.map((o) => o.series_local_date)).toEqual(dates);
      expect(occ.length).toBeGreaterThanOrEqual(7);
      for (const o of occ) {
        const w = occurrenceWindow(o.series_local_date, RULE, NY);
        expect(o.starts_at.getTime()).toBe(w.startsAt.getTime());
        expect(o.ends_at!.getTime()).toBe(w.endsAt.getTime());
        expect(o.decision_deadline!.getTime()).toBe(w.startsAt.getTime() - 120 * 60_000);
        expect(o.status).toBe("published");
        expect(o.overridden).toEqual([]);
      }
      const [row] = await sql<{ creator_id: string; time_zone: string; min_attendance: number; capacity: number; tags: string[]; going: string[]; members: string[]; messages: number }>(`
        select e.creator_id, e.time_zone, e.min_attendance, e.capacity,
          array(select interest_slug from public.event_tags t where t.event_id = e.id) as tags,
          array(select user_id from public.event_attendees a where a.event_id = e.id) as going,
          array(select m.user_id from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.event_id = e.id) as members,
          (select count(*)::int from public.messages m join public.conversations c on c.id = m.conversation_id where c.event_id = e.id) as messages
        from public.events e where e.id = $1`, [occ[0].id]);
      expect(row).toEqual({ creator_id: dev, time_zone: NY, min_attendance: 3, capacity: 10, tags: ["pickup-sports"], going: [dev], members: [dev], messages: 0 });
    });

    it("counts one 'events' rate-limit hit for the series, not one per occurrence", async () => {
      await sql("delete from public.rate_limit_counters where user_id = $1", [theo]);
      await createSeries(theo);
      expect(await sql("select action, count from public.rate_limit_counters where user_id = $1", [theo])).toEqual([{ action: "events", count: 1 }]);
    });

    it("is idempotent: a second run creates nothing; a later run adds only the dates that entered the horizon; no date twice", async () => {
      const id = await createSeries(dev);
      const before = (await occurrences(id)).map((o) => o.series_local_date);
      expect(await generate(undefined, id)).toBe(0);
      const later = Date.now() + 7 * 86_400_000;
      const added = await generate(new Date(later).toISOString(), id);
      const after = (await occurrences(id)).map((o) => o.series_local_date);
      const expected = Array.from(new Set([...before, ...expectedDates(today(), later)])).sort();
      expect(after).toEqual(expected);
      expect(added).toBe(expected.length - before.length);
      expect(added).toBeGreaterThan(0);
      expect(new Set(after).size).toBe(after.length);
    });

    it("never recreates a cancelled date, and the next occurrence is untouched", async () => {
      const id = await createSeries(dev);
      const [first, second] = await occurrences(id);
      await as(dev, "select public.cancel_occurrence($1)", [first.id]);
      expect(await generate(new Date(Date.now() + 3 * 86_400_000).toISOString(), id)).toBeGreaterThanOrEqual(0);
      const occ = await occurrences(id);
      expect(occ.find((o) => o.id === first.id)).toMatchObject({ status: "cancelled", cancel_reason: "host", series_local_date: first.series_local_date });
      expect(occ.filter((o) => o.series_local_date === first.series_local_date)).toHaveLength(1);
      expect(occ.find((o) => o.id === second.id)).toMatchObject({ status: "published" });
    });

    it("generates nothing while paused, and catches up when resumed", async () => {
      const id = await createSeries(dev);
      await as(dev, "select public.set_series_status($1, 'paused')", [id]);
      const n = (await occurrences(id)).length;
      expect(await generate(new Date(Date.now() + 10 * 86_400_000).toISOString(), id)).toBe(0);
      expect((await occurrences(id)).length).toBe(n);
      await as(dev, "select public.set_series_status($1, 'active')", [id]);
      expect(await generate(new Date(Date.now() + 10 * 86_400_000).toISOString(), id)).toBeGreaterThan(0);
    });

    it("a new occurrence whose decision deadline would already have passed gets no deadline", async () => {
      // A lead of a week: every occurrence inside the next week starts less than a week away.
      const id = await createSeries(dev, { decision_lead_minutes: 7 * 24 * 60, min_attendance: 3 });
      const occ = await occurrences(id);
      const soon = occ.filter((o) => o.starts_at.getTime() - 7 * 24 * 3_600_000 <= Date.now());
      const later = occ.filter((o) => o.starts_at.getTime() - 7 * 24 * 3_600_000 > Date.now());
      expect(soon.length).toBeGreaterThan(0);
      expect(later.length).toBeGreaterThan(0);
      for (const o of soon) expect(o.decision_deadline).toBeNull();
      for (const o of later) expect(o.decision_deadline!.getTime()).toBe(o.starts_at.getTime() - 7 * 24 * 3_600_000);
    });

    it("the service run is the only caller; a signed-in user is refused", async () => {
      await expect(as(dev, "select public.generate_series_occurrences()")).rejects.toThrow(/permission denied|Service only/);
    });

    it("refuses a bad rule, a bad zone, and a start in the past", async () => {
      await expect(createSeries(dev, { rule: { ...RULE, weekdays: [] } })).rejects.toThrow(/events:bad_series_rule/);
      await expect(createSeries(dev, { rule: { ...RULE, weekdays: [1, 1] } })).rejects.toThrow(/events:bad_series_rule/);
      await expect(createSeries(dev, { rule: { ...RULE, interval: 5 } })).rejects.toThrow(/events:bad_series_rule/);
      await expect(createSeries(dev, { rule: { ...RULE, start_local: "25:00" } })).rejects.toThrow(/events:bad_series_rule/);
      await expect(createSeries(dev, { rule: { ...RULE, extra: 1 } })).rejects.toThrow(/events:bad_series_rule/);
      await expect(createSeries(dev, { time_zone: "EST5EDT" })).rejects.toThrow(/events:bad_time_zone/);
      await expect(createSeries(dev, { starts_on: addDays(today(), -1) })).rejects.toThrow(/events:bad_series_rule/);
    });
  });

  describe("DST (4.0 §10, D-G)", () => {
    it("SQL and TypeScript agree on every half hour of the transition weeks in three zones, fall-back resolving to the first instant", async () => {
      const zones = ["America/New_York", "Europe/London", "Australia/Sydney"];
      const weeks = ["2026-03-06", "2026-10-30", "2027-03-12", "2027-10-29", "2026-03-27", "2026-10-23", "2026-04-03", "2026-10-02"];
      let checked = 0;
      for (const zone of zones) for (const start of weeks) for (let d = 0; d < 4; d++) for (const time of ["00:30", "01:30", "02:30", "03:30", "19:00"]) {
        const date = addDays(start, d);
        const [{ at }] = await sql<{ at: Date }>("select findmaxxing_private.local_to_instant($1::date, $2::time, $3) as at", [date, time, zone]);
        expect({ zone, date, time, at: at.toISOString() }).toEqual({ zone, date, time, at: zonedTimeToUtc(date, time, zone).toISOString() });
        checked++;
      }
      expect(checked).toBe(zones.length * weeks.length * 4 * 5);
      // The two named vectors: the gap, and the first instant of the repeated hour.
      expect((await sql<{ at: Date }>("select findmaxxing_private.local_to_instant('2026-03-08', '02:30', 'America/New_York') as at"))[0].at.toISOString()).toBe("2026-03-08T07:30:00.000Z");
      expect((await sql<{ at: Date }>("select findmaxxing_private.local_to_instant('2026-11-01', '01:30', 'America/New_York') as at"))[0].at.toISOString()).toBe("2026-11-01T05:30:00.000Z");
      // Bare `at time zone` picks the second instant, which is why the generator does not use it.
      expect((await sql<{ at: Date }>("select ('2026-11-01 01:30'::timestamp at time zone 'America/New_York') as at"))[0].at.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    });

    it("occurrences across a change keep their local time; the UTC instant shifts", async () => {
      // Sundays at 19:00 New York around 2027-03-14 (spring) and 2027-11-07 (fall), generated with a frozen clock.
      const rule: SeriesRule = { ...RULE, weekdays: [7] };
      const spring = await createSeries(dev, { rule, starts_on: "2027-03-07" });
      await sql("delete from public.events where series_id = $1", [spring]);
      await generate("2027-03-06T12:00:00Z", spring);
      const occ = await occurrences(spring);
      expect(occ.map((o) => [o.series_local_date, o.starts_at.toISOString()])).toEqual([
        ["2027-03-07", "2027-03-08T00:00:00.000Z"], ["2027-03-14", "2027-03-14T23:00:00.000Z"], ["2027-03-21", "2027-03-21T23:00:00.000Z"], ["2027-03-28", "2027-03-28T23:00:00.000Z"],
      ]);
      // The gap itself, and the repeated hour, on the day of each change.
      const gap = await createSeries(dev, { rule: { ...rule, start_local: "02:30" }, starts_on: "2027-03-14" });
      await sql("delete from public.events where series_id = $1", [gap]);
      await generate("2027-03-13T12:00:00Z", gap);
      expect((await occurrences(gap))[0]).toMatchObject({ series_local_date: "2027-03-14" });
      expect((await occurrences(gap))[0].starts_at.toISOString()).toBe("2027-03-14T07:30:00.000Z");
      const repeat = await createSeries(dev, { rule: { ...rule, start_local: "01:30" }, starts_on: "2027-11-07" });
      await sql("delete from public.events where series_id = $1", [repeat]);
      await generate("2027-11-06T12:00:00Z", repeat);
      expect((await occurrences(repeat))[0].starts_at.toISOString()).toBe("2027-11-07T05:30:00.000Z");
    });
  });

  describe("hosts (preflight item 3)", () => {
    it("a backup host edits and cancels through the functions; a direct write is denied; revocation is immediate", async () => {
      const id = await createSeries(dev);
      const [a, b, c] = await occurrences(id);
      await expect(as(maya, "select public.update_occurrence($1, $2::jsonb)", [a.id, JSON.stringify({ title: "Backup edit" })])).rejects.toThrow(/events:not_found/);
      await expect(as(theo, "select public.add_series_host($1, $2)", [id, maya])).rejects.toThrow(/events:not_found/);
      await as(dev, "select public.add_series_host($1, $2)", [id, maya]);
      expect(await sql("select user_id, role from public.event_series_hosts where series_id = $1 order by role", [id])).toEqual([{ user_id: maya, role: "backup" }, { user_id: dev, role: "owner" }]);
      // Through the function: allowed, and recorded as an override.
      await as(maya, "select public.update_occurrence($1, $2::jsonb)", [a.id, JSON.stringify({ title: "Backup edit" })]);
      expect((await occurrences(id)).find((o) => o.id === a.id)).toMatchObject({ title: "Backup edit", overridden: ["details"] });
      await as(maya, "select public.cancel_occurrence($1)", [b.id]);
      expect((await occurrences(id)).find((o) => o.id === b.id)).toMatchObject({ status: "cancelled", cancel_reason: "host" });
      await as(maya, "select public.set_session_rules($1, 4, null, 'unconfirmed')", [c.id]);
      expect(await sql("select min_attendance, venue_status, overridden from public.events where id = $1", [c.id])).toEqual([{ min_attendance: 4, venue_status: "unconfirmed", overridden: ["session_rules"] }]);
      // Directly: the row is not theirs to update (RLS), and the typed update function refuses.
      await as(maya, "update public.events set title = 'Direct backup edit' where id = $1", [c.id]);
      expect((await occurrences(id)).find((o) => o.id === c.id)!.title).not.toBe("Direct backup edit");
      await expect(as(maya, "update public.events set title = 'Direct backup edit' where id = $1 returning id", [c.id])).resolves.toEqual([]);
      await expect(as(maya, `select public.update_event_with_tags($1, 'Direct backup edit', $2, null, 'Goodale Park gate', null, 39.97, -83.0, $3, $4, 'pickup-sports', 10, '{}', null, null, null)`,
        [c.id, "An easy 5k loop from the park gate; all paces welcome.", c.starts_at.toISOString(), c.ends_at!.toISOString()])).rejects.toThrow(/You do not own this event/);
      await expect(as(maya, "delete from public.events where id = $1 returning id", [c.id])).resolves.toEqual([]);
      // Owner-only settings stay the owner's.
      await expect(as(maya, "select public.end_event_series($1)", [id])).rejects.toThrow(/events:not_found/);
      await expect(as(maya, "select public.add_series_host($1, $2)", [id, theo])).rejects.toThrow(/events:not_found/);
      // Revoked: refused at once, through the function and by the guard.
      await as(dev, "select public.remove_series_host($1, $2)", [id, maya]);
      await expect(as(maya, "select public.update_occurrence($1, $2::jsonb)", [c.id, JSON.stringify({ title: "After revocation" })])).rejects.toThrow(/events:not_found/);
      await expect(as(maya, "select public.cancel_occurrence($1)", [c.id])).rejects.toThrow(/events:not_found/);
      await expect(as(maya, "select public.set_session_rules($1, 4, null, 'confirmed')", [c.id])).rejects.toThrow(/events:not_found/);
    });

    it("the guard rechecks the role itself: with the function's own check removed, a revoked host is still refused", async () => {
      const id = await createSeries(dev);
      const [a] = await occurrences(id);
      await as(dev, "select public.add_series_host($1, $2)", [id, maya]);
      await as(dev, "select public.remove_series_host($1, $2)", [id, maya]);
      const guard = "if not found or e.series_id is null or not findmaxxing_private.can_host_event(p_event, auth.uid()) then";
      expect(MIGRATION).toContain(guard);
      const from = MIGRATION.indexOf("create or replace function findmaxxing_private.lock_occurrence_for_host(");
      const fn = MIGRATION.slice(from, MIGRATION.indexOf("end $$;", from) + "end $$;".length);
      await db.exec(fn.replace(guard, "if not found then"));
      try {
        await expect(as(maya, "select public.update_occurrence($1, $2::jsonb)", [a.id, JSON.stringify({ title: "Revoked, no function check" })])).rejects.toThrow(/You do not own this event/);
        await expect(as(maya, "select public.cancel_occurrence($1)", [a.id])).rejects.toThrow(/You do not own this event/);
        expect((await occurrences(id)).find((o) => o.id === a.id)).toMatchObject({ title: "Tuesday and Thursday run", status: "published" });
      } finally {
        await db.exec(fn);
      }
    });

    it("the owner's own direct edits and cancellations keep working as before, and series columns are not client-writable", async () => {
      const id = await createSeries(dev);
      const [a, b] = await occurrences(id);
      await as(dev, "update public.events set title = 'Owner direct edit' where id = $1", [a.id]);
      expect((await occurrences(id)).find((o) => o.id === a.id)).toMatchObject({ title: "Owner direct edit", overridden: [] });
      await as(dev, "update public.events set status = 'cancelled' where id = $1", [b.id]);
      expect((await occurrences(id)).find((o) => o.id === b.id)).toMatchObject({ status: "cancelled", cancel_reason: "host" });
      await expect(as(dev, "update public.events set series_local_date = '2030-01-01' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
      await expect(as(dev, "update public.events set overridden = '{schedule}' where id = $1", [a.id])).rejects.toThrow(/permission denied/);
      await expect(as(dev, "insert into public.event_series_hosts (series_id, user_id, role) values ($1, $2, 'backup')", [id, theo])).rejects.toThrow(/permission denied/);
      await expect(as(dev, "update public.event_series set title = 'x' where id = $1", [id])).rejects.toThrow(/permission denied/);
    });

    it("a suspended or closing person cannot be added as a host, and a closing host is refused", async () => {
      const id = await createSeries(dev);
      await sql("insert into public.suspensions (user_id, reason) values ($1, 'test') on conflict do nothing", [nina]);
      await expect(as(dev, "select public.add_series_host($1, $2)", [id, nina])).rejects.toThrow(/events:bad_series/);
      await sql("delete from public.suspensions where user_id = $1", [nina]);
      await as(dev, "select public.add_series_host($1, $2)", [id, jules]);
      await service("select public.prepare_account_deletion($1)", [jules]);
      const [a] = await occurrences(id);
      await expect(as(jules, "select public.update_occurrence($1, $2::jsonb)", [a.id, JSON.stringify({ title: "x" })])).rejects.toThrow(/account_deletion_in_progress/);
      await sql("delete from public.account_deletion_jobs where user_id = $1", [jules]);
    });
  });

  describe("edit this, edit future, cancel one, end (4.0 §8, A1.4)", () => {
    it("edit-this records overrides; edit-future applies the template from that date and skips overridden fields", async () => {
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const [a, b, c] = occ;
      await as(dev, "select public.update_occurrence($1, $2::jsonb)", [c.id, JSON.stringify({ title: "Special session", capacity: 12 })]);
      const result = (await as<{ r: { moved: string[]; kept: string[]; deleted: number; created: number; capacity_kept: string[]; rule_version: number } }>(
        dev, "select public.update_series_from($1, $2::jsonb) as r", [b.id, JSON.stringify({ title: "New title", capacity: 8, description: "A new description for the whole series from here on." })]))[0].r;
      expect(result).toMatchObject({ moved: [], kept: [], deleted: 0, created: 0, capacity_kept: [], rule_version: 1 });
      const after = await occurrences(id);
      expect(after.find((o) => o.id === a.id)).toMatchObject({ title: "Tuesday and Thursday run", capacity: 10 });
      expect(after.find((o) => o.id === b.id)).toMatchObject({ title: "New title", capacity: 8, overridden: [] });
      expect(after.find((o) => o.id === c.id)).toMatchObject({ title: "Special session", capacity: 12, overridden: ["details", "capacity"] });
      for (const o of after.slice(3)) expect(o).toMatchObject({ title: "New title", capacity: 8 });
      expect(await sql("select title, capacity from public.event_series where id = $1", [id])).toEqual([{ title: "New title", capacity: 8 }]);
      expect(after.map((o) => o.id).sort()).toEqual(occ.map((o) => o.id).sort());
    });

    it("a template capacity that would go below an occurrence's seats taken leaves that occurrence alone and reports it (A1.2 rule 4)", async () => {
      const id = await createSeries(dev);
      const [a, b] = await occurrences(id);
      expect(await join(theo, b.id)).toBe("ok");
      expect(await join(jules, b.id)).toBe("ok");
      const result = (await as<{ r: { capacity_kept: string[] } }>(dev, "select public.update_series_from($1, $2::jsonb) as r", [a.id, JSON.stringify({ capacity: 2 })]))[0].r;
      expect(result.capacity_kept).toEqual([b.id]);
      const after = await occurrences(id);
      expect(after.find((o) => o.id === a.id)!.capacity).toBe(2);
      expect(after.find((o) => o.id === b.id)!.capacity).toBe(10);
    });

    it("a schedule change moves committed occurrences in place with stable ids, deletes uncommitted ones, and regenerates", async () => {
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const tue = occ.find((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 2 && o !== occ[0])!;
      const thu = occ.find((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 4 && o.series_local_date > tue.series_local_date)!;
      expect(await join(theo, tue.id)).toBe("ok");
      const [{ conversation_id }] = await sql<{ conversation_id: string }>("select id as conversation_id from public.conversations where event_id = $1", [thu.id]);
      await as(dev, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'Bring a headlamp')", [conversation_id]);
      const uncommitted = occ.filter((o) => o.id !== tue.id && o.id !== thu.id && o.series_local_date >= occ[0].series_local_date).map((o) => o.id);
      const rule: SeriesRule = { ...RULE, weekdays: [3], start_local: "18:30" };
      const result = (await as<{ r: { moved: string[]; kept: string[]; deleted: number; created: number; rule_version: number } }>(
        dev, "select public.update_series_from($1, $2::jsonb) as r", [occ[0].id, JSON.stringify({ rule })]))[0].r;
      expect(result.rule_version).toBe(2);
      expect(result.kept).toEqual([]);
      expect(result.moved.sort()).toEqual([tue.id, thu.id].sort());
      expect(result.deleted).toBe(uncommitted.length);
      const after = await occurrences(id);
      expect(new Set(after.map((o) => o.series_local_date)).size).toBe(after.length);
      for (const o of after) {
        expect(new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay()).toBe(3);
        expect(o.starts_at.getTime()).toBe(occurrenceWindow(o.series_local_date, rule, NY).startsAt.getTime());
      }
      const movedTue = after.find((o) => o.id === tue.id)!;
      const movedThu = after.find((o) => o.id === thu.id)!;
      expect(Math.abs(new Date(movedTue.series_local_date).getTime() - new Date(tue.series_local_date).getTime()) / 86_400_000).toBeLessThanOrEqual(6);
      expect(movedTue.series_local_date).not.toBe(movedThu.series_local_date);
      expect(await sql("select user_id from public.event_attendees where event_id = $1 order by user_id", [tue.id])).toEqual([{ user_id: dev }, { user_id: theo }].sort((x, y) => x.user_id.localeCompare(y.user_id)));
      expect(await sql("select body from public.messages where conversation_id = $1", [conversation_id])).toEqual([{ body: "Bring a headlamp" }]);
      for (const gone of uncommitted) expect(after.find((o) => o.id === gone)).toBeUndefined();
      expect(await sql("select count(*)::int as n from public.conversations where event_id = any($1)", [uncommitted])).toEqual([{ n: 0 }]);
      expect(after.map((o) => o.series_local_date)).toEqual(Array.from(new Set([...after.map((o) => o.series_local_date)])).sort());
      // Occurrences before the effective date are untouched; dates after it exist for every rule date in the horizon.
      const dates = expectedDates(today(), Date.now(), rule);
      for (const d of dates) expect(after.some((o) => o.series_local_date === d)).toBe(true);
    });

    it("an occurrence with no safe destination is kept exactly as it is and reported; a cancelled date is never reused (A1.6 case 14)", async () => {
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const tues = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 2);
      const thus = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 4);
      // Both Tuesdays around this Thursday are committed, so the Thursday has nowhere within six days to go.
      const thu = thus.find((t) => tues.some((u) => u.series_local_date < t.series_local_date) && tues.some((u) => u.series_local_date > t.series_local_date))!;
      const before = tues.filter((u) => u.series_local_date < thu.series_local_date).pop()!;
      const nextTue = tues.find((u) => u.series_local_date > thu.series_local_date)!;
      for (const o of [before, nextTue, thu]) expect(await join(theo, o.id)).toBe("ok");
      // A cancelled Tuesday further on: its date must not be used by anyone.
      const cancelled = tues.find((u) => u.series_local_date > nextTue.series_local_date)!;
      await as(dev, "select public.cancel_occurrence($1)", [cancelled.id]);
      const rule: SeriesRule = { ...RULE, weekdays: [2] };
      const result = (await as<{ r: { moved: string[]; kept: string[]; deleted: number } }>(dev, "select public.update_series_from($1, $2::jsonb) as r", [occ[0].id, JSON.stringify({ rule })]))[0].r;
      expect(result.kept).toEqual([thu.id]);
      const after = await occurrences(id);
      const keptRow = after.find((o) => o.id === thu.id)!;
      expect(keptRow).toMatchObject({ series_local_date: thu.series_local_date, overridden: ["schedule"], status: "published" });
      expect(keptRow.starts_at.getTime()).toBe(thu.starts_at.getTime());
      expect(after.find((o) => o.id === cancelled.id)).toMatchObject({ status: "cancelled", series_local_date: cancelled.series_local_date });
      expect(after.filter((o) => o.series_local_date === cancelled.series_local_date)).toHaveLength(1);
      expect(new Set(after.map((o) => o.series_local_date)).size).toBe(after.length);
      for (const o of [before, nextTue]) expect(after.find((x) => x.id === o.id)).toMatchObject({ series_local_date: o.series_local_date, overridden: [] });
    });

    it("two committed occurrences and one date: the overridden one stays, the other takes its next nearest date (A1.6 case 19)", async () => {
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const thus = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 4);
      const tues = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 2);
      // A Thursday the host already moved one-off onto the following Saturday (keeps its Thursday date as its slot), and
      // the Tuesday before it, both committed. New rule: Saturdays. The Tuesday's nearest Saturday is that same one.
      const thu = thus.find((t) => tues.some((u) => u.series_local_date < t.series_local_date && t.series_local_date <= addDays(u.series_local_date, 2)))!;
      const tue = tues.filter((u) => u.series_local_date < thu.series_local_date).pop()!;
      const sat = addDays(thu.series_local_date, 2);
      await as(dev, "select public.update_occurrence($1, $2::jsonb)", [thu.id, JSON.stringify({ starts_at: occurrenceWindow(sat, RULE, NY).startsAt.toISOString(), ends_at: occurrenceWindow(sat, RULE, NY).endsAt.toISOString() })]);
      expect(await join(theo, tue.id)).toBe("ok");
      const rule: SeriesRule = { ...RULE, weekdays: [6] };
      const result = (await as<{ r: { moved: string[]; kept: string[] } }>(dev, "select public.update_series_from($1, $2::jsonb) as r", [occ[0].id, JSON.stringify({ rule })]))[0].r;
      const after = await occurrences(id);
      expect(after.find((o) => o.id === thu.id)).toMatchObject({ series_local_date: thu.series_local_date, overridden: ["schedule"] });
      const movedTue = after.find((o) => o.id === tue.id)!;
      expect(new Date(`${movedTue.series_local_date}T12:00:00Z`).getUTCDay()).toBe(6);
      expect(movedTue.series_local_date).not.toBe(thu.series_local_date);
      expect(Math.abs(new Date(movedTue.series_local_date).getTime() - new Date(tue.series_local_date).getTime()) / 86_400_000).toBeLessThanOrEqual(6);
      expect(result.moved).toContain(tue.id);
      expect(new Set(after.map((o) => o.series_local_date)).size).toBe(after.length);
    });

    it("a date that becomes retained during assignment cannot have been given to another occurrence (A1.4 step 5)", async () => {
      // A movable occurrence either keeps its own date (step 4, when that date is a candidate) or its date is not a
      // candidate at all; so when it has no destination and its date becomes retained, no earlier assignment used
      // that date. The recompute is therefore a no-op by construction. Shown here: the kept one is reported, every
      // other assignment is unchanged from a plan without it, and the result is conflict-free.
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const thus = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 4);
      const tues = occ.filter((o) => new Date(`${o.series_local_date}T12:00:00Z`).getUTCDay() === 2);
      const thu = thus.find((t) => tues.some((u) => u.series_local_date < t.series_local_date) && tues.some((u) => u.series_local_date > t.series_local_date))!;
      const around = [tues.filter((u) => u.series_local_date < thu.series_local_date).pop()!, tues.find((u) => u.series_local_date > thu.series_local_date)!];
      for (const o of [...around, thu]) expect(await join(theo, o.id)).toBe("ok");
      const rule: SeriesRule = { ...RULE, weekdays: [2] };
      const result = (await as<{ r: { moved: string[]; kept: string[] } }>(dev, "select public.update_series_from($1, $2::jsonb) as r", [occ[0].id, JSON.stringify({ rule })]))[0].r;
      expect(result.kept).toEqual([thu.id]);
      const after = await occurrences(id);
      for (const o of around) expect(after.find((x) => x.id === o.id)!.series_local_date).toBe(o.series_local_date);
      expect(after.find((x) => x.id === thu.id)!.series_local_date).toBe(thu.series_local_date);
      expect(new Set(after.map((o) => o.series_local_date)).size).toBe(after.length);
    });

    it("an occurrence with one message survives a schedule change with the same id; an empty one is deleted (A1.4 rule c)", async () => {
      const id = await createSeries(dev);
      const [, b, c] = await occurrences(id);
      const [{ cid }] = await sql<{ cid: string }>("select id as cid from public.conversations where event_id = $1", [b.id]);
      await as(dev, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'See you there')", [cid]);
      await as(dev, "select public.update_series_from($1, $2::jsonb)", [b.id, JSON.stringify({ rule: { ...RULE, start_local: "20:00" } })]);
      const after = await occurrences(id);
      expect(after.find((o) => o.id === b.id)).toBeDefined();
      expect(after.find((o) => o.id === c.id)).toBeUndefined();
      expect(await sql("select body from public.messages where conversation_id = $1", [cid])).toEqual([{ body: "See you there" }]);
    });

    it("a priced occurrence, one with a ticket, one that is decided, and one with attendance are all committed", async () => {
      const id = await createSeries(dev);
      const [a, b, c, d] = await occurrences(id);
      await service("select public.set_host_account($1, 'acct_dev', true)", [dev]);
      await as(dev, "select public.set_event_price($1, $2)", [a.id, PRICE]);
      await as(dev, "select public.set_event_price($1, $2)", [b.id, PRICE]);
      await as(theo, "select * from public.reserve_ticket($1)", [b.id]);
      await as(dev, "select public.confirm_session($1)", [c.id]);
      await endOccurrence(d.id);
      await as(dev, "select public.record_attendance($1, $2, true)", [d.id, dev]);
      for (const o of [a, b, c, d]) {
        expect((await sql<{ c: boolean }>("select findmaxxing_private.occurrence_committed($1, clock_timestamp()) as c", [o.id]))[0].c).toBe(true);
      }
      const [, , , , e] = await occurrences(id);
      expect((await sql<{ c: boolean }>("select findmaxxing_private.occurrence_committed($1, clock_timestamp()) as c", [e.id]))[0].c).toBe(false);
    });

    it("ending the series cancels later occurrences with series_ended; a paid ticket on one is queued for refund; nothing more is generated", async () => {
      const id = await createSeries(dev);
      const occ = await occurrences(id);
      const last = occ[occ.length - 1];
      await service("select public.set_host_account($1, 'acct_dev', true)", [dev]);
      await as(dev, "select public.set_event_price($1, $2)", [last.id, PRICE]);
      const [{ ticket_id }] = await as<{ ticket_id: string }>(theo, "select * from public.reserve_ticket($1)", [last.id]);
      await sql("update public.tickets set checkout_session_id = 'cs_end' where id = $1", [ticket_id]);
      expect((await service<{ r: string }>("select public.confirm_ticket('cs_end', 'pi_end', $1) as r", [PRICE]))[0].r).toBe("confirmed");
      const cutoff = occ[2].series_local_date;
      const n = (await as<{ n: number }>(dev, "select public.end_event_series($1, $2::date) as n", [id, cutoff]))[0].n;
      const after = await occurrences(id);
      expect(n).toBe(occ.filter((o) => o.series_local_date > cutoff).length);
      for (const o of after) {
        if (o.series_local_date > cutoff) expect(o).toMatchObject({ status: "cancelled", cancel_reason: "series_ended" });
        else expect(o).toMatchObject({ status: "published" });
      }
      expect(await sql("select status, ends_on::text as ends_on from public.event_series where id = $1", [id])).toEqual([{ status: "ended", ends_on: cutoff }]);
      expect(await sql("select status from public.tickets where id = $1", [ticket_id])).toEqual([{ status: "refund_pending" }]);
      expect(await generate(new Date(Date.now() + 14 * 86_400_000).toISOString(), id)).toBe(0);
      expect(await sql("select type, user_id from public.notifications where subject_id = $1 and type = 'event_cancelled'", [last.id])).toEqual([{ type: "event_cancelled", user_id: theo }]);
      await expect(as(dev, "select public.set_series_status($1, 'active')", [id])).rejects.toThrow(/events:closed/);
    });

    it("the existing join rules hold on an occurrence: capacity, full, host exempt from the ticket, priced needs a ticket", async () => {
      const id = await createSeries(dev, { capacity: 2 });
      const [a] = await occurrences(id);
      expect(await join(theo, a.id)).toBe("ok");
      expect(await join(jules, a.id)).toMatch(/This event is full/);
      expect(await as(theo, "delete from public.event_attendees where event_id = $1 and user_id = auth.uid() returning user_id", [a.id])).toEqual([{ user_id: theo }]);
      expect(await join(jules, a.id)).toBe("ok");
    });
  });

  describe("following, attendance, visibility", () => {
    it("following is its own row and never creates an attendee row; others cannot follow for you; a suspended person cannot follow", async () => {
      const id = await createSeries(dev);
      await as(theo, "insert into public.event_series_followers (series_id, user_id) values ($1, auth.uid())", [id]);
      expect(await sql("select user_id from public.event_series_followers where series_id = $1", [id])).toEqual([{ user_id: theo }]);
      expect(await sql("select count(*)::int as n from public.event_attendees a join public.events e on e.id = a.event_id where e.series_id = $1 and a.user_id = $2", [id, theo])).toEqual([{ n: 0 }]);
      await expect(as(jules, "insert into public.event_series_followers (series_id, user_id) values ($1, $2)", [id, theo])).rejects.toThrow(/row-level security/);
      expect(await as(jules, "select user_id from public.event_series_followers where series_id = $1", [id])).toEqual([]);
      expect(await as(theo, "select user_id from public.event_series_followers where series_id = $1", [id])).toEqual([{ user_id: theo }]);
      await sql("insert into public.suspensions (user_id, reason) values ($1, 'test') on conflict do nothing", [nina]);
      await expect(as(nina, "insert into public.event_series_followers (series_id, user_id) values ($1, auth.uid())", [id])).rejects.toThrow(/account_suspended/);
      await sql("delete from public.suspensions where user_id = $1", [nina]);
      await as(theo, "delete from public.event_series_followers where series_id = $1 and user_id = auth.uid()", [id]);
      expect(await sql("select count(*)::int as n from public.event_series_followers where series_id = $1", [id])).toEqual([{ n: 0 }]);
      // No trigger anywhere writes attendees from a follow.
      expect(await sql<{ n: number }>("select count(*)::int as n from pg_trigger where tgrelid = 'public.event_series_followers'::regclass and not tgisinternal and tgname <> 'event_series_followers_block_suspended'")).toEqual([{ n: 0 }]);
    });

    it("attendance is host-recorded after the end, for people who were going, and is refused before the end", async () => {
      const id = await createSeries(dev);
      const [a] = await occurrences(id);
      expect(await join(theo, a.id)).toBe("ok");
      await expect(as(dev, "select public.record_attendance($1, $2, true)", [a.id, theo])).rejects.toThrow(/events:not_ended/);
      await endOccurrence(a.id);
      await as(dev, "select public.record_attendance($1, $2, true)", [a.id, theo]);
      await expect(as(dev, "select public.record_attendance($1, $2, true)", [a.id, jules])).rejects.toThrow(/events:not_attending/);
      await expect(as(theo, "select public.record_attendance($1, $2, true)", [a.id, theo])).rejects.toThrow(/events:not_found/);
      expect(await sql("select user_id, attended from public.event_attendees where event_id = $1 order by user_id", [a.id])).toEqual(
        [{ user_id: dev, attended: null }, { user_id: theo, attended: true }].sort((x, y) => x.user_id.localeCompare(y.user_id)));
      await expect(as(theo, "update public.event_attendees set attended = false where event_id = $1 and user_id = auth.uid() returning user_id", [a.id])).resolves.toEqual([]);
    });

    it("a series and its hosts are visible like an event; a removed one is not; followers see only themselves", async () => {
      const id = await createSeries(dev);
      expect(await as(null, "select id from public.event_series where id = $1", [id])).toEqual([{ id }]);
      expect(await as(theo, "select user_id from public.event_series_hosts where series_id = $1", [id])).toEqual([{ user_id: dev }]);
      expect(await as(null, "select interest_slug from public.event_series_tags where series_id = $1", [id])).toEqual([{ interest_slug: "pickup-sports" }]);
      const [a] = await occurrences(id);
      expect(await as(null, "select series_id, series_local_date::text as d from public.events where id = $1", [a.id])).toEqual([{ series_id: id, d: a.series_local_date }]);
    });

    it("moderation (D-J): removing a series removes its future occurrences; restoring brings exactly those back", async () => {
      const id = await createSeries(dev);
      const [a, b] = await occurrences(id);
      await as(mo, "select * from public.moderate_target('event', $1, 'remove', 'Reported photo')", [a.id]);
      await as(mo, "select * from public.moderate_target('series', $1, 'remove', 'Spam series')", [id]);
      expect(await sql("select status from public.event_series where id = $1", [id])).toEqual([{ status: "removed" }]);
      expect(await as(null, "select id from public.event_series where id = $1", [id])).toEqual([]);
      expect(await as(dev, "select id from public.event_series where id = $1", [id])).toEqual([]);
      const removed = await occurrences(id);
      for (const o of removed) expect(o.status).toBe("removed");
      expect(await sql("select id, removed_with_series from public.events where id in ($1, $2) order by series_local_date", [a.id, b.id])).toEqual([{ id: a.id, removed_with_series: false }, { id: b.id, removed_with_series: true }]);
      await expect(as(dev, "select public.cancel_occurrence($1)", [b.id])).rejects.toThrow(/events:closed/);
      await as(mo, "select * from public.moderate_target('series', $1, 'restore')", [id]);
      expect(await sql("select status from public.event_series where id = $1", [id])).toEqual([{ status: "active" }]);
      const restored = await occurrences(id);
      expect(restored.find((o) => o.id === a.id)!.status).toBe("removed");
      for (const o of restored.filter((x) => x.id !== a.id)) expect(o.status).toBe("published");
      expect(await sql("select count(*)::int as n from public.events where series_id = $1 and removed_with_series", [id])).toEqual([{ n: 0 }]);
      expect(await sql("select target_type, action from public.moderation_actions where target_id = $1 order by created_at", [id])).toEqual([{ target_type: "series", action: "remove" }, { target_type: "series", action: "restore" }]);
    });
  });

  describe("account closure", () => {
    it("closing the owner ends the series, cancels its future occurrences with series_ended, expires holds and stops generation; deletion cascades", async () => {
      const id = await createSeries(lena);
      const occ = await occurrences(id);
      expect(await join(theo, occ[1].id)).toBe("ok");
      await service("select public.prepare_account_deletion($1)", [lena]);
      expect(await sql("select status from public.event_series where id = $1", [id])).toEqual([{ status: "ended" }]);
      for (const o of await occurrences(id)) expect(o).toMatchObject({ status: "cancelled", cancel_reason: "series_ended" });
      expect(await generate(new Date(Date.now() + 10 * 86_400_000).toISOString(), id)).toBe(0);
      expect(await generate(new Date(Date.now() + 10 * 86_400_000).toISOString())).toBeGreaterThanOrEqual(0);
      expect((await occurrences(id)).length).toBe(occ.length);
      await sql("delete from auth.users where id = $1", [lena]);
      await sql("delete from public.profiles where id = $1", [lena]);
      expect(await sql("select count(*)::int as n from public.event_series where id = $1", [id])).toEqual([{ n: 0 }]);
      expect(await sql("select count(*)::int as n from public.events where series_id = $1", [id])).toEqual([{ n: 0 }]);
      expect(await sql("select count(*)::int as n from public.event_series_hosts where series_id = $1", [id])).toEqual([{ n: 0 }]);
    });

    it("a backup host or follower who leaves takes only their own rows with them", async () => {
      const id = await createSeries(dev);
      await as(dev, "select public.add_series_host($1, $2)", [id, nina]);
      await as(nina, "insert into public.event_series_followers (series_id, user_id) values ($1, auth.uid())", [id]);
      await sql("delete from auth.users where id = $1", [nina]);
      await sql("delete from public.profiles where id = $1", [nina]);
      expect(await sql("select user_id from public.event_series_hosts where series_id = $1", [id])).toEqual([{ user_id: dev }]);
      expect(await sql("select count(*)::int as n from public.event_series_followers where series_id = $1", [id])).toEqual([{ n: 0 }]);
      expect((await occurrences(id)).length).toBeGreaterThan(0);
    });
  });

  describe("invariants the migration and the amendment rely on", () => {
    it("every foreign key to events is classified by the committed test (A1.4 rule g)", async () => {
      const rows = await sql<{ t: string }>(`
        select c.conrelid::regclass::text as t from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'public.events'::regclass order by 1`);
      const classified: Record<string, string> = {
        "event_attendees": "rule a (anyone but the owner going); the owner's own row is the generator's",
        "event_tags": "written by the generator; not a commitment",
        "tickets": "rule b",
        "conversations": "the generator's empty conversation; rule c reads its messages",
        "ad_campaigns": "rule g",
      };
      expect(rows.map((r) => r.t).sort()).toEqual(Object.keys(classified).sort());
      expect(await sql<{ d: string }>("select pg_get_functiondef('findmaxxing_private.occurrence_committed(uuid, timestamptz)'::regprocedure) as d")).toSatisfy((r: { d: string }[]) =>
        ["event_attendees", "tickets", "messages", "occurrence_anchors", "ad_campaigns", "overridden", "price_cents", "attended"].every((w) => r[0].d.includes(w)));
    });

    it("the Outings anchor hook exists, is private, and reports nothing anchored at this head", async () => {
      const id = await createSeries(dev);
      const [a] = await occurrences(id);
      expect(await sql("select findmaxxing_private.occurrence_anchors($1) as n", [a.id])).toEqual([{ n: 0 }]);
      for (const who of [dev, "service"] as const) {
        if (who === "service") await expect(service("select findmaxxing_private.occurrence_anchors($1)", [a.id])).rejects.toThrow(/permission denied/);
        else await expect(as(who, "select findmaxxing_private.occurrence_anchors($1)", [a.id])).rejects.toThrow(/permission denied/);
      }
    });

    it("the statement-level account locks and the row trigger order are in place", async () => {
      const rows = await sql<{ tgname: string; rel: string; stmt: boolean }>(`
        select t.tgname, t.tgrelid::regclass::text as rel, (t.tgtype & 1) = 0 as stmt from pg_trigger t
        where t.tgname like '%_a_lock_actor' and not t.tgisinternal order by 1`);
      expect(rows).toEqual([
        { tgname: "event_attendees_a_lock_actor", rel: "event_attendees", stmt: true },
        { tgname: "event_tags_a_lock_actor", rel: "event_tags", stmt: true },
        { tgname: "events_a_lock_actor", rel: "events", stmt: true },
      ]);
    });

    it("no code path reads or writes event_participants, waitlisted or offered (A1.6)", () => {
      const roots = ["src", "supabase/migrations", "packages/shared/src", "apps/mobile/lib"].map((d) => path.join(__dirname, "..", d));
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(p); continue; }
          if (!/\.(ts|tsx|sql)$/.test(entry.name)) continue;
          const text = readFileSync(p, "utf8");
          if (/event_participants|'waitlisted'|"waitlisted"|'offered'|"offered"/.test(text)) offenders.push(path.relative(path.join(__dirname, ".."), p));
        }
      };
      roots.forEach(walk);
      expect(offenders).toEqual([]);
    });
  });
});

// ----------------------------------------------------------------------------
// Demo twin at parity: the same scripts on the real SQL and on the demo repository.
// ----------------------------------------------------------------------------
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";

/** One word per outcome, so SQL and demo answers can be compared directly. */
function outcome(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/events:not_found|isn't available/i.test(m)) return "not_found";
  if (/events:closed|no longer be changed/i.test(m)) return "closed";
  if (/events:not_ended|once the session has ended/i.test(m)) return "not_ended";
  if (/events:not_attending|wasn't going/i.test(m)) return "not_attending";
  if (/events:bad_series_rule|days, time and length/i.test(m)) return "bad_rule";
  if (/event is full/i.test(m)) return "full";
  if (/not open for joining|Event not found/i.test(m)) return "join_closed";
  if (/permission denied|row-level security|don't have permission|You do not own/i.test(m)) return "denied";
  if (/account_suspended|suspended/i.test(m)) return "suspended";
  return `error: ${m}`;
}
const run = (f: () => Promise<unknown>, ok = "ok") => f().then((r) => (typeof r === "string" ? r : ok), outcome);

/** The same small vocabulary on both sides. Occurrences are addressed by index in local-date order at creation. */
interface SeriesBackend {
  ids(): Promise<string[]>;
  dates(): Promise<string[]>;
  statuses(): Promise<string[]>;
  join(who: "theo" | "jules", i: number): Promise<string>;
  addBackup(who: "maya"): Promise<string>;
  removeBackup(who: "maya"): Promise<string>;
  editOne(who: "dev" | "maya" | "theo", i: number, title: string): Promise<string>;
  overridden(i: number): Promise<string[]>;
  title(i: number): Promise<string>;
  editFuture(who: "dev" | "maya", i: number, patch: Record<string, unknown>): Promise<string>;
  cancelOne(who: "dev" | "maya" | "theo", i: number): Promise<string>;
  end(who: "dev" | "maya", cutoffIndex: number): Promise<string>;
  follow(who: "theo"): Promise<string>;
  followers(): Promise<string[]>;
  goingOn(i: number): Promise<string[]>;
  pause(): Promise<string>;
  generateLater(days: number): Promise<string>;
}
const PEOPLE = { dev: user("dev"), maya: user("maya_r"), theo: user("theo"), jules: user("jules") } as const;
type Name = keyof typeof PEOPLE;
const nameOf = (id: string) => (Object.entries(PEOPLE).find(([, v]) => v === id)?.[0] ?? "someone") as Name;

describe("0054: the demo twin runs the same scripts as the SQL", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); }, 120_000);
  afterAll(async () => { await db?.close(); });
  const RULE2: SeriesRule = { freq: "weekly", interval: 1, weekdays: [2, 4], start_local: "19:00", duration_minutes: 90 };
  const tmpl = () => ({ title: "Parity run", description: "An easy 5k loop from the park gate; all paces welcome.", category_slug: "pickup-sports", location_name: "Goodale Park gate", lat: 39.97, lng: -83.0, time_zone: NY, rule: RULE2, tags: ["pickup-sports"], capacity: 10 });

  async function sqlBackend(): Promise<SeriesBackend> {
    const as = <T = Record<string, unknown>>(id: string | null, q: string, p: unknown[] = []) => queryAs<T>(db, id, q, p);
    const sql = <T = Record<string, unknown>>(q: string, p: unknown[] = []) => db.query<T>(q, p).then((r) => r.rows);
    const service = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => { await db.exec("set role service_role"); try { return (await db.query<T>(q, p)).rows; } finally { await db.exec("reset role"); } };
    const series = (await as<{ id: string }>(PEOPLE.dev, "select public.create_event_series($1::jsonb) as id", [JSON.stringify(tmpl())]))[0].id;
    const initial = (await sql<{ id: string }>("select id from public.events where series_id = $1 order by series_local_date", [series])).map((r) => r.id);
    const rows = () => sql<{ id: string; d: string; status: string; title: string; overridden: string[] }>("select id, series_local_date::text as d, status, title, overridden from public.events where series_id = $1 order by series_local_date", [series]);
    const at = (i: number) => initial[i];
    return {
      ids: async () => (await rows()).map((r) => r.id),
      dates: async () => (await rows()).map((r) => r.d),
      statuses: async () => (await rows()).map((r) => r.status),
      join: (who, i) => run(() => as(PEOPLE[who], "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [at(i)])),
      addBackup: (who) => run(() => as(PEOPLE.dev, "select public.add_series_host($1, $2)", [series, PEOPLE[who]])),
      removeBackup: (who) => run(() => as(PEOPLE.dev, "select public.remove_series_host($1, $2)", [series, PEOPLE[who]])),
      editOne: (who, i, title) => run(() => as(PEOPLE[who], "select public.update_occurrence($1, $2::jsonb)", [at(i), JSON.stringify({ title })])),
      overridden: async (i) => (await rows()).find((r) => r.id === at(i))!.overridden,
      title: async (i) => (await rows()).find((r) => r.id === at(i))!.title,
      editFuture: (who, i, patch) => run(async () => {
        const [{ r }] = await as<{ r: { moved: string[]; kept: string[]; deleted: number; created: number } }>(PEOPLE[who], "select public.update_series_from($1, $2::jsonb) as r", [at(i), JSON.stringify(patch)]);
        return `moved:${r.moved.length} kept:${r.kept.length} deleted:${r.deleted} created:${r.created}`;
      }),
      cancelOne: (who, i) => run(() => as(PEOPLE[who], "select public.cancel_occurrence($1)", [at(i)])),
      end: (who, cutoff) => run(async () => `ended:${(await as<{ n: number }>(PEOPLE[who], "select public.end_event_series($1, $2::date) as n", [series, (await rows())[cutoff].d]))[0].n}`),
      follow: (who) => run(() => as(PEOPLE[who], "insert into public.event_series_followers (series_id, user_id) values ($1, auth.uid())", [series])),
      followers: async () => (await sql<{ u: string }>("select user_id as u from public.event_series_followers where series_id = $1", [series])).map((r) => nameOf(r.u)),
      goingOn: async (i) => (await sql<{ u: string }>("select user_id as u from public.event_attendees where event_id = $1 order by user_id", [at(i)])).map((r) => nameOf(r.u)).sort(),
      pause: () => run(() => as(PEOPLE.dev, "select public.set_series_status($1, 'paused')", [series])),
      generateLater: (days) => run(async () => `generated:${(await service<{ n: number }>("select public.generate_series_occurrences($1, $2) as n", [series, new Date(Date.now() + days * 86_400_000).toISOString()]))[0].n}`),
    };
  }

  async function demoBackend(): Promise<SeriesBackend> {
    const handle = createIsolatedStore();
    const repo: DataRepository = createDemoRepository(handle);
    const t = tmpl();
    const s = await repo.series.create({ title: t.title, description: t.description, categorySlug: t.category_slug, locationName: t.location_name, lat: t.lat, lng: t.lng, timeZone: t.time_zone, rule: t.rule, tags: t.tags, capacity: t.capacity }, PEOPLE.dev);
    const rows = () => handle.state.events.filter((e) => e.seriesId === s.id).sort((a, b) => (a.seriesLocalDate! < b.seriesLocalDate! ? -1 : 1));
    const initial = rows().map((e) => e.id);
    const at = (i: number) => initial[i];
    const toPatch = (p: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      const map: Record<string, string> = { title: "title", capacity: "capacity", rule: "rule", description: "description" };
      for (const [k, v] of Object.entries(p)) out[map[k] ?? k] = v;
      return out;
    };
    return {
      ids: async () => rows().map((e) => e.id),
      dates: async () => rows().map((e) => e.seriesLocalDate!),
      statuses: async () => rows().map((e) => e.status),
      join: (who, i) => run(() => repo.events.join(PEOPLE[who], at(i))),
      addBackup: (who) => run(() => repo.series.addHost(PEOPLE.dev, s.id, PEOPLE[who])),
      removeBackup: (who) => run(() => repo.series.removeHost(PEOPLE.dev, s.id, PEOPLE[who])),
      editOne: (who, i, title) => run(() => repo.series.updateOccurrence(PEOPLE[who], at(i), { title })),
      overridden: async (i) => rows().find((e) => e.id === at(i))!.overridden ?? [],
      title: async (i) => rows().find((e) => e.id === at(i))!.title,
      editFuture: (who, i, patch) => run(async () => {
        const r = await repo.series.updateFrom(PEOPLE[who], at(i), toPatch(patch));
        return `moved:${r.moved.length} kept:${r.kept.length} deleted:${r.deleted} created:${r.created}`;
      }),
      cancelOne: (who, i) => run(() => repo.series.cancelOccurrence(PEOPLE[who], at(i))),
      end: (who, cutoff) => run(async () => `ended:${await repo.series.end(PEOPLE[who], s.id, rows()[cutoff].seriesLocalDate)}`),
      follow: (who) => run(() => repo.series.follow(PEOPLE[who], s.id)),
      followers: async () => handle.state.eventSeriesFollowers.filter((f) => f.seriesId === s.id).map((f) => nameOf(f.userId)),
      goingOn: async (i) => handle.state.eventAttendees.filter((a) => a.eventId === at(i)).map((a) => nameOf(a.userId)).sort(),
      pause: () => run(() => repo.series.setStatus(PEOPLE.dev, s.id, "paused")),
      generateLater: (days) => run(async () => {
        const before = rows().length;
        // The demo generator has no per-series call; the whole store is one series here.
        const now = new Date(Date.now() + days * 86_400_000).toISOString();
        await repo.series.generate(now);
        return `generated:${rows().length - before}`;
      }),
    };
  }

  type Step = (b: SeriesBackend) => Promise<string | string[] | void>;
  async function both(steps: [string, Step][]) {
    const transcript = async (b: SeriesBackend) => {
      const out: string[] = [];
      for (const [label, step] of steps) { const r = await step(b); out.push(`${label}: ${Array.isArray(r) ? r.join(",") : (r ?? "")}`); }
      return out;
    };
    const [sqlOut, demoOut] = [await transcript(await sqlBackend()), await transcript(await demoBackend())];
    expect(demoOut).toEqual(sqlOut);
    return sqlOut;
  }

  it("generation: the same dates, idempotent, and a later run adds the same number", async () => {
    const out = await both([
      ["dates", (b) => b.dates()],
      ["again", (b) => b.generateLater(0)],
      ["later", (b) => b.generateLater(7)],
      ["dates after", (b) => b.dates()],
    ]);
    expect(out[1]).toBe("again: generated:0");
    expect(out[2]).not.toBe("later: generated:0");
  });

  it("hosts: a backup host edits through the function, is denied directly, and is refused once revoked; a stranger never may", async () => {
    const out = await both([
      ["stranger edits", (b) => b.editOne("theo", 0, "Nope")],
      ["before backup", (b) => b.editOne("maya", 0, "Nope")],
      ["add backup", (b) => b.addBackup("maya")],
      ["backup edits", (b) => b.editOne("maya", 0, "Backup edit")],
      ["title", (b) => b.title(0)],
      ["overridden", (b) => b.overridden(0)],
      ["backup cancels", (b) => b.cancelOne("maya", 1)],
      ["statuses", (b) => b.statuses()],
      ["backup ends", (b) => b.end("maya", 3)],
      ["remove backup", (b) => b.removeBackup("maya")],
      ["after revocation", (b) => b.editOne("maya", 2, "After")],
      ["title 2", (b) => b.title(2)],
    ]);
    expect(out.slice(0, 2)).toEqual(["stranger edits: not_found", "before backup: not_found"]);
    expect(out[3]).toBe("backup edits: ok");
    expect(out[5]).toBe("overridden: details");
    expect(out[8]).toBe("backup ends: not_found");
    expect(out[10]).toBe("after revocation: not_found");
  });

  it("edit-this, edit-future with overrides, cancel-one, end: the same rows change", async () => {
    const out = await both([
      ["edit one", (b) => b.editOne("dev", 2, "Special")],
      ["edit future", (b) => b.editFuture("dev", 1, { title: "New title" })],
      ["titles", async (b) => Promise.all((await b.ids()).map((_, i) => b.title(i)))],
      ["cancel one", (b) => b.cancelOne("dev", 0)],
      ["later run", (b) => b.generateLater(3)],
      ["statuses", (b) => b.statuses()],
      ["end", (b) => b.end("dev", 3)],
      ["statuses after end", (b) => b.statuses()],
    ]);
    expect(out[1]).toBe("edit future: moved:0 kept:0 deleted:0 created:0");
    expect(out[2]).toMatch(/^titles: Parity run,New title,Special(,New title)+$/);
    expect(out[5]).toMatch(/^statuses: cancelled(,published)+$/);
  });

  it("a schedule change moves what people joined and remakes the rest, the same way", async () => {
    const out = await both([
      ["theo joins 1", (b) => b.join("theo", 1)],
      ["jules joins 2", (b) => b.join("jules", 2)],
      ["change", (b) => b.editFuture("dev", 0, { rule: { ...RULE2, weekdays: [3], start_local: "18:30" } })],
      ["going 1", (b) => b.goingOn(1)],
      ["going 2", (b) => b.goingOn(2)],
      ["dates", async (b) => (await b.dates()).map((d) => String(new Date(`${d}T12:00:00Z`).getUTCDay()))],
    ]);
    expect(out[2]).toMatch(/^change: moved:2 kept:0 deleted:\d+ created:\d+$/);
    expect(out[3]).toBe("going 1: dev,theo");
    expect(out[5]).toMatch(/^dates: 3(,3)+$/);
  });

  it("following is its own state and never joins; pausing stops generation", async () => {
    const out = await both([
      ["follow", (b) => b.follow("theo")],
      ["followers", (b) => b.followers()],
      ["going 0", (b) => b.goingOn(0)],
      ["pause", (b) => b.pause()],
      ["later", (b) => b.generateLater(7)],
    ]);
    expect(out).toEqual(["follow: ok", "followers: theo", "going 0: dev", "pause: ok", "later: generated:0"]);
  });
});
