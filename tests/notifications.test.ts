/**
 * Notifications (Session 16): owner-only rows written by triggers, batching
 * and dedupe, blocking and preferences, scheduled reminders, the push claim
 * (quiet hours, the daily cap, never twice), retention, the push pipeline with
 * a mocked sender, the cron route, the actions, and parity with the demo store.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, migrateDemoState, buildSeedState, type DemoState } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import type { DataRepository } from "../src/lib/data/repository";
import type { PushDevice } from "../src/lib/data/types";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { DEFAULT_NOTIFICATION_SETTINGS, notificationText } from "../src/lib/notifications";

vi.mock("server-only", () => ({}));
const { runNotificationJobs, pushPayload } = await import("../src/server/notifications/push");

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, theo, jules, nina, sam, dev, lena] = ["maya_r", "theo", "jules", "nina", "sam_k", "dev", "lena"].map(user);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Provider-shaped fixture URLs; sends remain mocked and never contact FCM.
const device = (n: number): PushDevice => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: `key${n}`, auth: `auth${n}` });
const meeple = stableId("place:Meeple Cellar");

/** An upcoming published event (and its creator) that nina is not going to and that has room. */
function openEvent(state: DemoState) {
  const ev = state.events.find((e) => {
    const going = state.eventAttendees.filter((a) => a.eventId === e.id);
    return e.status === "published" && Date.parse(e.startsAt) > Date.now() + 2 * 86_400_000 && e.creatorId !== nina
      && !going.some((a) => a.userId === nina) && (e.capacity === null || going.length < e.capacity - 1);
  });
  if (!ev) throw new Error("no open event");
  return ev;
}

type N = { id: string; type: string; user_id: string; actor_id: string | null; subject_id: string | null; label: string | null; count: number; push_state: string; detail: string | null; read_at: string | null };

describe("notifications in the database", () => {
  let db: PGlite;
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
    await db.exec("set role service_role");
    try {
      return (await db.query<T>(sql, p)).rows;
    } finally {
      await db.exec("reset role");
    }
  };
  const mine = (id: string, type?: string) => db.query<N>(`select * from public.notifications where user_id = $1 ${type ? "and type = $2" : ""} order by created_at`, type ? [id, type] : [id]).then((r) => r.rows);
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("starts empty: seeds and the service role notify nobody", async () => {
    expect((await db.query("select * from public.notifications")).rows).toEqual([]);
  });

  it("notifies a new follower once, even after unfollowing and following again", async () => {
    for (let i = 0; i < 2; i++) {
      await as(nina, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [theo]);
      await as(nina, "delete from public.follows where follower_id = auth.uid() and following_id = $1", [theo]);
    }
    expect((await mine(theo, "new_follower")).map((n) => [n.actor_id, n.push_state])).toEqual([[nina, "pending"]]);
  });

  it("keeps notifications to their owner, who can only mark them read", async () => {
    const [n] = await mine(theo, "new_follower");
    expect(await as(nina, "select * from public.notifications where id = $1", [n.id])).toEqual([]);
    expect((await as(null, "select * from public.notifications").catch(() => []))).toEqual([]);
    const id = n.id;
    await expect(as(theo, "insert into public.notifications (user_id, type) values (auth.uid(), 'new_follower')")).rejects.toThrow(/permission denied/);
    await expect(as(theo, "update public.notifications set count = 99 where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(as(theo, "update public.notifications set user_id = $2 where id = $1", [id, nina])).rejects.toThrow(/permission denied/);
    await as(nina, "update public.notifications set read_at = now() where id = $1", [id]);
    expect((await mine(theo, "new_follower"))[0].read_at).toBeNull();
    expect((await as<{ n: number }>(theo, "select public.mark_notifications_read() as n"))[0].n).toBe(1);
    expect((await mine(theo, "new_follower"))[0].read_at).not.toBeNull();
    // Settings, devices and the push log are private too.
    await as(theo, "insert into public.notification_settings (user_id) values (auth.uid())");
    expect(await as(nina, "select * from public.notification_settings")).toEqual([]);
    await as(theo, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/theo', 'k', 'a')");
    expect(await as(nina, "select * from public.push_subscriptions")).toEqual([]);
    await expect(as(theo, "insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), 'https://x.test', 'k', 'a')")).rejects.toThrow(/permission denied/);
    await expect(as(theo, "select * from public.push_log")).rejects.toThrow(/permission denied/);
  });

  it("batches joins, saves, ratings and messages into one unread notification each", async () => {
    const ev = openEvent(createIsolatedStore().state);
    await as(nina, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev.id]);
    await as(lena, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev.id]).catch(() => {});
    const joined = await mine(ev.creatorId!, "event_joined");
    expect(joined).toHaveLength(1);
    expect(joined[0].count).toBeGreaterThanOrEqual(1);
    expect(joined[0].label).toBe(ev.title);
    // Saves never say who.
    const owner = (await db.query<{ creator_id: string; name: string }>("select creator_id, name from public.places where id = $1", [meeple])).rows[0];
    const savers = SEED_USERS.map((u) => u.id).filter((id) => id !== owner.creator_id).slice(0, 3);
    for (const s of savers) await as(s, "insert into public.saved_places (user_id, place_id) values (auth.uid(), $1) on conflict do nothing", [meeple]);
    const saved = await mine(owner.creator_id, "place_saved");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ actor_id: null, label: owner.name, push_state: "none" });
    // After reading, the next one starts a new notification.
    await as(owner.creator_id, "select public.mark_notifications_read()");
    await as(nina, "insert into public.saved_places (user_id, place_id) values (auth.uid(), $1) on conflict do nothing", [meeple]);
    expect((await mine(owner.creator_id, "place_saved")).map((n) => [n.count, !!n.read_at])).toEqual(expect.arrayContaining([[1, false]]));
  });

  it("tells message recipients without copying the text, and reading the chat reads it", async () => {
    const conv = (await as<{ id: string }>(maya, "select public.start_direct($1) as id", [theo]))[0].id;
    for (const body of ["secret plan one", "secret plan two"]) {
      await sleep(2);
      await as(maya, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), $2)", [conv, body]);
    }
    const [n] = await mine(theo, "new_message");
    expect(n).toMatchObject({ count: 2, actor_id: maya, subject_id: conv, label: null });
    expect(JSON.stringify(n)).not.toMatch(/secret plan/);
    await as(theo, "select public.mark_read($1)", [conv]);
    expect((await mine(theo, "new_message"))[0].read_at).not.toBeNull();
  });

  it("does not notify someone about a person they blocked, or about a muted type", async () => {
    await as(jules, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), $1)", [dev]);
    await as(dev, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1) on conflict do nothing", [jules]);
    expect((await mine(jules, "new_follower")).filter((n) => n.actor_id === dev)).toEqual([]);
    await as(jules, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['new_follower'])");
    await as(lena, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1) on conflict do nothing", [jules]);
    expect((await mine(jules, "new_follower")).filter((n) => n.actor_id === lena)).toEqual([]);
  });

  it("refuses unknown time zones and types in settings", async () => {
    await expect(as(lena, "insert into public.notification_settings (user_id, time_zone) values (auth.uid(), 'Mars/Olympus')")).rejects.toThrow(/time zone/);
    await expect(as(lena, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['nope'])")).rejects.toThrow(/notifications:bad_type/);
    await expect(as(lena, "insert into public.notification_settings (user_id, quiet_start) values (auth.uid(), 22)")).rejects.toThrow(/check constraint/);
  });

  it("tells attendees about changes and cancellations, and reporters and owners about moderation", async () => {
    const ev = (await db.query<{ id: string; creator_id: string; title: string; starts_at: string }>(
      `select e.id, e.creator_id, e.title, e.starts_at from public.events e where e.status = 'published' and e.starts_at > now() + interval '2 days'
         and (select count(*) from public.event_attendees a where a.event_id = e.id and a.user_id <> e.creator_id) > 0 limit 1`)).rows[0];
    const others = (await db.query<{ user_id: string }>("select user_id from public.event_attendees where event_id = $1 and user_id <> $2", [ev.id, ev.creator_id])).rows.map((r) => r.user_id);
    await as(ev.creator_id, "update public.events set starts_at = starts_at + interval '1 hour' where id = $1", [ev.id]);
    await as(ev.creator_id, "update public.events set description = 'A different, long enough description' where id = $1", [ev.id]);
    for (const o of others) expect((await mine(o, "event_changed")).filter((n) => n.subject_id === ev.id).map((n) => n.count)).toEqual([1]);
    expect((await mine(ev.creator_id, "event_changed")).filter((n) => n.subject_id === ev.id)).toEqual([]);
    await as(ev.creator_id, "update public.events set status = 'cancelled' where id = $1", [ev.id]);
    for (const o of others) expect((await mine(o, "event_cancelled")).filter((n) => n.subject_id === ev.id)).toHaveLength(1);

    // A report on someone's place, resolved by a moderator who removes it.
    const place = (await db.query<{ id: string; creator_id: string }>("select id, creator_id from public.places where creator_id = $1 and status = 'published' limit 1", [lena])).rows[0];
    await as(nina, "insert into public.reports (reporter_id, target_type, target_id, reason) values (auth.uid(), 'place', $1, 'spam')", [place.id]);
    await as(sam, "select * from public.moderate_target('place', $1, 'remove', 'spam')", [place.id]);
    expect((await mine(nina, "report_resolved")).map((n) => n.detail)).toContain("reviewed");
    expect((await mine(lena, "content_moderated")).find((n) => n.subject_id === place.id)).toMatchObject({ detail: "remove", actor_id: null });
  });

  it("schedules reminders once, the day before and within the hour, for the service role only", async () => {
    const ev = (await db.query<{ id: string; starts_at: Date }>(
      "select e.id, e.starts_at from public.events e where e.status = 'published' and e.starts_at > now() + interval '1 day' order by e.starts_at limit 1")).rows[0];
    const attendees = (await db.query<{ user_id: string }>("select user_id from public.event_attendees where event_id = $1", [ev.id])).rows.map((r) => r.user_id);
    const at = (ms: number) => new Date(new Date(ev.starts_at).getTime() - ms).toISOString();
    await expect(as(maya, "select public.schedule_event_reminders(now())")).rejects.toThrow(/permission denied/);
    await service("select public.schedule_event_reminders($1)", [at(10 * 3600_000)]);
    expect(await service("select public.schedule_event_reminders($1) as n", [at(10 * 3600_000)])).toEqual([{ n: 0 }]);
    for (const a of attendees) expect((await mine(a, "event_tomorrow")).filter((n) => n.subject_id === ev.id)).toHaveLength(1);
    await service("select public.schedule_event_reminders($1)", [at(30 * 60_000)]);
    await service("select public.schedule_event_reminders($1)", [at(10 * 60_000)]);
    for (const a of attendees) expect((await mine(a, "event_soon")).filter((n) => n.subject_id === ev.id)).toHaveLength(1);
  });

  it("claims each push once, honouring devices, preferences, quiet hours and the daily cap", async () => {
    const claim = (now: string) => service<{ notification_id: string; user_id: string; devices: PushDevice[] }>("select * from public.claim_push_batch($1, 100, 5)", [now]);
    await expect(as(maya, "select * from public.claim_push_batch(now(), 100, 5)")).rejects.toThrow(/permission denied/);
    // Everyone without a device: skipped, never sent later.
    const first = await claim(new Date().toISOString());
    const theoClaims = first.filter((c) => c.user_id === theo);
    expect(theoClaims.length).toBeGreaterThan(0); // theo has a device (earlier test)
    expect(theoClaims[0].devices).toEqual([{ kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/theo", p256dh: "k", auth: "a" }]);
    expect(first.every((c) => c.user_id === theo)).toBe(true);
    expect(await claim(new Date().toISOString())).toEqual([]); // nothing twice
    expect((await db.query("select 1 from public.notifications where push_state = 'pending'")).rows).toEqual([]);

    // Quiet hours (theo, 22:00-07:00 in New York): waits, then goes. (A fresh day's allowance.)
    await db.query("delete from public.push_log where user_id = $1", [theo]);
    await as(theo, "update public.notification_settings set quiet_start = 22, quiet_end = 7 where user_id = auth.uid()");
    await as(maya, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1) on conflict do nothing", [theo]);
    await db.query("delete from public.follows where follower_id = $1 and following_id = $2", [maya, theo]);
    await as(maya, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [theo]);
    const pending = (await mine(theo, "new_follower")).filter((n) => n.actor_id === maya);
    expect(pending.map((n) => n.push_state)).toEqual(["pending"]);
    // The next 01:00 and 10:00 in New York (05:00 / 14:00 UTC), both within the
    // 24 hours a push stays claimable, whatever time of day the suite runs.
    const nextUtcHour = (hour: number) => {
      const d = new Date();
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setTime(d.getTime() + 86_400_000);
      return d;
    };
    expect(await claim(nextUtcHour(5).toISOString())).toEqual([]); // 01:00 (00:00 in winter): quiet
    expect((await claim(nextUtcHour(14).toISOString())).map((c) => c.user_id)).toEqual([theo]); // 10:00 (09:00)

    // The cap: at most 5 in 24 hours; the rest stay in-app.
    await as(theo, "update public.notification_settings set quiet_start = null, quiet_end = null where user_id = auth.uid()");
    const sent = Number((await db.query<{ n: number }>("select count(*)::int as n from public.push_log where user_id = $1", [theo])).rows[0].n);
    for (let i = sent; i < 7; i++) {
      await db.query("insert into public.notifications (user_id, type, push_state) values ($1, 'trip_plan_ready', 'pending')", [theo]);
    }
    await claim(new Date().toISOString());
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.push_log where user_id = $1", [theo])).rows[0].n)).toBe(5);
    expect((await mine(theo)).filter((n) => n.push_state === "capped").length).toBeGreaterThan(0);

    // Push turned off for a type, and stale ones, are skipped.
    await as(theo, "update public.notification_settings set push_types = '{}' where user_id = auth.uid()");
    await db.query("delete from public.push_log where user_id = $1", [theo]);
    await db.query("insert into public.notifications (user_id, type, push_state) values ($1, 'new_follower', 'pending')", [theo]);
    await db.query("insert into public.notifications (user_id, type, push_state, created_at) values ($1, 'trip_plan_ready', 'pending', now() - interval '2 days')", [nina]);
    await as(nina, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/nina', 'k', 'a')");
    expect(await claim(new Date().toISOString())).toEqual([]);
    expect((await db.query("select push_state from public.notifications where push_state = 'pending'")).rows).toEqual([]);
  });

  it("moves a device to whoever signed in on it last, and keeps ten per person", async () => {
    await as(maya, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'k', 'a')");
    await as(dev, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/shared', 'k', 'a')");
    expect((await db.query("select user_id from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/shared'")).rows).toEqual([{ user_id: dev }]);
    for (let i = 0; i < 12; i++) await as(dev, "select public.save_push_subscription($1, 'k', 'a')", [`https://fcm.googleapis.com/fcm/send/dev${i}`]);
    expect((await db.query("select count(*)::int as n from public.push_subscriptions where user_id = $1", [dev])).rows).toEqual([{ n: 10 }]);
    await expect(as(dev, "select public.save_push_subscription('http://insecure.test', 'k', 'a')")).rejects.toThrow(/Invalid push subscription/);
  });

  it("purges old read notifications and the push log", async () => {
    await db.query("update public.notifications set updated_at = now() - interval '100 days' where user_id = $1 and read_at is not null", [theo]);
    const n = (await service<{ n: number }>("select public.purge_notifications(now()) as n"))[0].n;
    expect(n).toBeGreaterThan(0);
    expect((await db.query("select 1 from public.notifications where user_id = $1 and read_at is not null and updated_at < now() - interval '90 days'", [theo])).rows).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Parity
// ----------------------------------------------------------------------------
describe("notification parity", () => {
  it("creates the same notifications, and claims the same pushes, in SQL and the demo store", async () => {
    const db = await createSeededDb();
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    // Same event times on both sides.
    await db.exec("alter table public.events disable trigger guard_owner_event_change; alter table public.events disable trigger events_notify;");
    for (const e of handle.state.events) await db.query("update public.events set starts_at = $2, ends_at = $3 where id = $1", [e.id, e.startsAt, e.endsAt]);
    await db.exec("alter table public.events enable trigger guard_owner_event_change; alter table public.events enable trigger events_notify;");
    const ev = openEvent(handle.state);
    const q = (id: string, sql: string, p: unknown[] = []) => queryAs(db, id, sql, p);
    const steps: [() => Promise<unknown>, () => Promise<unknown>][] = [
      [() => q(nina, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [theo]), () => repo.profiles.follow(nina, theo)],
      [() => q(nina, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev.id]), () => repo.events.join(nina, ev.id)],
      [() => q(nina, "insert into public.saved_places (user_id, place_id) values (auth.uid(), $1)", [meeple]), () => repo.places.save(nina, meeple)],
      [() => q(nina, "insert into public.place_ratings (user_id, place_id, score) values (auth.uid(), $1, 5)", [meeple]), () => repo.places.rate(nina, meeple, 5, null)],
      [() => q(theo, "insert into public.notification_settings (user_id, push_types, quiet_start, quiet_end) values (auth.uid(), array['new_message'], 1, 2)"),
        () => repo.notifications.updateSettings(theo, { ...DEFAULT_NOTIFICATION_SETTINGS, pushTypes: ["new_message"], quietStart: 1, quietEnd: 2 })],
      [() => q(theo, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/t', 'k', 'a')"), () => repo.notifications.addDevice(theo, { endpoint: "https://fcm.googleapis.com/fcm/send/t", p256dh: "k", auth: "a" })],
      [() => q(maya, "select public.start_direct($1)", [theo]), () => repo.messaging.startDirect(maya, theo)],
      [() => q(theo, "select public.notify_trip_plan_ready('Saturday')"), () => repo.notifications.tripPlanReady(theo, "Saturday")],
    ];
    for (const [sql, demo] of steps) {
      await sql();
      await demo();
      await sleep(3);
    }
    const sqlConv = (await q(maya, "select public.start_direct($1) as id", [theo]))[0] as { id: string };
    const demoConv = await repo.messaging.startDirect(maya, theo);
    for (const body of ["one", "two"]) {
      await q(maya, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), $2)", [sqlConv.id, body]);
      await repo.messaging.send(maya, demoConv, body);
      await sleep(3);
    }
    const now = new Date(Date.parse(ev.startsAt) - 10 * 3600_000).toISOString();
    await db.exec("set role service_role");
    const sqlReminders = (await db.query<{ n: number }>("select public.schedule_event_reminders($1) as n", [now])).rows[0].n;
    await db.exec("reset role");
    expect(await repo.notifications.scheduleReminders(now)).toBe(sqlReminders);

    const usernames = new Map(SEED_USERS.map((u) => [u.id, u.username]));
    const shape = (r: { type: string; actor: string | null; subject: string | null; label: string | null; count: number; detail: string | null; push: string; read: boolean }) =>
      JSON.stringify([r.type, r.actor ? usernames.get(r.actor) : null, r.subject === sqlConv.id || r.subject === demoConv ? "conv" : r.subject, r.label, r.count, r.detail, r.push, r.read]);
    for (const u of SEED_USERS) {
      const sqlRows = (await db.query<N & { subject_id: string | null }>("select * from public.notifications where user_id = $1", [u.id])).rows
        .map((n) => shape({ type: n.type, actor: n.actor_id, subject: n.subject_id, label: n.label, count: n.count, detail: n.detail, push: n.push_state, read: !!n.read_at })).sort();
      const demoRows = handle.state.notifications.filter((n) => n.userId === u.id)
        .map((n) => shape({ type: n.type, actor: n.actorId, subject: n.subjectId, label: n.label, count: n.count, detail: n.detail, push: n.pushState, read: !!n.readAt })).sort();
      expect([u.username, demoRows]).toEqual([u.username, sqlRows]);
      expect(await repo.notifications.unreadCount(u.id)).toBe(Number((await db.query<{ n: number }>("select count(*)::int as n from public.notifications where user_id = $1 and read_at is null", [u.id])).rows[0].n));
    }
    // Pushes: theo's quiet hours are 01:00-02:00 New York; claim at 01:30 and at noon.
    for (const hourUtc of [5.5, 16]) {
      const at = new Date(); at.setUTCHours(Math.floor(hourUtc), (hourUtc % 1) * 60, 0, 0);
      await db.exec("set role service_role");
      const sqlClaims = (await db.query<{ user_id: string; type: string; count: number }>("select * from public.claim_push_batch($1, 100, 5)", [at.toISOString()])).rows;
      await db.exec("reset role");
      const demoClaims = await repo.notifications.claimPushes(at.toISOString());
      expect(demoClaims.map((c) => [c.userId, c.type, c.count])).toEqual(sqlClaims.map((c) => [c.user_id, c.type, c.count]));
    }
    expect(handle.state.notifications.map((n) => n.pushState).sort()).toEqual((await db.query<{ push_state: string }>("select push_state from public.notifications")).rows.map((r) => r.push_state).sort());
  }, 120_000);

  it("deletes a person's notifications and devices with their account, and forgets them as an actor", async () => {
    const db = await createSeededDb();
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    await queryAs(db, nina, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [theo]);
    await queryAs(db, theo, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [nina]);
    await queryAs(db, nina, "select public.save_push_subscription('https://fcm.googleapis.com/fcm/send/n', 'k', 'a')");
    await repo.profiles.follow(nina, theo);
    await repo.profiles.follow(theo, nina);
    await repo.notifications.addDevice(nina, device(1));
    await db.query("delete from auth.users where id = $1", [nina]);
    deleteDemoAccount(handle, nina);
    const sqlRows = (await db.query<{ user_id: string; actor_id: string | null }>("select user_id, actor_id from public.notifications")).rows;
    expect(handle.state.notifications.map((n) => [n.userId, n.actorId])).toEqual(sqlRows.map((r) => [r.user_id, r.actor_id]));
    expect(sqlRows).toEqual([{ user_id: theo, actor_id: null }]);
    expect(handle.state.pushSubscriptions).toEqual([]);
    expect((await db.query("select * from public.push_subscriptions")).rows).toEqual([]);
  }, 120_000);
});

// ----------------------------------------------------------------------------
// Push pipeline, route, actions
// ----------------------------------------------------------------------------
describe("the push pipeline", () => {
  let repo: DataRepository;
  let handle: ReturnType<typeof createIsolatedStore>;
  beforeEach(() => {
    handle = createIsolatedStore();
    repo = createDemoRepository(handle);
    // Seed events are scheduled relative to now, and theo attends several: at
    // some hours one falls in the reminder window and adds pushes these tests
    // did not ask for. Reminders have their own test above.
    handle.state.eventAttendees = handle.state.eventAttendees.filter((a) => a.userId !== theo);
  });
  const fakeSender = (gone: string[] = []) => {
    const sent: { endpoint: string; payload: string }[] = [];
    return {
      sent,
      sender: { send: vi.fn(async (d: PushDevice, payload: string) => (gone.includes(d.endpoint) ? { ok: false as const, gone: true } : (sent.push({ endpoint: d.endpoint, payload }), { ok: true as const }))) },
    };
  };

  it("sends each claimed push to every device once, drops gone devices, and never resends", async () => {
    await repo.notifications.addDevice(theo, device(1));
    await repo.notifications.addDevice(theo, device(2));
    const conv = await repo.messaging.startDirect(maya, theo);
    await repo.messaging.send(maya, conv, "very private words");
    const { sender, sent } = fakeSender([device(2).endpoint]);
    const first = await runNotificationJobs(repo, sender);
    expect(first).toMatchObject({ claimed: 1, sent: 1, failed: 1, dropped: 1 });
    expect(sent[0].endpoint).toBe(device(1).endpoint);
    const payload = JSON.parse(sent[0].payload);
    expect(payload).toMatchObject({ title: "FindMaxxing", body: "@maya_r sent you a message", url: `/messages/${conv}` });
    expect(sent[0].payload).not.toMatch(/private words/);
    expect(handle.state.pushSubscriptions.map((d) => d.endpoint)).toEqual([device(1).endpoint]);
    expect(await runNotificationJobs(repo, sender)).toMatchObject({ claimed: 0, sent: 0 });
  });

  it("claims nothing without a sender (no VAPID keys), so pushes wait", async () => {
    await repo.notifications.addDevice(theo, device(1));
    await repo.profiles.follow(nina, theo);
    expect(await runNotificationJobs(repo, null)).toMatchObject({ claimed: 0 });
    expect(handle.state.notifications.find((n) => n.userId === theo)!.pushState).toBe("pending");
  });

  it("caps pushes at five a day; the rest stay in the app", async () => {
    await repo.notifications.addDevice(theo, device(1));
    // Six people who do not follow theo yet.
    for (const u of [jules, nina, sam, dev, lena, user("priya")]) await repo.profiles.follow(u, theo);
    const { sender } = fakeSender();
    expect((await runNotificationJobs(repo, sender)).sent).toBe(5);
    expect(handle.state.notifications.filter((n) => n.userId === theo && n.pushState === "capped")).toHaveLength(1);
    expect(await repo.notifications.unreadCount(theo)).toBe(6);
  });

  it("words batched notifications sensibly", () => {
    const base = { label: "Sunday pickup soccer", detail: null, subjectType: "event" as const, subjectId: null };
    expect(notificationText({ ...base, type: "event_joined", count: 3, actorName: "Maya" })).toBe("Maya and 2 others joined Sunday pickup soccer");
    expect(notificationText({ ...base, type: "place_saved", count: 4, actorName: null, label: "Meeple Cellar" })).toBe("4 people saved Meeple Cellar");
    expect(notificationText({ ...base, type: "new_message", count: 2, actorName: "Maya" })).toBe("2 new messages in Sunday pickup soccer");
    expect(pushPayload({ notificationId: "x", userId: theo, type: "event_soon", actorUsername: null, subjectType: "event", subjectId: "e1", label: "Run club", detail: null, count: 1, devices: [] }))
      .toBe(JSON.stringify({ title: "FindMaxxing", body: "Run club starts within the hour", url: "/events/e1", tag: "x" }));
  });

  it("migrates a v9 store to v10 with nothing to tell anyone yet", () => {
    const v9 = buildSeedState() as unknown as Record<string, unknown>;
    for (const k of ["notifications", "notificationSettings", "pushSubscriptions", "pushLog"]) delete v9[k];
    v9.version = 9;
    const result = migrateDemoState(v9);
    expect(result.ok && result.state.notifications).toEqual([]);
  });
});

const auth = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (auth.id ? { id: auth.id } : null) }));

describe("notification actions and the cron route", async () => {
  const actions = await import("../src/server/actions/notifications");
  const { GET } = await import("../src/app/api/cron/notifications/route");
  beforeEach(() => {
    globalThis.__findmaxxingDemoStore = createIsolatedStore();
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "notifications");
    auth.id = theo;
  });

  it("do nothing while the flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect(await actions.markNotificationsReadAction()).toMatchObject({ ok: false, code: "unavailable" });
    vi.unstubAllEnvs();
  });

  it("save settings, refuse bad ones, and need the push flag for devices", async () => {
    expect(await actions.saveNotificationSettingsAction({ ...DEFAULT_NOTIFICATION_SETTINGS, quietStart: 22, quietEnd: 7 })).toEqual({ ok: true, data: undefined });
    expect(await createDemoRepository(globalThis.__findmaxxingDemoStore!).notifications.settings(theo)).toMatchObject({ quietStart: 22, quietEnd: 7 });
    expect(await actions.saveNotificationSettingsAction({ ...DEFAULT_NOTIFICATION_SETTINGS, quietStart: 22, quietEnd: null })).toMatchObject({ ok: false });
    expect(await actions.saveNotificationSettingsAction({ ...DEFAULT_NOTIFICATION_SETTINGS, mutedTypes: ["nope"] })).toMatchObject({ ok: false });
    expect(await actions.saveNotificationSettingsAction({ ...DEFAULT_NOTIFICATION_SETTINGS, timeZone: "Mars/Olympus" })).toMatchObject({ ok: false, error: "Unknown time zone" });
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "k", auth: "a" } };
    expect(await actions.savePushDeviceAction(sub)).toMatchObject({ ok: false, code: "unavailable" });
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "notifications,push");
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(await actions.savePushDeviceAction({ ...sub, endpoint: "http://insecure.test" })).toMatchObject({ ok: false });
    expect(await actions.savePushDeviceAction(sub)).toEqual({ ok: true, data: undefined });
    expect(globalThis.__findmaxxingDemoStore!.state.pushSubscriptions.map((d) => d.userId)).toEqual([theo]);
    expect(await actions.removePushDeviceAction(sub.endpoint)).toEqual({ ok: true, data: undefined });
    expect(globalThis.__findmaxxingDemoStore!.state.pushSubscriptions).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("mark read, own notifications only", async () => {
    const repo = createDemoRepository(globalThis.__findmaxxingDemoStore!);
    await repo.profiles.follow(nina, theo);
    await repo.profiles.follow(theo, nina);
    const ninas = (await repo.notifications.list(nina)).items.map((n) => n.id);
    expect(await actions.markNotificationsReadAction(ninas)).toEqual({ ok: true, data: { changed: 0 } });
    expect(await actions.markNotificationsReadAction()).toEqual({ ok: true, data: { changed: 1 } });
    expect(await repo.notifications.unreadCount(nina)).toBe(1);
  });

  it("runs the cron only with the secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await GET(new Request("http://x/api/cron/notifications"))).status).toBe(401);
    expect((await GET(new Request("http://x/api/cron/notifications", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
    const res = await GET(new Request("http://x/api/cron/notifications", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: 0, sent: 0 });
    vi.unstubAllEnvs();
  });
});

// ----------------------------------------------------------------------------
// The mobile app's devices (Session 19): Expo push tokens in the same table
// ----------------------------------------------------------------------------
describe("Expo push tokens", async () => {
  const { expoPushSender, combinedSender } = await import("../src/server/notifications/push");
  const token = "ExponentPushToken[abc123_DEF-4]";

  it("are stored like web subscriptions, private, valid only in Expo's format, and claimed with their kind", async () => {
    const db = await createSeededDb();
    await queryAs(db, theo, "select public.save_expo_push_token($1)", [token]);
    await expect(queryAs(db, theo, "select public.save_expo_push_token('not-a-token')")).rejects.toThrow(/check constraint/);
    await expect(queryAs(db, theo, "insert into public.push_subscriptions (user_id, kind, endpoint) values (auth.uid(), 'expo', $1)", ["ExponentPushToken[x]"])).rejects.toThrow(/permission denied/);
    expect(await queryAs(db, nina, "select * from public.push_subscriptions")).toEqual([]);
    // The token moves to whoever signs in on the phone next.
    await queryAs(db, nina, "select public.save_expo_push_token($1)", [token]);
    expect((await db.query("select user_id, kind from public.push_subscriptions where endpoint = $1", [token])).rows).toEqual([{ user_id: nina, kind: "expo" }]);
    await queryAs(db, maya, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [nina]).catch(() => {});
    await queryAs(db, theo, "insert into public.follows (follower_id, following_id) values (auth.uid(), $1)", [nina]);
    await db.exec("set role service_role");
    const claims = (await db.query<{ devices: PushDevice[] }>("select * from public.claim_push_batch(now(), 100, 5)")).rows;
    await db.exec("reset role");
    expect(claims.flatMap((c) => c.devices)).toContainEqual({ kind: "expo", endpoint: token, p256dh: null, auth: null });
  });

  it("go to Expo's push service; browsers to web push; a gone token is reported", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ url, body });
      const status = body.to.includes("gone") ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" };
      return new Response(JSON.stringify({ data: status }), { status: 200 });
    }) as typeof fetch;
    const expo = expoPushSender({}, fetcher);
    const web = { send: vi.fn(async () => ({ ok: true as const })) };
    const sender = combinedSender(web, expo)!;
    const payload = JSON.stringify({ title: "FindMaxxing", body: "@maya_r followed you", url: "/u/maya_r", tag: "x" });
    expect(await sender.send({ kind: "expo", endpoint: token, p256dh: null, auth: null }, payload)).toEqual({ ok: true });
    expect(sent[0]).toEqual({ url: "https://exp.host/--/api/v2/push/send", body: { to: token, title: "FindMaxxing", body: "@maya_r followed you", data: { url: "/u/maya_r" }, sound: "default" } });
    expect(await sender.send({ kind: "expo", endpoint: "ExponentPushToken[gone]", p256dh: null, auth: null }, payload)).toEqual({ ok: false, gone: true });
    expect(await sender.send(device(1), payload)).toEqual({ ok: true });
    expect(web.send).toHaveBeenCalledTimes(1);
    expect(combinedSender(null, null)).toBeNull();
  });

  it("are accepted by the demo store too", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    await repo.notifications.addDevice(theo, { kind: "expo", endpoint: token, p256dh: null, auth: null });
    await expect(repo.notifications.addDevice(theo, { kind: "expo", endpoint: "nope", p256dh: null, auth: null })).rejects.toMatchObject({ code: "invalid" });
    expect(await repo.notifications.deviceCount(theo)).toBe(1);
  });
});
