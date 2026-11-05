/**
 * Roadmap 4.6: material-change notifications (0057, 4.0 spec §9). Only affected people hear, once each
 * (deduped), through the existing notify() pipeline (blocks, mutes, push types; quiet hours and the
 * daily cap apply at push time). PGlite and demo parity on the same scenario.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { ALL_NOTIFICATION_TYPES, notificationHref, notificationText } from "../packages/shared/src/notifications";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), nina = user("nina"), lena = user("lena"), dev = user("dev"), jules = user("jules"), priya = user("priya");
const HOUR = 3_600_000;

describe("database (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  /** capacity 2: theo going, nina offered after a leave, lena waitlisted, dev interested, jules follows the series. */
  const scene = async () => {
    const [{ id: series }] = await queryAs<{ id: string }>(db, maya, `select public.create_series('Notify run', 'A run to test notifications.', 'fitness', null, 'Goodale', null, 39.97, -83,
      'America/New_York', '{1,2,3,4,5,6,7}', 1, '19:00', 60, current_date, null, 2, 2, 60, null, null, null, '{}') as id`);
    const [{ id: ev }] = (await db.query<{ id: string }>("select id from public.events where series_id = $1 order by starts_at offset 1 limit 1", [series])).rows;
    const r = (who: string, sql: string) => queryAs(db, who, sql, [ev]);
    await r(priya, "select public.join_event($1)");
    await r(theo, "select public.join_event($1)");
    await r(nina, "select public.join_event($1)");
    await r(lena, "select public.join_event($1)");
    await r(priya, "select public.leave_event($1)"); // nina offered
    await r(dev, "select public.set_interest($1, true)");
    await queryAs(db, jules, "select public.follow_series($1, true)", [series]);
    await db.query("delete from public.notifications");
    only = [series, ev];
    return { series, ev };
  };
  // Only this scene's event and series (earlier scenes share the database and the people).
  let only: string[] = [];
  const notes = async () => (await db.query<{ user_id: string; type: string }>("select user_id, type from public.notifications where type not like 'event_offer%' and subject_id = any($1)", [only])).rows.map((n) => `${n.type}:${SEED_USERS.find((u) => u.id === n.user_id)!.username}`).sort();

  it("time or venue changed → going + offered only; title, description and capacity are not material", async () => {
    const { ev } = await scene();
    await queryAs(db, maya, "update public.events set title = 'Renamed run', description = 'New words for the run here.', capacity = 3 where id = $1", [ev]);
    // Not material: nobody hears (the capacity increase only offers the freed seat to lena: an offer, 0054).
    expect(await notes()).toEqual([]);
    await queryAs(db, maya, "update public.events set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [ev]);
    expect(await notes()).toEqual(["event_changed:lena", "event_changed:nina", "event_changed:theo"]); // lena now holds an offer
  });

  it("cancelled by a host → going, offered, waitlisted and interested, once each; followers get a series update", async () => {
    const { ev } = await scene();
    await queryAs(db, maya, "select public.cancel_occurrence($1)", [ev]);
    expect(await notes()).toEqual(["event_cancelled:dev", "event_cancelled:lena", "event_cancelled:nina", "event_cancelled:theo", "series_update:jules"]);
  });

  it("cancelled below minimum (cron) → event_not_happening to the same audience, deduped across runs", async () => {
    const { ev } = await scene();
    await db.query("update public.events set capacity = 3, min_attendance = 3 where id = $1", [ev]);
    const [{ d }] = (await db.query<{ d: Date }>("select decision_deadline as d from public.events where id = $1", [ev])).rows;
    await db.query("select public.decide_sessions($1)", [d]);
    await db.query("select public.decide_sessions($1)", [new Date(d.getTime() + 60_000)]);
    expect(await notes()).toEqual(["event_not_happening:dev", "event_not_happening:lena", "event_not_happening:nina", "event_not_happening:theo", "series_update:jules"]);
  });

  it("a series schedule change reaches followers once per change; ending a series once, not once per date", async () => {
    const { series, ev } = await scene();
    await queryAs(db, maya, "select public.update_series_from($1, 'Notify run', 'A run to test notifications.', null, 'Goodale', null, 39.97, -83, '{1,2,3,4,5,6}', 1, '18:00', 60, 2)", [ev]);
    expect((await notes()).filter((n) => n.startsWith("series_update"))).toEqual(["series_update:jules"]);
    await db.query("delete from public.notifications");
    await queryAs(db, maya, "select public.end_series($1, current_date)", [series]);
    expect((await notes()).filter((n) => n.startsWith("series_update"))).toEqual(["series_update:jules"]);
  });

  it("blocks and mutes apply (notify pipeline); new types are pushed by default and accepted in settings", async () => {
    const { ev } = await scene();
    await db.query("insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [theo, maya]);
    await queryAs(db, nina, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['event_cancelled'])");
    await queryAs(db, maya, "select public.cancel_occurrence($1)", [ev]);
    const got = await notes();
    expect(got).not.toContain("event_cancelled:theo"); // theo blocked the host
    expect(got).not.toContain("event_cancelled:nina"); // nina muted cancellations
    expect(got).toContain("event_cancelled:lena");
    expect((await db.query<{ push_state: string }>("select push_state from public.notifications where user_id = $1", [lena])).rows[0].push_state).toBe("pending");
    await expect(queryAs(db, lena, "insert into public.notification_settings (user_id, push_types) values (auth.uid(), array['event_not_happening', 'series_update', 'event_offer'])")).resolves.toBeDefined();
    await expect(queryAs(db, dev, "insert into public.notification_settings (user_id, push_types) values (auth.uid(), array['made_up'])")).rejects.toThrow(/bad_type/);
  });

  it("the SQL type list equals the app's", async () => {
    const def = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_type_check'")).rows[0].d;
    const sqlTypes = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlTypes).toEqual([...ALL_NOTIFICATION_TYPES].sort());
  });
});

describe("demo parity and wording", () => {
  let repo: DataRepository;
  beforeEach(() => { repo = createDemoRepository(createIsolatedStore()); });
  const scene = async () => {
    const { seriesId } = await repo.series.create({ title: "Notify run", description: "A run to test notifications.", categorySlug: "fitness", locationName: "Goodale", lat: 39.97, lng: -83, timeZone: "America/New_York", rule: { weekdays: [1, 2, 3, 4, 5, 6, 7], intervalWeeks: 1, startLocal: "19:00", durationMinutes: 60, startsOn: new Date().toISOString().slice(0, 10), endsOn: null }, capacity: 2, minAttendance: 2, decisionLeadMinutes: 60, tags: [] }, maya);
    const ev = (await repo.series.occurrences(seriesId, maya))[1].id;
    await repo.events.join(priya, ev); await repo.events.join(theo, ev); await repo.events.join(nina, ev); await repo.events.join(lena, ev);
    await repo.events.leave(priya, ev);
    await repo.events.setInterest(dev, ev, true);
    await repo.series.follow(jules, seriesId, true);
    return { seriesId, ev };
  };
  const got = async (types: string[]) => {
    const out: string[] = [];
    for (const u of [theo, nina, lena, dev, jules, priya]) for (const n of (await repo.notifications.list(u)).items) if (types.includes(n.type)) out.push(`${n.type}:${SEED_USERS.find((x) => x.id === u)!.username}`);
    return out.sort();
  };

  it("host cancel and time change reach the same people as SQL", async () => {
    const { ev } = await scene();
    const e = (await repo.events.get(ev, maya))!;
    await repo.series.updateOccurrence(maya, ev, { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: new Date(Date.parse(e.startsAt) + HOUR).toISOString(), endsAt: e.endsAt ? new Date(Date.parse(e.endsAt) + HOUR).toISOString() : null, categorySlug: e.categorySlug, capacity: e.capacity, tags: [] });
    expect(await got(["event_changed"])).toEqual(["event_changed:nina", "event_changed:theo"]);
    await repo.series.cancelOccurrence(maya, ev);
    expect(await got(["event_cancelled", "series_update"])).toEqual(["event_cancelled:dev", "event_cancelled:lena", "event_cancelled:nina", "event_cancelled:theo", "series_update:jules"]);
  });

  it("below minimum at the deadline → event_not_happening + follower update, once", async () => {
    const { ev } = await scene();
    const e = (await repo.events.get(ev, maya))!;
    await repo.events.update(ev, { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: [], minAttendance: 2 }, maya).catch(() => undefined);
    await repo.events.decideSessions(e.decisionDeadline!);
    await repo.events.decideSessions(e.decisionDeadline!);
    const n = await got(["event_not_happening", "series_update"]);
    // going is theo only (1 < 2): called off.
    expect(n).toEqual(["event_not_happening:dev", "event_not_happening:lena", "event_not_happening:nina", "event_not_happening:theo", "series_update:jules"]);
  });

  it("wording and links for the new types", () => {
    expect(notificationText({ type: "event_not_happening", label: "Notify run", detail: null, count: 1, subjectType: "event", subjectId: "e", actorName: null })).toBe("Notify run isn't happening: not enough people signed up");
    expect(notificationText({ type: "series_update", label: "Notify run", detail: "The schedule changed", count: 1, subjectType: "series", subjectId: "s", actorName: null })).toBe("Notify run: the schedule changed");
    expect(notificationHref({ type: "series_update", subjectType: "series", subjectId: "s1", actorUsername: null })).toBe("/series/s1");
  });
});
