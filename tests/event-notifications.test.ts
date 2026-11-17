/**
 * Migration 0055 (roadmap 4.6; 4.0 Amendment A1.5): material-change notifications.
 *
 * The real SQL in PGlite, then the same script on the demo twin and the two
 * compared. Two sessions changing one event at once is in
 * tests/event-notifications-pg.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { decideDemoSessions } from "../src/lib/data/demo/sessions";
import { notificationText, NOTIFICATION_TYPES, DEFAULT_NOTIFICATION_SETTINGS } from "../packages/shared/src/notifications";
import type { SeriesRuleShape } from "../src/lib/data/types";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [owner, maya, theo, jules, lena, priya] = ["marcus", "maya_r", "theo", "jules", "lena", "priya"].map(user);
const NY = "America/New_York";
const isoDow = (offset: number) => new Date(Date.now() + offset * 86_400_000).getUTCDay() || 7;
const RULE: SeriesRuleShape = { freq: "weekly", interval: 1, weekdays: [isoDow(3)], start_local: "19:00", duration_minutes: 90 };
const NEW_RULE: SeriesRuleShape = { ...RULE, start_local: "20:00" };
const MIGRATION = readFileSync(path.join(__dirname, "../supabase/migrations/0055_event_change_notifications.sql"), "utf8");

type Note = { user_id: string; type: string; subject_id: string | null; dedupe_key: string | null; batch_key: string | null; detail: string | null; push_state: string; actor_id: string | null };

let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); }, 120_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("delete from public.rate_limit_counters; delete from public.notifications; delete from public.blocks; delete from public.notification_settings;"); });

const as = <T = Record<string, unknown>>(who: string | null, q: string, p: unknown[] = []) => queryAs<T>(db, who, q, p);
const sql = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows;
const service = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => {
  await db.exec("set role service_role");
  try { return (await db.query<T>(q, p)).rows; } finally { await db.exec("reset role"); }
};
const template = (over: Record<string, unknown> = {}) => ({
  title: "Thursday run club", description: "An easy loop from the fountain, every week, all paces welcome.", category_slug: "fitness",
  location_name: "Scioto Mile fountain", lat: 39.96, lng: -83.0, time_zone: NY, rule: RULE, tags: [], capacity: 12, ...over,
});
async function makeSeries(by = owner, over: Record<string, unknown> = {}) {
  const id = (await as<{ id: string }>(by, "select public.create_event_series($1::jsonb) as id", [JSON.stringify(template(over))]))[0].id;
  const occ = (await sql<{ id: string }>("select id from public.events where series_id = $1 order by series_local_date", [id])).map((r) => r.id);
  return { id, occ };
}
const join = (who: string, event: string) => as(who, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [event]);
const follow = (who: string, series: string) => as(who, "insert into public.event_series_followers (series_id, user_id) values ($1, auth.uid())", [series]);
const notes = (who: string, type?: string) => sql<Note>(
  `select user_id, type, subject_id, dedupe_key, batch_key, detail, push_state, actor_id from public.notifications where user_id = $1 ${type ? "and type = $2" : ""} order by created_at, id`,
  type ? [who, type] : [who]);
// The host's own "someone joined" notices are 0021's and are left out.
const all = () => sql<Note>("select user_id, type, subject_id, dedupe_key, batch_key, detail, push_state, actor_id from public.notifications where type <> 'event_joined' order by user_id, type, dedupe_key");
const moveVenue = (event: string, name: string, by = owner) => as(by, "update public.events set location_name = $2 where id = $1", [event, name]);

describe("people going to one session", () => {
  it("each material change reaches each person going once, is pushed, and names the change; other edits and the host do not", async () => {
    const { occ } = await makeSeries();
    await join(maya, occ[0]);
    await join(theo, occ[0]);
    await moveVenue(occ[0], "North steps");
    await as(owner, "update public.events set title = 'Thursday tempo', capacity = 20, description = 'A longer description this week, still easy.' where id = $1", [occ[0]]);
    await as(owner, "update public.events set starts_at = starts_at + interval '30 minutes', ends_at = ends_at + interval '30 minutes' where id = $1", [occ[0]]);
    for (const who of [maya, theo]) {
      const got = await notes(who, "event_changed");
      expect(got.map((n) => n.dedupe_key)).toEqual([`event_changed:${occ[0]}:1`, `event_changed:${occ[0]}:2`]);
      expect(got.every((n) => n.batch_key === null && n.push_state === "pending" && n.actor_id === owner && n.subject_id === occ[0])).toBe(true);
    }
    expect((await notes(owner)).filter((n) => n.type !== "event_joined")).toEqual([]);
    expect((await sql<{ change_seq: number }>("select change_seq from public.events where id = $1", [occ[0]]))[0].change_seq).toBe(2);
  });

  it("a retried send of the same change adds nothing", async () => {
    const { occ } = await makeSeries();
    await join(maya, occ[0]);
    await moveVenue(occ[0], "North steps");
    for (let i = 0; i < 3; i++) await sql("select findmaxxing_private.notify_event_audience($1, 'changed', $2)", [occ[0], owner]);
    expect((await notes(maya, "event_changed")).length).toBe(1);
  });

  it("nobody blocked either way with the host hears, and nobody who can no longer see the session", async () => {
    const { occ } = await makeSeries(owner, { place_id: null });
    for (const who of [maya, theo, jules]) await join(who, occ[0]);
    await sql("insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($3, $4)", [maya, owner, owner, theo]);
    await moveVenue(occ[0], "North steps");
    expect((await all()).map((n) => n.user_id)).toEqual([jules]);
    // The session moves to a place only the host's mutual followers may see: Jules is still going, but can no longer see it.
    await sql("delete from public.notifications");
    const place = (await sql<{ id: string }>("select id from public.places where creator_id = $1 and status = 'published' limit 1", [owner]))[0]?.id
      ?? (await sql<{ id: string }>("select id from public.places where status = 'published' limit 1"))[0].id;
    await sql("update public.places set visibility = 'followers' where id = $1", [place]);
    try {
      await sql("update public.events set place_id = $2 where id = $1", [occ[0], place]);
      expect((await sql<{ v: boolean }>("select findmaxxing_private.visible_to($1, 'event', $2) as v", [jules, occ[0]]))[0].v).toBe(false);
      await moveVenue(occ[0], "South steps");
      expect(await notes(jules)).toEqual([]);
    } finally {
      await sql("update public.places set visibility = 'public' where id = $1", [place]);
    }
  });

  it("asking as the recipient leaves the caller's identity as it was", async () => {
    const { occ } = await makeSeries();
    await join(maya, occ[0]);
    await db.query("begin");
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
      await db.query("select findmaxxing_private.visible_to($1, 'event', $2)", [maya, occ[0]]);
      expect((await db.query<{ u: string }>("select auth.uid()::text as u")).rows[0].u).toBe(owner);
    } finally {
      await db.query("rollback");
    }
  });

  it("a mute is respected, and the type can be muted and pushed like the others", async () => {
    const { id, occ } = await makeSeries();
    await follow(maya, id);
    await as(maya, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['series_update'])");
    await as(owner, "select public.cancel_occurrence($1)", [occ[1]]);
    expect(await notes(maya)).toEqual([]);
    await expect(as(theo, "insert into public.notification_settings (user_id, push_types) values (auth.uid(), array['series_update'])")).resolves.toBeDefined();
    expect((await sql<{ d: string }>("select column_default as d from information_schema.columns where table_name = 'notification_settings' and column_name = 'push_types'"))[0].d).toContain("series_update");
  });

  it("change_seq is the database's: a client cannot set it on insert or change it", async () => {
    const cat = "fitness";
    const [{ id }] = await as<{ id: string }>(maya, `insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, change_seq)
      values ('Seq test', 'A long enough description', 'Somewhere', 39.96, -83, now() + interval '3 days', auth.uid(), $1, 41) returning id`, [cat]);
    expect((await sql<{ c: number }>("select change_seq as c from public.events where id = $1", [id]))[0].c).toBe(0);
    await expect(as(maya, "update public.events set change_seq = 9 where id = $1", [id])).rejects.toThrow(/permission denied/);
  });
});

describe("followers of a series", () => {
  it("one cancelled session: people going hear 'cancelled'; followers not going to it hear once; a follower going to it hears only the cancellation", async () => {
    const { id, occ } = await makeSeries();
    await join(maya, occ[1]);
    for (const who of [maya, theo, jules]) await follow(who, id);
    await as(owner, "select public.cancel_occurrence($1)", [occ[1]]);
    expect((await notes(maya)).map((n) => n.type)).toEqual(["event_cancelled"]);
    for (const who of [theo, jules]) {
      expect(await notes(who)).toEqual([expect.objectContaining({ type: "series_update", dedupe_key: `series_update:${id}:cancel:${occ[1]}`, detail: "cancel", subject_id: occ[0] })]);
    }
  });

  it("the host's own direct cancel of a session reaches followers too", async () => {
    const { id, occ } = await makeSeries();
    await follow(theo, id);
    await as(owner, "update public.events set status = 'cancelled' where id = $1", [occ[2]]);
    expect((await notes(theo)).map((n) => [n.type, n.detail])).toEqual([["series_update", "cancel"]]);
  });

  it("a schedule change: one update for followers not going to a moved session; those going hear about their own session only", async () => {
    const { id, occ } = await makeSeries();
    await join(maya, occ[0]);
    await join(jules, occ[1]);
    for (const who of [maya, theo, jules]) await follow(who, id);
    await as(owner, "select public.update_series_from($1, $2::jsonb)", [occ[0], JSON.stringify({ rule: NEW_RULE })]);
    expect((await notes(maya)).map((n) => n.type)).toEqual(["event_changed"]);
    expect((await notes(jules)).map((n) => n.type)).toEqual(["event_changed"]);
    expect(await notes(theo)).toEqual([expect.objectContaining({ type: "series_update", dedupe_key: `series_update:${id}:v2`, detail: "schedule" })]);
    // A template edit that is not a schedule change tells followers nothing.
    await sql("delete from public.notifications");
    await as(owner, "select public.update_series_from($1, $2::jsonb)", [occ[0], JSON.stringify({ title: "Thursday tempo" })]);
    expect(await notes(theo)).toEqual([]);
  });

  it("ending a series: each person going hears about their own session, followers hear once, not once per session", async () => {
    const { id, occ } = await makeSeries();
    await join(maya, occ[1]);
    await join(maya, occ[2]);
    for (const who of [maya, theo]) await follow(who, id);
    await as(owner, "select public.end_event_series($1)", [id]);
    expect((await notes(maya)).map((n) => n.type).sort()).toEqual(["event_cancelled", "event_cancelled"]);
    expect(await notes(theo)).toEqual([expect.objectContaining({ type: "series_update", dedupe_key: `series_update:${id}:ended`, detail: "ended", subject_id: null })]);
  });

  it("a follower blocked either way with the owner, or who cannot see a removed series, hears nothing", async () => {
    const { id, occ } = await makeSeries();
    for (const who of [theo, jules, lena]) await follow(who, id);
    await sql("insert into public.blocks (blocker_id, blocked_id) values ($1, $2), ($3, $4)", [theo, owner, owner, jules]);
    await as(owner, "select public.cancel_occurrence($1)", [occ[1]]);
    expect((await all()).map((n) => n.user_id)).toEqual([lena]);
    await sql("update public.event_series set status = 'removed' where id = $1", [id]);
    expect((await sql<{ v: boolean }>("select findmaxxing_private.visible_to($1, 'series', $2) as v", [lena, id]))[0].v).toBe(false);
  });
});

describe("service-origin changes are not silent", () => {
  it("the deadline decision tells people going and the series' followers, once, however often the cron runs", async () => {
    const { id, occ } = await makeSeries(owner, { min_attendance: 3, decision_lead_minutes: 60 });
    await join(maya, occ[0]);
    await follow(theo, id);
    const [{ d }] = await sql<{ d: string }>("select (decision_deadline + interval '1 minute')::text as d from public.events where id = $1", [occ[0]]);
    for (let i = 0; i < 2; i++) await service("select public.decide_sessions($1::timestamptz)", [d]);
    expect((await notes(maya)).map((n) => [n.type, n.dedupe_key, n.actor_id])).toEqual([["event_not_happening", `event_not_happening:${occ[0]}`, null]]);
    expect((await notes(theo)).map((n) => [n.type, n.detail])).toEqual([["series_update", "cancel"]]);
  });

  it("the deletion job closing a host's account tells the people going and each series' followers once", async () => {
    const { id, occ } = await makeSeries(priya);
    await join(maya, occ[0]);
    await join(theo, occ[1]);
    await follow(jules, id);
    await service("select public.prepare_account_deletion($1)", [priya]);
    // (Priya's seeded one-off events are cancelled and announced too; only this series' are checked here.)
    const ours = async (w: string) => (await notes(w)).filter((n) => n.subject_id === null || occ.includes(n.subject_id) || n.type === "series_update");
    expect((await ours(maya)).map((n) => [n.type, n.subject_id])).toEqual([["event_cancelled", occ[0]]]);
    expect((await ours(theo)).map((n) => [n.type, n.subject_id])).toEqual([["event_cancelled", occ[1]]]);
    // Jules is going to one of Priya's seeded one-off events, which is cancelled too; that says nothing about this series.
    expect(await sql("select 1 from public.event_attendees a join public.events e on e.id = a.event_id where a.user_id = $1 and e.creator_id = $2 and e.series_id is null", [jules, priya])).not.toEqual([]);
    expect((await notes(jules, "series_update")).map((n) => [n.type, n.detail])).toEqual([["series_update", "ended"]]);
    // Run again (the job retries): nothing new.
    const before = (await all()).length;
    await service("select public.prepare_account_deletion($1)", [priya]);
    expect((await all()).length).toBe(before);
  });

  it("the generator, which only adds sessions, tells nobody", async () => {
    const { id } = await makeSeries();
    await follow(theo, id);
    await service("select public.generate_series_occurrences($1, now() + interval '7 days')", [id]);
    expect(await all()).toEqual([]);
  });
});

describe("with one guard removed", () => {
  const swap = async (from: string, to: string, run: () => Promise<void>) => {
    const fnStart = MIGRATION.lastIndexOf("create or replace function", MIGRATION.indexOf(from));
    const body = MIGRATION.slice(fnStart, MIGRATION.indexOf("end $$;", fnStart) + "end $$;".length);
    expect(body).toContain(from);
    await db.exec(body.replace(from, to));
    try { await run(); } finally { await db.exec(body); }
  };

  it("without counting changes, nobody going is told about a change at all", async () => {
    await swap("    new.change_seq := old.change_seq + 1;", "    null;", async () => {
      const { occ } = await makeSeries();
      await join(maya, occ[0]);
      await moveVenue(occ[0], "North steps");
      await moveVenue(occ[0], "South steps");
      expect((await notes(maya, "event_changed")).length).toBe(0);
    });
  });

  it("without the block check in the sender, a person blocked by the host is told", async () => {
    await swap("    continue when v_host is not null and findmaxxing_private.is_blocked_between(r.user_id, v_host);\n", "", async () => {
      const { occ } = await makeSeries();
      await join(maya, occ[0]);
      await sql("insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [owner, maya]);
      await moveVenue(occ[0], "North steps");
      expect((await notes(maya)).length).toBe(1);
    });
  });

  it("without the bulk flag, ending a series sends followers one message per session", async () => {
    await swap("    if new.series_id is not null and coalesce(current_setting('findmaxxing.series_bulk', true), '') <> 'on' then", "    if new.series_id is not null then", async () => {
      const { id, occ } = await makeSeries();
      await follow(theo, id);
      await as(owner, "select public.end_event_series($1)", [id]);
      expect((await notes(theo)).length).toBe(occ.length + 1);
    });
  });

  it("without the explicit send, the deletion job leaves people going uninformed", async () => {
    await swap("      perform findmaxxing_private.notify_event_audience(v_id, 'cancelled', null);", "      null;", async () => {
      const sam = user("sam_k");
      const { occ } = await makeSeries(sam);
      await join(maya, occ[0]);
      await service("select public.prepare_account_deletion($1)", [sam]);
      expect((await notes(maya)).filter((n) => n.subject_id === occ[0])).toEqual([]);
    });
  });
});

describe("the wording and the type list", () => {
  it("names the series and what happened, and nothing else", () => {
    const n = (detail: string) => notificationText({ type: "series_update", label: "Thursday run club", detail, count: 1, subjectType: "event", subjectId: null, actorName: "Marcus" });
    expect([n("schedule"), n("cancel"), n("ended")]).toEqual(["Thursday run club has a new schedule", "One Thursday run club session was cancelled", "Thursday run club has ended"]);
    expect(NOTIFICATION_TYPES.map((t) => t.type)).toContain("series_update");
    expect(DEFAULT_NOTIFICATION_SETTINGS.pushTypes).toContain("series_update");
  });
});

describe("the demo twin sends the same notifications", () => {
  /** One script, written against both. Ids are replaced by their position so the two can be compared. */
  type Script = {
    seriesId: string; occ: string[];
    join(who: string, i: number): Promise<void>; follow(who: string): Promise<void>; block(a: string, b: string): Promise<void>;
    venue(i: number, name: string): Promise<void>; cancel(i: number): Promise<void>; schedule(): Promise<void>; end(): Promise<void>;
    notes(): Promise<{ user: string; type: string; key: string; detail: string | null }[]>;
  };
  const normal = (ids: string[], seriesId: string, k: string | null) => {
    let out = k ?? "";
    ids.forEach((id, i) => { out = out.split(id).join(`#${i}`); });
    return out.split(seriesId).join("S");
  };
  const who = (id: string) => SEED_USERS.find((u) => u.id === id)!.username;

  async function onSql(): Promise<Script> {
    await db.exec("delete from public.notifications; delete from public.blocks; delete from public.notification_settings;");
    const { id, occ } = await makeSeries();
    return {
      seriesId: id, occ,
      join: async (w, i) => { await join(w, occ[i]); }, follow: async (w) => { await follow(w, id); },
      block: async (a, b) => { await sql("insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [a, b]); },
      venue: async (i, name) => { await as(owner, "select public.update_occurrence($1, $2::jsonb)", [occ[i], JSON.stringify({ location_name: name })]); },
      cancel: async (i) => { await as(owner, "select public.cancel_occurrence($1)", [occ[i]]); },
      schedule: async () => { await as(owner, "select public.update_series_from($1, $2::jsonb)", [occ[0], JSON.stringify({ rule: NEW_RULE })]); },
      end: async () => { await as(owner, "select public.end_event_series($1)", [id]); },
      notes: async () => (await all()).map((n) => ({ user: who(n.user_id), type: n.type, key: normal(occ, id, n.dedupe_key), detail: n.detail })),
    };
  }
  async function onDemo(): Promise<Script> {
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    const s = await repo.series.create({ title: "Thursday run club", description: "An easy loop from the fountain, every week, all paces welcome.", categorySlug: "fitness",
      locationName: "Scioto Mile fountain", lat: 39.96, lng: -83.0, timeZone: NY, rule: RULE, tags: [], capacity: 12 }, owner);
    const occ = handle.state.events.filter((e) => e.seriesId === s.id).sort((a, b) => (a.seriesLocalDate! < b.seriesLocalDate! ? -1 : 1)).map((e) => e.id);
    const kept = [...occ];
    return {
      seriesId: s.id, occ: kept,
      join: async (w, i) => { await repo.events.join(w, kept[i]); }, follow: async (w) => { await repo.series.follow(w, s.id); },
      block: async (a, b) => { handle.state.blocks.push({ blockerId: a, blockedId: b, createdAt: new Date().toISOString() }); },
      venue: async (i, name) => { await repo.series.updateOccurrence(owner, kept[i], { locationName: name }); },
      cancel: async (i) => { await repo.series.cancelOccurrence(owner, kept[i]); },
      schedule: async () => { await repo.series.updateFrom(owner, kept[0], { rule: NEW_RULE }); },
      end: async () => { await repo.series.end(owner, s.id); },
      notes: async () => handle.state.notifications.filter((n) => n.type !== "event_joined").map((n) => ({ user: who(n.userId), type: n.type, key: normal(kept, s.id, n.dedupeKey), detail: n.detail })),
    };
  }
  const sorted = (xs: { user: string; type: string; key: string; detail: string | null }[]) =>
    xs.map((x) => `${x.user} ${x.type} ${x.key} ${x.detail ?? ""}`).filter((x) => !/ event_joined /.test(x)).sort();

  it("going, following, a block, a venue change, a cancelled session, a schedule change and the end", async () => {
    const play = async (b: Script) => {
      await b.join(maya, 0); await b.join(jules, 1); await b.join(theo, 2);
      await b.follow(maya); await b.follow(lena); await b.follow(jules);
      await b.block(owner, theo);
      await b.venue(0, "North steps");
      await b.venue(0, "South steps");
      await b.cancel(3);
      await b.schedule();
      await b.end();
      return sorted(await b.notes());
    };
    const fromSql = await play(await onSql());
    const fromDemo = await play(await onDemo());
    expect(fromDemo).toEqual(fromSql);
    // And the SQL result is what the contract says.
    expect(fromSql).toEqual(expect.arrayContaining([
      "maya_r event_changed event_changed:#0:1 ", "maya_r event_changed event_changed:#0:2 ", "jules event_changed event_changed:#1:1 ",
      "lena series_update series_update:S:cancel:#3 cancel", "lena series_update series_update:S:v2 schedule", "lena series_update series_update:S:ended ended",
    ]));
    expect(fromSql.some((x) => x.startsWith("theo "))).toBe(false);
    expect(fromSql.filter((x) => x.startsWith("lena ")).length).toBe(3);
    // Jules follows and is going to a session that moved: told about the session, not sent the schedule update.
    expect(fromSql.some((x) => x.startsWith("jules series_update") && x.includes(":v2"))).toBe(false);
  });

  it("the deadline decision", async () => {
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    const s = await repo.series.create({ title: "Thursday run club", description: "An easy loop from the fountain, every week, all paces welcome.", categorySlug: "fitness",
      locationName: "Scioto Mile fountain", lat: 39.96, lng: -83.0, timeZone: NY, rule: RULE, tags: [], capacity: 12, minAttendance: 3, decisionLeadMinutes: 60 }, owner);
    const first = handle.state.events.filter((e) => e.seriesId === s.id).sort((a, b) => (a.seriesLocalDate! < b.seriesLocalDate! ? -1 : 1))[0];
    await repo.events.join(maya, first.id);
    await repo.series.follow(theo, s.id);
    const at = new Date(Date.parse(first.decisionDeadline!) + 60_000).toISOString();
    decideDemoSessions(handle.state, at, () => {});
    decideDemoSessions(handle.state, at, () => {});
    expect(handle.state.notifications.filter((n) => n.type !== "event_joined").map((n) => [who(n.userId), n.type, n.detail]).sort())
      // The host is going too, and is told, as the SQL sender does (actor null).
      .toEqual([["marcus", "event_not_happening", null], ["maya_r", "event_not_happening", null], ["theo", "series_update", "cancel"]]);
  });
});
