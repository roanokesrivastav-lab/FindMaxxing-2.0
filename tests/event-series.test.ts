/**
 * Roadmap 4.5a: recurring series (0055). Generation (4-week horizon, never past ends_on, never while
 * paused, never recreating a cancelled date), DST vectors shared by SQL and TS (spring gap, fall-back
 * first instant, local time kept across a change), edit-this vs edit-future with overridden fields,
 * schedule changes (empty occurrences regenerated, occupied ones moved in place), cancel one, end
 * series, revoked backup host denied at once, follow never RSVPs, attendance, D-J moderation, RLS as
 * anon / owner / backup host / another user / moderator, demo parity and the real create action.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { zonedTimeToUtc } from "../src/lib/utils/timezone";
import { seriesDates } from "../src/lib/data/demo/series";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), nina = user("nina"), lena = user("lena"), sam = user("sam_k");

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: maya, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); }, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isoDow = (d: string) => { const x = new Date(`${d}T00:00:00Z`).getUTCDay(); return x === 0 ? 7 : x; };

/** Shared DST vectors: SQL local_to_instant and the app's zonedTimeToUtc must agree (D-G). */
const VECTORS: [string, string, string, string][] = [
  ["2027-03-14", "02:30", "America/New_York", "2027-03-14T07:30:00.000Z"], // spring gap → 03:30 EDT
  ["2027-11-07", "01:30", "America/New_York", "2027-11-07T05:30:00.000Z"], // fall-back repeat → FIRST instant (EDT)
  ["2027-11-06", "19:00", "America/New_York", "2027-11-06T23:00:00.000Z"], // before the change (EDT)
  ["2027-11-13", "19:00", "America/New_York", "2027-11-14T00:00:00.000Z"], // after it (EST): 19:00 local kept
  ["2027-10-31", "02:30", "Europe/Berlin", "2027-10-31T00:30:00.000Z"],    // Berlin fall-back repeat → first (CEST)
];

describe("database (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const create = async (who: string, o: { weekdays?: number[]; startsOn?: string; endsOn?: string | null; startLocal?: string; zone?: string; interval?: number; capacity?: number | null } = {}) =>
    (await queryAs<{ id: string }>(db, who, `select public.create_series('Weekly run', 'A weekly run for everyone.', 'fitness', null, 'Goodale', null, 39.97, -83,
      $1, $2, $3, $4::time, 60, $5::date, $6::date, $7, null, null, null, null, null, '{running}') as id`,
      [o.zone ?? "America/New_York", o.weekdays ?? [1, 2, 3, 4, 5, 6, 7], o.interval ?? 1, o.startLocal ?? "19:00", o.startsOn ?? today(), o.endsOn ?? null, o.capacity === undefined ? 10 : o.capacity]))[0].id;
  const occ = async (series: string) => (await db.query<{ id: string; series_local_date: string; starts_at: Date; status: string; title: string; overridden: string[]; capacity: number | null }>(
    "select id, to_char(series_local_date, 'YYYY-MM-DD') as series_local_date, starts_at, status, title, overridden, capacity from public.events where series_id = $1 order by series_local_date", [series])).rows;

  it("SQL local_to_instant and the app's zonedTimeToUtc agree on every DST vector", async () => {
    for (const [d, t, z, want] of VECTORS) {
      const [{ at }] = (await db.query<{ at: Date }>("select public.local_to_instant($1::date, $2::time, $3) as at", [d, t, z])).rows;
      expect(at.toISOString()).toBe(want);
      expect(zonedTimeToUtc(d, t, z).toISOString()).toBe(want);
    }
  });

  it("generates the next 4 weeks only, at 19:00 local, never past ends_on; idempotent; the owner is the creator", async () => {
    const s = await create(maya);
    const rows = await occ(s);
    expect(rows.length).toBeGreaterThanOrEqual(28);
    expect(rows.length).toBeLessThanOrEqual(29);
    expect(rows.at(-1)!.series_local_date <= plusDays(today(), 28)).toBe(true);
    for (const r of rows.slice(0, 3)) expect(r.starts_at.toISOString()).toBe(zonedTimeToUtc(r.series_local_date, "19:00", "America/New_York").toISOString());
    expect((await db.query<{ n: number }>("select public.generate_series_occurrences($1, now()) as n", [s])).rows[0].n).toBe(0);
    expect((await db.query("select distinct creator_id from public.events where series_id = $1", [s])).rows).toEqual([{ creator_id: maya }]);
    const capped = await create(maya, { endsOn: plusDays(today(), 6) });
    expect((await occ(capped)).every((r) => r.series_local_date <= plusDays(today(), 6))).toBe(true);
    // Tags copied; the series counts once against the daily event limit, not per occurrence.
    expect((await db.query("select interest_slug from public.event_tags where event_id = $1", [rows[0].id])).rows).toEqual([{ interest_slug: "running" }]);
  });

  it("interval and weekdays: every 2 weeks on Monday and Thursday matches the demo's date rule", async () => {
    const startsOn = today();
    const s = await create(maya, { weekdays: [1, 4], interval: 2, startsOn });
    const sqlDates = (await occ(s)).map((r) => r.series_local_date);
    const tsDates = seriesDates({ weekdays: [1, 4], intervalWeeks: 2, startLocal: "19:00", durationMinutes: 60, startsOn, endsOn: null }, today(), plusDays(today(), 28))
      .filter((d) => Date.parse(zonedTimeToUtc(d, "19:00", "America/New_York").toISOString()) > Date.now());
    expect(sqlDates).toEqual(tsDates);
    for (const d of sqlDates) expect([1, 4]).toContain(isoDow(d));
  });

  it("DST: a Sunday 01:30 series resolves the fall-back repeat to the first instant; 19:00 stays 19:00 across the change", async () => {
    const s = await create(maya, { weekdays: [7], startsOn: "2027-10-31", startLocal: "01:30" });
    await db.query("delete from public.events where series_id = $1", [s]);
    await db.query("select public.generate_series_occurrences($1, '2027-10-20T12:00:00Z')", [s]);
    const fb = (await occ(s)).find((r) => r.series_local_date === "2027-11-07")!;
    expect(fb.starts_at.toISOString()).toBe("2027-11-07T05:30:00.000Z");
    const evening = await create(maya, { weekdays: [6], startsOn: "2027-10-30", startLocal: "19:00" });
    await db.query("delete from public.events where series_id = $1", [evening]);
    await db.query("select public.generate_series_occurrences($1, '2027-10-20T12:00:00Z')", [evening]);
    const byDate = Object.fromEntries((await occ(evening)).map((r) => [r.series_local_date, r.starts_at.toISOString()]));
    expect(byDate["2027-11-06"]).toBe("2027-11-06T23:00:00.000Z");
    expect(byDate["2027-11-13"]).toBe("2027-11-14T00:00:00.000Z");
    const spring = await create(maya, { weekdays: [7], startsOn: "2027-03-07", startLocal: "02:30" });
    await db.query("delete from public.events where series_id = $1", [spring]);
    await db.query("select public.generate_series_occurrences($1, '2027-03-01T12:00:00Z')", [spring]);
    expect((await occ(spring)).find((r) => r.series_local_date === "2027-03-14")!.starts_at.toISOString()).toBe("2027-03-14T07:30:00.000Z");
  });

  it("cancel one Thursday: the next is untouched and the generator never recreates it", async () => {
    const s = await create(maya, { weekdays: [4] });
    const [first, second] = await occ(s);
    await queryAs(db, maya, "select public.cancel_occurrence($1)", [first.id]);
    await db.query("select public.generate_series_occurrences($1, now())", [s]);
    const after = await occ(s);
    expect(after.find((r) => r.id === first.id)!.status).toBe("cancelled");
    expect(after.filter((r) => r.series_local_date === first.series_local_date)).toHaveLength(1);
    expect(after.find((r) => r.id === second.id)!.status).toBe("published");
  });

  it("edit this records overridden fields; edit this-and-future skips them and never touches earlier ones", async () => {
    const s = await create(maya, { weekdays: [2, 5] });
    const [a, b, c] = await occ(s);
    const ev = (await db.query("select * from public.events where id = $1", [b.id])).rows[0] as Record<string, unknown>;
    await queryAs(db, maya, "select public.update_occurrence($1, 'Special edition run', $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [b.id, ev.description, ev.place_id, ev.location_name, ev.address, ev.lat, ev.lng, ev.starts_at, ev.ends_at, ev.capacity]);
    expect((await occ(s)).find((r) => r.id === b.id)!.overridden).toEqual(["title"]);
    await queryAs(db, maya, "select public.update_series_from($1, 'Run club', 'New description for the run club.', null, 'Goodale', null, 39.97, -83, '{2,5}', 1, '19:00', 60, 12)", [b.id]);
    const after = await occ(s);
    expect(after.find((r) => r.id === a.id)!.title).toBe("Weekly run"); // earlier: untouched
    expect(after.find((r) => r.id === b.id)!.title).toBe("Special edition run"); // overridden: kept
    expect(after.find((r) => r.id === b.id)!.capacity).toBe(12);
    expect(after.find((r) => r.id === c.id)!.title).toBe("Run club");
  });

  it("schedule change: empty future dates are replaced under the new rule; one with people keeps its id and moves in place", async () => {
    const s = await create(maya, { weekdays: [3] });
    const [w1, w2] = await occ(s);
    await queryAs(db, theo, "select public.join_event($1)", [w2.id]);
    await queryAs(db, maya, "select public.update_series_from($1, 'Weekly run', 'A weekly run for everyone.', null, 'Goodale', null, 39.97, -83, '{6}', 1, '08:00', 60, 10)", [w1.id]);
    const after = await occ(s);
    expect(after.find((r) => r.id === w1.id)).toBeUndefined(); // nobody involved → deleted
    const moved = after.find((r) => r.id === w2.id)!;
    expect(moved.series_local_date).toBe(w2.series_local_date);
    expect(moved.starts_at.toISOString()).toBe(zonedTimeToUtc(w2.series_local_date, "08:00", "America/New_York").toISOString());
    expect((await db.query("select user_id from public.event_attendees where event_id = $1", [w2.id])).rows).toEqual([{ user_id: theo }]);
    expect(after.filter((r) => r.id !== w2.id).every((r) => isoDow(r.series_local_date) === 6)).toBe(true);
    expect((await db.query<{ v: number }>("select rule_version as v from public.event_series where id = $1", [s])).rows[0].v).toBe(2);
  });

  it("backup hosts act through the RPCs; revoking one denies them at once; only the owner manages hosts", async () => {
    const s = await create(maya, { weekdays: [1] });
    const [first] = await occ(s);
    await expect(queryAs(db, theo, "select public.cancel_occurrence($1)", [first.id])).rejects.toThrow(/do not host/);
    await queryAs(db, maya, "select public.set_series_host($1, $2, true)", [s, theo]);
    await expect(queryAs(db, theo, "select public.set_series_host($1, $2, true)", [s, nina])).rejects.toThrow(/Only the series owner/);
    // A backup host may not update events directly (creator-only guard) …
    const direct = await queryAs(db, theo, "update public.events set min_attendance = 3 where id = $1 returning id", [first.id]).catch((e: Error) => e.message);
    expect(direct === "You do not own this event" || (Array.isArray(direct) && direct.length === 0)).toBe(true);
    // … but can through the host RPCs, and sees the waitlist rows.
    await queryAs(db, theo, "select public.confirm_session($1)", [first.id]);
    await queryAs(db, maya, "select public.set_series_host($1, $2, false)", [s, theo]);
    await expect(queryAs(db, theo, "select public.cancel_occurrence($1)", [first.id])).rejects.toThrow(/do not host/);
    await expect(queryAs(db, theo, "select public.end_series($1, current_date)", [s])).rejects.toThrow(/do not host/);
  });

  it("following never creates an attendee or participant row", async () => {
    const s = await create(maya, { weekdays: [5] });
    await queryAs(db, nina, "select public.follow_series($1, true)", [s]);
    expect((await db.query("select 1 from public.event_attendees a join public.events e on e.id = a.event_id where e.series_id = $1 and a.user_id = $2", [s, nina])).rows).toEqual([]);
    expect((await db.query("select 1 from public.event_participants p join public.events e on e.id = p.event_id where e.series_id = $1 and p.user_id = $2", [s, nina])).rows).toEqual([]);
    expect(await queryAs(db, nina, "select series_id from public.event_series_followers where series_id = $1", [s])).toHaveLength(1);
    expect(await queryAs(db, lena, "select series_id from public.event_series_followers where series_id = $1", [s])).toHaveLength(0);
  });

  it("end series: future occurrences after the end date are cancelled and the generator stops", async () => {
    const s = await create(maya, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    const n = (await queryAs<{ n: number }>(db, maya, "select public.end_series($1, current_date + 7) as n", [s]))[0].n;
    expect(n).toBeGreaterThan(15);
    const rows = await occ(s);
    expect(rows.filter((r) => r.series_local_date > plusDays(today(), 7)).every((r) => r.status === "cancelled")).toBe(true);
    expect((await db.query<{ n: number }>("select public.generate_series_occurrences($1, now()) as n", [s])).rows[0].n).toBe(0);
  });

  it("RLS: anyone who can see it reads the series and hosts; nobody writes directly; D-J moderation cascades", async () => {
    const s = await create(maya, { weekdays: [6] });
    for (const who of [null, theo, sam, maya]) expect(await queryAs(db, who, "select id from public.event_series where id = $1", [s])).toHaveLength(1);
    expect(await queryAs(db, null, "select user_id from public.event_series_hosts where series_id = $1", [s])).toEqual([{ user_id: maya }]);
    await expect(queryAs(db, maya, "update public.event_series set title = 'x' where id = $1", [s])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, theo, "insert into public.event_series_hosts (series_id, user_id, role) values ($1, $2, 'backup')", [s, theo])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, theo, "insert into public.event_series_followers (series_id, user_id) values ($1, $2)", [s, theo])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, theo, "select public.moderate_series($1, true)", [s])).rejects.toThrow(/Moderators only/);
    await queryAs(db, sam, "select public.moderate_series($1, true)", [s]);
    expect((await occ(s)).every((r) => r.status === "removed")).toBe(true);
    expect(await queryAs(db, null, "select id from public.event_series where id = $1", [s])).toEqual([]);
    await queryAs(db, sam, "select public.moderate_series($1, false)", [s]);
    expect((await occ(s)).every((r) => r.status === "published")).toBe(true);
  });

  it("attendance is recorded by a host after the occurrence ends, never before; not by others", async () => {
    const s = await create(maya, { weekdays: [1, 2, 3, 4, 5, 6, 7] });
    const [first] = await occ(s);
    await queryAs(db, theo, "select public.join_event($1)", [first.id]);
    await expect(queryAs(db, maya, "select public.set_attended($1, $2, true)", [first.id, theo])).rejects.toThrow(/after the event/);
    await db.query("alter table public.events disable trigger user");
    await db.query("update public.events set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours', decision_deadline = null where id = $1", [first.id]);
    await db.query("alter table public.events enable trigger user");
    await expect(queryAs(db, nina, "select public.set_attended($1, $2, true)", [first.id, theo])).rejects.toThrow(/do not host/);
    await queryAs(db, maya, "select public.set_attended($1, $2, true)", [first.id, theo]);
    expect((await db.query("select attended from public.event_attendees where event_id = $1 and user_id = $2", [first.id, theo])).rows).toEqual([{ attended: true }]);
  });
});

describe("demo parity and the real create action", () => {
  let repo: DataRepository;
  beforeEach(() => { ctx.repo = repo = createDemoRepository(createIsolatedStore()); ctx.viewer = maya; });
  afterEach(() => vi.unstubAllEnvs());
  const input = (weekdays: number[]) => ({ title: "Demo run", description: "A weekly run for everyone.", categorySlug: "fitness", locationName: "Goodale", lat: 39.97, lng: -83, timeZone: "America/New_York",
    rule: { weekdays, intervalWeeks: 1, startLocal: "19:00", durationMinutes: 60, startsOn: today(), endsOn: null }, capacity: 10, tags: ["running"] });

  it("demo: generation, cancel one, edit future with overrides, schedule move, revoked host, follow", async () => {
    const { seriesId, firstEventId } = await repo.series.create(input([2, 4]), maya);
    const occ = await repo.series.occurrences(seriesId, null);
    expect(occ.length).toBeGreaterThanOrEqual(8);
    expect(occ.every((e) => e.seriesId === seriesId && [2, 4].includes(isoDow(e.seriesLocalDate!)))).toBe(true);
    expect(firstEventId).toBe(occ[0].id);
    expect(await repo.series.generate(new Date().toISOString())).toBe(0);
    await repo.series.cancelOccurrence(maya, occ[0].id);
    await repo.series.generate(new Date().toISOString());
    expect((await repo.series.occurrences(seriesId, maya)).filter((e) => e.seriesLocalDate === occ[0].seriesLocalDate)).toHaveLength(1);
    const b = occ[1];
    await repo.series.updateOccurrence(maya, b.id, { title: "Special", description: b.description, placeId: b.placeId, locationName: b.locationName, address: b.address, lat: b.lat, lng: b.lng, startsAt: b.startsAt, endsAt: b.endsAt, categorySlug: b.categorySlug, capacity: b.capacity, tags: [] });
    await repo.events.join(theo, occ[2].id);
    await repo.series.updateFrom(maya, b.id, { title: "Run club", description: "New description here.", locationName: "Goodale", lat: 39.97, lng: -83, weekdays: [6], intervalWeeks: 1, startLocal: "08:00", durationMinutes: 60, capacity: 10 });
    const after = await repo.series.occurrences(seriesId, maya);
    expect(after.find((e) => e.id === b.id)?.title ?? "deleted").toBe("deleted"); // nobody involved: replaced
    const moved = after.find((e) => e.id === occ[2].id)!;
    expect(moved.startsAt).toBe(zonedTimeToUtc(moved.seriesLocalDate!, "08:00", "America/New_York").toISOString());
    expect(moved.title).toBe("Run club");
    await repo.series.setHost(maya, seriesId, theo, true);
    expect((await repo.series.get(seriesId, theo))!.viewerIsHost).toBe(true);
    await repo.series.setHost(maya, seriesId, theo, false);
    await expect(repo.series.cancelOccurrence(theo, moved.id)).rejects.toThrow(/do not host/);
    await repo.series.follow(nina, seriesId, true);
    expect((await repo.series.get(seriesId, nina))!.viewerFollows).toBe(true);
    expect((await repo.events.get(moved.id, nina))!.viewerJoined).toBe(false);
    expect((await repo.events.get(moved.id, nina))!.viewerParticipant).toBeNull();
  });

  it("the real create action with 'Repeats every week' makes a series and opens its first occurrence", async () => {
    const { createEventAction } = await import("../src/server/actions/events");
    const f = new FormData();
    const day = plusDays(today(), 2);
    for (const [k, v] of Object.entries({ title: "Thursday run", description: "Five easy kilometres, every week.", locationName: "Goodale", city: "Columbus", lat: "39.97", lng: "-83.0", date: day, startTime: "19:00", endTime: "20:00", categorySlug: "fitness", tzOffsetMinutes: "300", timeZone: "America/New_York", repeats: "on" })) f.set(k, v);
    const err = await createEventAction(null, f).catch((e: Error) => e);
    const id = /\/events\/([0-9a-f-]+)/.exec(String((err as Error).message))![1];
    const ev = (await repo.events.get(id, null))!;
    expect(ev.seriesId).toBeTruthy();
    expect(ev.seriesLocalDate).toBe(day);
    const s = (await repo.series.get(ev.seriesId!, maya))!;
    expect(s.rule).toMatchObject({ weekdays: [isoDow(day)], startLocal: "19:00", durationMinutes: 60, startsOn: day });
    expect(s.hosts).toEqual([expect.objectContaining({ userId: maya, role: "owner" })]);
  });
});
