/**
 * Moderation (Session 8): the moderator role, the report queue, review
 * actions, the audit trail and the firmer local tier. The database tests run
 * as real users through queryAs, so they show what RLS, grants and triggers
 * refuse; the demo tests hold the demo repository to the same rules; the
 * parity test runs one sequence through both.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_MODERATORS, SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore, migrateDemoState, STATE_VERSION } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { DataError } from "../src/lib/data/types";
import type { DataRepository } from "../src/lib/data/repository";
import { parseModerationMessage } from "../src/lib/data/moderation";
import { nextHomeCityChange } from "../src/lib/data/localTier";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const sam = user("sam_k"); // the seeded moderator
const maya = user("maya_r");
const jules = user("jules");
const lena = user("lena");
const theo = user("theo");
const nina = user("nina");
const place = (name: string) => stableId(`place:${name}`);
const lumen = place("The Lumen Rooftop"); // lena's, one open report (maya)
const northend = place("Northend Thrift Alley"); // maya's, one open report (jules)
const ridgeline = place("Ridgeline Loop"); // jules', locals-only
const dumpling = place("Little Alley Dumpling"); // maya's
const ridgelineEvent = stableId("event:Ridgeline sunrise hike"); // jules'

const DAY = 86_400_000;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(DataError);
    return (err as DataError).code;
  }
  return "ok";
}

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------
describe("moderation in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const report = (reporter: string, type: string, target: string, reason = "spam") =>
    as(reporter, "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, $2, $3, $4)", [reporter, type, target, reason]);
  const moderate = (moderator: string, type: string, target: string, action: string, reason: string | null = null) =>
    as<{ status_after: string | null; resolved_reports: number }>(moderator, "select * from public.moderate_target($1, $2, $3, $4)", [type, target, action, reason]);
  const status = async (table: "places" | "events", id: string) =>
    (await db.query<{ status: string }>(`select status from public.${table} where id = $1`, [id])).rows[0]?.status;

  beforeAll(async () => {
    db = await createSeededDb();
  });

  describe("the moderator role", () => {
    it("is seeded from SQL and reported by is_moderator()", async () => {
      expect(SEED_MODERATORS).toEqual(["sam_k"]);
      expect((await as<{ ok: boolean }>(sam, "select public.is_moderator() as ok"))[0].ok).toBe(true);
      expect((await as<{ ok: boolean }>(maya, "select public.is_moderator() as ok"))[0].ok).toBe(false);
      expect((await as<{ ok: boolean }>(null, "select public.is_moderator() as ok"))[0].ok).toBe(false);
    });

    it("cannot be granted, changed or removed by any client, moderators included", async () => {
      await expect(as(maya, "insert into public.moderators (user_id) values ($1)", [maya])).rejects.toThrow(/permission denied/);
      await expect(as(sam, "insert into public.moderators (user_id) values ($1)", [maya])).rejects.toThrow(/permission denied/);
      await expect(as(sam, "update public.moderators set user_id = $1", [maya])).rejects.toThrow(/permission denied/);
      await expect(as(maya, "delete from public.moderators")).rejects.toThrow(/permission denied/);
      expect((await db.query("select user_id from public.moderators")).rows).toEqual([{ user_id: sam }]);
    });

    it("lets a moderator see the moderator list, and others only themselves", async () => {
      expect(await as(sam, "select user_id from public.moderators")).toHaveLength(1);
      expect(await as(maya, "select user_id from public.moderators")).toHaveLength(0);
    });
  });

  describe("non-moderators", () => {
    it("see only their own reports, an empty queue, no history and no snapshots", async () => {
      expect(await as(maya, "select id from public.reports")).toHaveLength(1); // the one maya filed
      expect(await as(maya, "select * from public.moderation_queue()")).toEqual([]);
      expect(await as(maya, "select id from public.moderation_actions")).toEqual([]);
      expect((await as<{ s: unknown }>(maya, "select public.moderation_target('place', $1) as s", [lumen]))[0].s).toBeNull();
    });

    it("cannot resolve reports, change report rows, or revoke local status", async () => {
      await expect(moderate(lena, "place", lumen, "dismiss")).rejects.toThrow(/Moderators only/);
      await expect(as(maya, "select public.set_local_status($1, true, 'x')", [jules])).rejects.toThrow(/Moderators only/);
      await expect(as(maya, "update public.reports set status = 'dismissed'")).rejects.toThrow(/permission denied/);
      await expect(as(maya, "delete from public.reports")).rejects.toThrow(/permission denied/);
      await expect(
        as(maya, "insert into public.moderation_actions (action, target_type, target_id) values ('dismiss', 'place', $1)", [lumen]),
      ).rejects.toThrow(/permission denied/);
      expect(await status("places", lumen)).toBe("published");
    });

    it("cannot be targeted by anon at all", async () => {
      await expect(as(null, "select * from public.moderation_queue()")).rejects.toThrow(/permission denied/);
      await expect(as(null, "select * from public.moderate_target('place', $1, 'dismiss', null)", [lumen])).rejects.toThrow(/permission denied/);
    });
  });

  describe("the queue", () => {
    it("groups open reports by target with counts and reasons, oldest first, and pages without gaps", async () => {
      await report(theo, "place", lumen, "inappropriate");
      await report(nina, "place", lumen, "spam");
      const rows = await as<{ target_id: string; report_count: number; reasons: string[]; target_label: string; first_reported_at: string }>(
        sam, "select target_id, report_count, reasons, target_label, to_json(first_reported_at) #>> '{}' as first_reported_at from public.moderation_queue()");
      const byId = Object.fromEntries(rows.map((r) => [r.target_id, r]));
      expect(byId[lumen]).toMatchObject({ report_count: 3, reasons: ["inaccurate", "inappropriate", "spam"], target_label: "The Lumen Rooftop" });
      expect(byId[northend]).toMatchObject({ report_count: 1, target_label: "Northend Thrift Alley" });
      // A reviewed seed report is not in the queue.
      expect(rows).toHaveLength(2);
      // Page one row at a time with the keyset cursor: same rows, same order.
      const paged: string[] = [];
      let after: { first: string | null; id: string | null } = { first: null, id: null };
      for (;;) {
        const page = await as<{ target_id: string; first: string }>(
          sam, "select target_id, to_json(first_reported_at) #>> '{}' as first from public.moderation_queue($1::timestamptz, $2::uuid, 2)", [after.first, after.id]);
        paged.push(page[0].target_id);
        if (page.length < 2) break;
        after = { first: page[0].first, id: page[0].target_id };
      }
      expect(paged).toEqual(rows.map((r) => r.target_id));
    });

    it("shows a moderator a locals-only target they could not otherwise see", async () => {
      // sam is a local, so use nina's view of what she cannot see vs the snapshot.
      await report(maya, "place", ridgeline, "inaccurate");
      expect(await as(nina, "select id from public.places where id = $1", [ridgeline])).toHaveLength(0);
      const [row] = await as<{ s: { label: string; visibility: string } }>(sam, "select public.moderation_target('place', $1) as s", [ridgeline]);
      expect(row.s).toMatchObject({ label: "Ridgeline Loop", visibility: "locals" });
    });
  });

  describe("review actions", () => {
    it("resolve every open report on a target together, and record who, what and why", async () => {
      const [res] = await moderate(sam, "place", lumen, "review", "Cover charge is mentioned in the description now");
      expect(res).toEqual({ status_after: "published", resolved_reports: 3 });
      const left = await db.query("select 1 from public.reports where target_id = $1 and status = 'open'", [lumen]);
      expect(left.rows).toHaveLength(0);
      const [log] = await as<{ moderator_id: string; action: string; reason: string; status_before: string; status_after: string; resolved_reports: number }>(
        sam, "select moderator_id, action, reason, status_before, status_after, resolved_reports from public.moderation_actions where target_id = $1", [lumen]);
      expect(log).toEqual({ moderator_id: sam, action: "review", reason: "Cover charge is mentioned in the description now", status_before: "published", status_after: "published", resolved_reports: 3 });
      // Nothing left to dismiss.
      await expect(moderate(sam, "place", lumen, "dismiss")).rejects.toThrow(/moderation:nothing_open/);
    });

    it("tell the reporter it was resolved, never by whom", async () => {
      const rows = await as<Record<string, unknown>>(maya, "select * from public.reports_i_filed where target_id = $1", [lumen]);
      expect(rows[0]).toMatchObject({ status: "reviewed" });
      expect(rows[0].resolved_at).toBeTruthy();
      expect(Object.keys(rows[0])).not.toContain("reporter_id");
      expect(Object.keys(rows[0]).some((k) => k.includes("moderator"))).toBe(false);
    });

    it("remove content for everyone, its owner included, and keep it out of every read path", async () => {
      // maya saves and lists Lumen first, so the removal has to reach her list.
      const [list] = await as<{ id: string }>(maya, "insert into public.saved_lists (owner_id, name) values ($1, 'Rooftops') returning id", [maya]);
      await as(maya, "select public.add_to_saved_list($1, $2)", [list.id, lumen]);
      await report(maya, "place", lumen, "inappropriate");

      await expect(moderate(sam, "place", lumen, "remove")).rejects.toThrow(/moderation:reason_required/);
      const [res] = await moderate(sam, "place", lumen, "remove", "Repeated reports of unsafe crowding");
      expect(res).toEqual({ status_after: "removed", resolved_reports: 1 });
      expect(await status("places", lumen)).toBe("removed");

      for (const viewer of [null, maya, nina, lena]) {
        expect(await as(viewer, "select id from public.places where id = $1", [lumen])).toHaveLength(0);
        expect(await as(viewer, "select id from public.discover_places() where id = $1", [lumen])).toHaveLength(0);
      }
      expect((await as<{ place_count: number }>(maya, "select place_count from public.saved_list_summaries() where id = $1", [list.id]))[0].place_count).toBe(0);
      expect(await as(maya, "select p.id from public.saved_list_items i join public.places p on p.id = i.place_id where i.list_id = $1", [list.id])).toHaveLength(0);
    });

    it("tell the owner why, and stop them editing or republishing it", async () => {
      expect(await as(lena, "select target_type, target_id, label, reason from public.my_removed_content()")).toEqual([
        { target_type: "place", target_id: lumen, label: "The Lumen Rooftop", reason: "Repeated reports of unsafe crowding" },
      ]);
      expect(await as(maya, "select target_id from public.my_removed_content()")).toEqual([]);
      await as(lena, "update public.places set status = 'published' where id = $1", [lumen]);
      await as(lena, "update public.places set visibility = 'locals' where id = $1", [lumen]);
      expect(await status("places", lumen)).toBe("removed");
      // Without a WHERE clause the select policy is not consulted, so this is
      // the update policy's own USING clause holding.
      await as(lena, "update public.places set status = 'published'");
      expect(await status("places", lumen)).toBe("removed");
      await expect(
        as(lena, "select public.update_place_with_tags($1, 'New name', 'A long enough description', null, 'nightlife', 39.96, -83.0, null, null, 'Columbus', '{}')", [lumen]),
      ).rejects.toThrow(/do not own/);
      // No photos, ratings or saves on a removed place.
      await expect(as(maya, "insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 4)", [lumen, maya])).rejects.toThrow(/row-level security/);
    });

    it("restore removed content", async () => {
      await expect(moderate(sam, "place", northend, "restore")).rejects.toThrow(/moderation:not_removed/);
      const [res] = await moderate(sam, "place", lumen, "restore", "Venue fixed the issue");
      expect(res).toEqual({ status_after: "published", resolved_reports: 0 });
      expect(await as(null, "select id from public.places where id = $1", [lumen])).toHaveLength(1);
      expect(await as(lena, "select target_id from public.my_removed_content()")).toEqual([]);
      const history = await as<{ action: string }>(sam, "select action from public.moderation_actions where target_id = $1 order by created_at, id", [lumen]);
      expect(history.map((h) => h.action).sort()).toEqual(["remove", "restore", "review"]);
    });

    it("remove and restore events past the owner-only event trigger", async () => {
      await report(maya, "event", ridgelineEvent, "spam");
      await moderate(sam, "event", ridgelineEvent, "remove", "Not a real event");
      expect(await status("events", ridgelineEvent)).toBe("removed");
      expect(await as(jules, "select id from public.events where id = $1", [ridgelineEvent])).toHaveLength(0);
      expect(await as(jules, "select target_id from public.my_removed_content()")).toEqual([{ target_id: ridgelineEvent }]);
      await moderate(sam, "event", ridgelineEvent, "restore");
      expect(await status("events", ridgelineEvent)).toBe("published");
    });

    it("refuse removing a profile, but resolve its reports", async () => {
      await report(maya, "profile", nina, "spam");
      await expect(moderate(sam, "profile", nina, "remove", "x")).rejects.toThrow(/moderation:cannot_remove_profile/);
      const [res] = await moderate(sam, "profile", nina, "dismiss");
      expect(res).toEqual({ status_after: null, resolved_reports: 1 });
    });

    it("the flag that lets moderation past the event trigger does nothing for anyone else", async () => {
      // jules owns the event; with the flag set in his own session he still
      // cannot set a moderation status (the policy) and maya still cannot
      // touch his event at all (the trigger).
      const withFlag = async (userId: string, sql: string) => {
        await db.exec("set role authenticated");
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
        await db.query("select set_config('findmaxxing.moderation', 'on', false)");
        try {
          return await db.query(sql, [ridgelineEvent]);
        } finally {
          await db.exec("reset role");
          await db.query("select set_config('request.jwt.claim.sub', '', false)");
          await db.query("select set_config('findmaxxing.moderation', 'off', false)");
        }
      };
      await expect(withFlag(jules, "update public.events set status = 'removed' where id = $1")).rejects.toThrow(/Invalid event status|row-level security/);
      const res = await withFlag(maya, "update public.events set status = 'cancelled' where id = $1");
      expect(res.affectedRows).toBe(0);
      expect(await status("events", ridgelineEvent)).toBe("published");
    });
  });

  describe("the audit trail", () => {
    it("is append-only for everyone but the service role, table owner included", async () => {
      await expect(db.query("update public.moderation_actions set reason = 'rewritten'")).rejects.toThrow(/append-only/);
      await expect(db.query("delete from public.moderation_actions")).rejects.toThrow(/append-only/);
      await expect(as(sam, "update public.moderation_actions set reason = 'rewritten'")).rejects.toThrow(/permission denied/);
      await expect(as(sam, "delete from public.moderation_actions")).rejects.toThrow(/permission denied/);
      await db.exec("set role service_role");
      try {
        const before = (await db.query<{ n: number }>("select count(*)::int as n from public.moderation_actions")).rows[0].n;
        await db.query("update public.moderation_actions set reason = reason");
        expect((await db.query<{ n: number }>("select count(*)::int as n from public.moderation_actions")).rows[0].n).toBe(before);
      } finally {
        await db.exec("reset role");
      }
    });
  });

  describe("the local tier", () => {
    const newAccount = async (username: string, homeCity: string | null) => {
      const id = stableId(`user:${username}`);
      await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${username}@example.test`, JSON.stringify({ username })]);
      if (homeCity) await db.query("update public.profiles set home_city = $2 where id = $1", [id, homeCity]);
      return id;
    };
    const isLocal = async (id: string) => (await as<{ ok: boolean }>(id, "select public.is_local('Columbus') as ok"))[0].ok;

    it("waits 7 days before a new account counts as a local", async () => {
      const fresh = await newAccount("fresh_local", "Columbus");
      expect(await isLocal(fresh)).toBe(false);
      expect(await as(fresh, "select id from public.places where id = $1", [ridgeline])).toHaveLength(0);
      await db.query("update public.profiles set created_at = now() - interval '6 days 23 hours' where id = $1", [fresh]);
      expect(await isLocal(fresh)).toBe(false);
      await db.query("update public.profiles set created_at = now() - interval '7 days' where id = $1", [fresh]);
      expect(await isLocal(fresh)).toBe(true);
      expect(await as(fresh, "select id from public.places where id = $1", [ridgeline])).toHaveLength(1);
    });

    it("never lets a user backdate their account or their last city change", async () => {
      const fresh = await newAccount("backdater", "Columbus");
      await expect(as(fresh, "update public.profiles set created_at = '2020-01-01' where id = $1", [fresh])).rejects.toThrow(/permission denied/);
      await expect(as(fresh, "update public.profiles set home_city_changed_at = '2020-01-01' where id = $1", [fresh])).rejects.toThrow(/permission denied/);
      // A self-inserted profile row (the app's recovery path) starts now, whatever it says.
      const other = stableId("user:self_insert");
      await db.query("insert into auth.users (id, email) values ($1, 'self@example.test')", [other]);
      await db.query("delete from public.profiles where id = $1", [other]);
      await as(other, "insert into public.profiles (id, username, display_name, created_at) values ($1, 'self_insert', 'Self', '2020-01-01')", [other]);
      const { rows } = await db.query<{ recent: boolean }>("select created_at > now() - interval '1 minute' as recent from public.profiles where id = $1", [other]);
      expect(rows[0].recent).toBe(true);
    });

    it("allows one home city change per 30 days; spacing and case fixes are free", async () => {
      const mover = await newAccount("mover", null);
      await as(mover, "update public.profiles set home_city = 'Columbus' where id = $1", [mover]); // first set: free
      await expect(as(mover, "update public.profiles set home_city = 'Dayton' where id = $1", [mover])).rejects.toThrow(/home_city_cooldown:\d{4}-\d{2}-\d{2}T/);
      expect((await db.query<{ home_city: string }>("select home_city from public.profiles where id = $1", [mover])).rows[0].home_city).toBe("Columbus");
      await as(mover, "update public.profiles set home_city = '  columbus ' where id = $1", [mover]);
      await as(mover, "update public.profiles set bio = 'still here' where id = $1", [mover]);
      // 30 days later it may change again.
      await db.query("update public.profiles set home_city_changed_at = now() - interval '30 days' where id = $1", [mover]);
      await as(mover, "update public.profiles set home_city = 'Dayton' where id = $1", [mover]);
      const { rows } = await db.query<{ home_city: string; recent: boolean }>(
        "select home_city, home_city_changed_at > now() - interval '1 minute' as recent from public.profiles where id = $1", [mover]);
      expect(rows[0]).toEqual({ home_city: "Dayton", recent: true });
    });

    it("lets moderators revoke and restore local status, with a reason and an audit row", async () => {
      expect(await isLocal(jules)).toBe(true);
      await expect(as(sam, "select public.set_local_status($1, true, '  ')", [jules])).rejects.toThrow(/reason_required/);
      await as(sam, "select public.set_local_status($1, true, 'Lives in another state')", [jules]);
      expect(await isLocal(jules)).toBe(false);
      // Their own locals-only place stays theirs to see; another one does not.
      expect(await as(jules, "select id from public.places where id = $1", [ridgeline])).toHaveLength(1);
      expect(await as(jules, "select id from public.places where id = $1", [place("Fourth Street Basement")])).toHaveLength(0);
      expect(await as(jules, "select user_id from public.local_revocations")).toHaveLength(1);
      expect(await as(maya, "select user_id from public.local_revocations")).toHaveLength(0);
      await expect(as(sam, "select public.set_local_status($1, true, 'again')", [jules])).rejects.toThrow(/no_change/);
      await as(sam, "select public.set_local_status($1, false, 'Appeal accepted')", [jules]);
      expect(await isLocal(jules)).toBe(true);
      const log = await as<{ action: string; status_before: string; status_after: string }>(
        sam, "select action, status_before, status_after from public.moderation_actions where target_id = $1 and target_type = 'profile' order by created_at, id", [jules]);
      expect(log).toEqual([
        { action: "revoke_local", status_before: "eligible", status_after: "revoked" },
        { action: "restore_local", status_before: "revoked", status_after: "eligible" },
      ]);
    });
  });
});

// ----------------------------------------------------------------------------
// Demo repository
// ----------------------------------------------------------------------------
describe("moderation in demo mode", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });

  it("knows its moderator and refuses everyone else", async () => {
    expect(await repo.moderation.isModerator(sam)).toBe(true);
    expect(await repo.moderation.isModerator(maya)).toBe(false);
    expect(await repo.moderation.queue(maya)).toEqual({ items: [], nextCursor: null });
    expect(await repo.moderation.target(maya, "place", lumen)).toBeNull();
    expect(await code(repo.moderation.resolve(maya, { targetType: "place", targetId: lumen, action: "dismiss" }))).toBe("forbidden");
    expect(await code(repo.moderation.setLocalStatus(maya, jules, true, "x"))).toBe("forbidden");
  });

  it("removes content from every read path, for its owner too, and restores it", async () => {
    const list = await repo.savedLists.create(maya, "Rooftops");
    await repo.savedLists.addPlace(maya, list.id, lumen);
    expect(await code(repo.moderation.resolve(sam, { targetType: "place", targetId: lumen, action: "remove" }))).toBe("invalid");
    expect(await repo.moderation.resolve(sam, { targetType: "place", targetId: lumen, action: "remove", reason: "Unsafe" })).toEqual({ statusAfter: "removed", resolvedReports: 1 });
    for (const viewer of [null, maya, lena]) {
      expect(await repo.places.get(lumen, viewer)).toBeNull();
      expect((await repo.places.search({ viewerId: viewer, limit: 100 })).items.some((p) => p.id === lumen)).toBe(false);
    }
    expect((await repo.savedLists.get(maya, list.id))?.places).toEqual([]);
    expect(await repo.moderation.myRemovedContent(lena)).toMatchObject([{ targetType: "place", targetId: lumen, reason: "Unsafe" }]);
    expect(await code(repo.places.setStatus(lumen, "published", lena))).toBe("forbidden");
    expect(await code(repo.places.setVisibility(lumen, "locals", lena))).toBe("forbidden");
    await repo.moderation.resolve(sam, { targetType: "place", targetId: lumen, action: "restore" });
    expect(await repo.places.get(lumen, null)).not.toBeNull();
    const detail = await repo.moderation.target(sam, "place", lumen);
    expect(detail?.history.map((h) => h.action)).toEqual(["restore", "remove"]);
    expect(detail?.reports.map((r) => r.reporter?.username)).toEqual(["maya_r"]);
  });

  it("applies the 7-day account age and moderator revocation to locals-only places", async () => {
    store.state.profiles.find((p) => p.id === jules)!.createdAt = new Date(Date.now() - 6 * DAY).toISOString();
    expect(await repo.profiles.isLocalOf(jules, "Columbus")).toBe(false);
    store.state.profiles.find((p) => p.id === jules)!.createdAt = new Date(Date.now() - 8 * DAY).toISOString();
    expect(await repo.profiles.isLocalOf(jules, "Columbus")).toBe(true);
    await repo.moderation.setLocalStatus(sam, jules, true, "Moved away");
    expect(await repo.profiles.isLocalOf(jules, "Columbus")).toBe(false);
    expect(await repo.places.get(place("Fourth Street Basement"), jules)).toBeNull();
    expect(await repo.places.get(ridgeline, jules)).not.toBeNull(); // still their own
    expect(await code(repo.moderation.setLocalStatus(sam, jules, true, "again"))).toBe("conflict");
  });

  it("limits home city changes to one per 30 days", async () => {
    const base = await repo.profiles.getById(maya);
    const input = { username: base!.username, displayName: base!.displayName, bio: base!.bio, interests: base!.interests };
    await repo.profiles.update(maya, { ...input, homeCity: "Dayton" }); // seeded with no change date: allowed
    const changed = await repo.profiles.getById(maya);
    expect(nextHomeCityChange(changed!.homeCity, changed!.homeCityChangedAt)).not.toBeNull();
    const err = await repo.profiles.update(maya, { ...input, homeCity: "Columbus" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/change your home city again on/) });
    await repo.profiles.update(maya, { ...input, homeCity: "  dayton " }); // spacing and case are free
  });

  it("carries a v3 store forward, keeping reports and profiles and adding nothing to moderate", () => {
    const fresh = createIsolatedStore().state as unknown as Record<string, unknown>;
    const v3 = JSON.parse(JSON.stringify(fresh)) as Record<string, unknown>;
    v3.version = 3;
    for (const key of ["moderators", "moderationActions", "localRevocations", "rateLimits"]) delete v3[key];
    for (const r of v3.reports as Record<string, unknown>[]) delete r.resolvedAt;
    for (const p of v3.profiles as Record<string, unknown>[]) delete p.homeCityChangedAt;
    const result = migrateDemoState(v3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(STATE_VERSION);
    expect(result.state.reports).toHaveLength((fresh.reports as unknown[]).length);
    expect(result.state.reports.every((r) => r.resolvedAt === null)).toBe(true);
    expect(result.state.profiles.every((p) => p.homeCityChangedAt === null)).toBe(true);
    // An upgraded store has no moderators until the owner grants one.
    expect(result.state.moderators).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Parity: one sequence through SQL and the demo repository
// ----------------------------------------------------------------------------
describe("moderation parity", () => {
  it("produces the same queue, outcomes and history in both modes", async () => {
    const db = await createSeededDb();
    const repo = createDemoRepository(createIsolatedStore());
    const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);

    const extra: [string, "place" | "event", string, string][] = [
      [theo, "place", lumen, "spam"],
      [nina, "place", dumpling, "duplicate"],
      [maya, "event", ridgelineEvent, "other"],
    ];
    for (const [who, type, id, reason] of extra) {
      await as(who, "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, $2, $3, $4)", [who, type, id, reason]);
      await repo.reports.create({ targetType: type, targetId: id, reason: reason as "spam" }, who);
    }

    const sqlQueue = await as<{ target_type: string; target_id: string; report_count: number; reasons: string[]; target_status: string }>(
      sam, "select target_type, target_id, report_count, reasons, target_status from public.moderation_queue()");
    const demoQueue = (await repo.moderation.queue(sam, { limit: 100 })).items;
    const shape = (rows: { targetId: string; reportCount: number; reasons: string[]; targetStatus: string | null }[]) =>
      rows.map((r) => [r.targetId, r.reportCount, r.reasons.join(","), r.targetStatus]).sort();
    expect(shape(sqlQueue.map((r) => ({ targetId: r.target_id, reportCount: r.report_count, reasons: r.reasons, targetStatus: r.target_status }))))
      .toEqual(shape(demoQueue));

    const steps: [string, "place" | "event" | "profile", string, "dismiss" | "review" | "remove" | "restore", string | null][] = [
      ["review lumen", "place", lumen, "review", null],
      ["dismiss again", "place", lumen, "dismiss", null],
      ["remove without reason", "place", dumpling, "remove", null],
      ["remove dumpling", "place", dumpling, "remove", "Duplicate listing"],
      ["remove again", "place", dumpling, "remove", "Again"],
      ["restore northend", "place", northend, "restore", null],
      ["remove event", "event", ridgelineEvent, "remove", "Spam"],
      ["restore event", "event", ridgelineEvent, "restore", null],
      ["remove profile", "profile", nina, "remove", "x"],
      ["missing target", "place", stableId("place:nope"), "dismiss", null],
    ];
    for (const [label, type, id, action, reason] of steps) {
      const sql = await as<{ status_after: string | null; resolved_reports: number }>(sam, "select * from public.moderate_target($1, $2, $3, $4)", [type, id, action, reason])
        .then((rows) => ({ statusAfter: rows[0].status_after, resolvedReports: rows[0].resolved_reports }))
        .catch((e: Error) => parseModerationMessage(e.message)?.code ?? e.message);
      const demo = await repo.moderation.resolve(sam, { targetType: type, targetId: id, action, reason }).catch((e: DataError) => e.code);
      expect([label, demo]).toEqual([label, sql]);
    }

    const sqlRemoved = await as<{ target_id: string; reason: string }>(maya, "select target_id, reason from public.my_removed_content()");
    const demoRemoved = await repo.moderation.myRemovedContent(maya);
    expect(demoRemoved.map((r) => ({ target_id: r.targetId, reason: r.reason }))).toEqual(sqlRemoved);

    const sqlHistory = await as<{ action: string; status_before: string | null; status_after: string | null; resolved_reports: number }>(
      sam, "select action, status_before, status_after, resolved_reports from public.moderation_actions where target_id = $1 order by created_at desc, id desc", [dumpling]);
    const demoHistory = (await repo.moderation.target(sam, "place", dumpling))!.history;
    expect(demoHistory.map((h) => ({ action: h.action, status_before: h.statusBefore, status_after: h.statusAfter, resolved_reports: h.resolvedReports }))).toEqual(sqlHistory);
  });
});
