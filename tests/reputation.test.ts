/**
 * Reputation and the trusted / followers tiers (Session 11). Database tests
 * run as real users through queryAs; the demo repository is held to the same
 * scores, levels and visibility.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { computeDemoReputation, refreshDemoReputation } from "../src/lib/data/demo/reputation";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, theo, jules, sam, priya, dev, lena, nina] = ["maya_r", "theo", "jules", "sam_k", "priya", "dev", "lena", "nina"].map(user);
const place = (n: string) => stableId(`place:${n}`);

describe("reputation in the database", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const level = async (id: string) => (await db.query<{ l: string }>("select reputation_level as l from public.profiles where id = $1", [id])).rows[0].l;
  const score = async (id: string) => Number((await db.query<{ s: string }>("select score as s from public.reputation_cache where user_id = $1", [id])).rows[0]?.s ?? 0);
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("is computed by the seed, and hidden: clients see a level, never a score", async () => {
    expect((await db.query("select 1 from public.reputation_cache")).rows.length).toBe(SEED_USERS.length);
    expect(await as(maya, "select score from public.reputation_cache")).toEqual([]);
    expect((await as(dev, "select score from public.reputation_cache")).length).toBe(SEED_USERS.length); // dev is an admin
    await expect(as(maya, "select * from public.compute_reputation($1)", [maya])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "select public.refresh_reputation($1)", [maya])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.profiles set reputation_level = 'trusted' where id = $1", [maya])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.places set creator_reputation = 2 where creator_id = $1", [maya])).rejects.toThrow(/permission denied/);
  });

  it("counts what others do with your places, not what you do yourself", async () => {
    const mine = (await as<{ id: string }>(nina, "select public.create_place_with_details('Nina spot', 'A long enough description', null, 'food', 41.5, -81.7, null, null, 'Cleveland', 'public', '{}', '[]') as id"))[0].id;
    await db.query("select public.refresh_reputation($1)", [nina]);
    const before = await score(nina);
    await as(nina, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina, mine]);
    await as(nina, "insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 5)", [mine, nina]);
    await db.query("select public.refresh_reputation($1)", [nina]);
    expect(await score(nina)).toBe(before);
    for (const other of [maya, theo, jules]) await as(other, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [other, mine]);
    await as(maya, "insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 4)", [mine, maya]);
    await db.query("select public.refresh_reputation($1)", [nina]);
    expect(await score(nina)).toBe(before + 3 * 2 + 2); // nina's account is older than 30 days: no damping
  });

  it("penalises removed content and damps new accounts", async () => {
    const fresh = stableId("user:rep_fresh");
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'rf@example.test', '{\"username\":\"rep_fresh\"}')", [fresh]);
    const p = (await as<{ id: string }>(fresh, "select public.create_place_with_details('Fresh spot', 'A long enough description', null, 'food', 39.96, -83.0, null, null, 'Columbus', 'public', '{}', '[]') as id"))[0].id;
    for (const other of [maya, theo, jules, priya, lena]) await as(other, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [other, p]);
    await db.query("select public.refresh_reputation($1)", [fresh]);
    expect(await level(fresh)).toBe("new"); // 10 points, but the account is minutes old
    await db.query("update public.profiles set created_at = now() - interval '40 days' where id = $1", [fresh]);
    await db.query("select public.refresh_reputation($1)", [fresh]);
    expect(await level(fresh)).toBe("contributor");
    expect((await db.query<{ r: number }>("select creator_reputation as r from public.places where id = $1", [p])).rows[0].r).toBe(1);
    await db.query("update public.places set status = 'removed' where id = $1", [p]);
    await db.query("select public.refresh_reputation($1)", [fresh]);
    expect(await score(fresh)).toBe(0); // 10 points of saves, minus 10 for the removal
    expect(await level(fresh)).toBe("new");
  });

  it("lets only moderators reset, with a reason, and records it", async () => {
    await db.query("select public.refresh_reputation($1)", [nina]);
    expect(await score(nina)).toBeGreaterThan(0);
    await expect(as(maya, "select public.reset_reputation($1, 'gamed')", [nina])).rejects.toThrow(/Moderators only/);
    await expect(as(sam, "select public.reset_reputation($1, ' ')", [nina])).rejects.toThrow(/reason_required/);
    await as(sam, "select public.reset_reputation($1, 'Ring of accounts saving each other')", [nina]);
    expect(await score(nina)).toBe(0);
    const [log] = await as<{ action: string; reason: string }>(sam, "select action, reason from public.moderation_actions where target_id = $1 and action = 'reset_reputation'", [nina]);
    expect(log).toEqual({ action: "reset_reputation", reason: "Ring of accounts saving each other" });
    // New activity after the reset counts again.
    const mine = (await db.query<{ id: string }>("select id from public.places where creator_id = $1 limit 1", [nina])).rows[0].id;
    await as(priya, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [priya, mine]);
    await db.query("select public.refresh_reputation($1)", [nina]);
    expect(await score(nina)).toBe(2);
  });
});

describe("trusted and followers tiers", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  let trustedPlace: string;
  let followersPlace: string;
  const sees = async (viewer: string | null, id: string) => (await as(viewer, "select id from public.places where id = $1", [id])).length === 1;

  beforeAll(async () => {
    db = await createSeededDb();
    // jules is a trusted local; maya and theo are plain locals; nina is not a local.
    await db.query("update public.profiles set reputation_level = 'trusted' where id = $1", [jules]);
    trustedPlace = (await as<{ id: string }>(priya, "select public.create_place_with_details('Trusted gem', 'A long enough description', null, 'food', 39.96, -83.0, null, 'Trusted Hood', 'Columbus', 'trusted', array['hiking'], '[]') as id"))[0].id;
    followersPlace = (await as<{ id: string }>(lena, "select public.create_place_with_details('Friends only', 'A long enough description', null, 'food', 39.97, -83.0, null, 'Friends Hood', 'Columbus', 'followers', array['hiking'], '[]') as id"))[0].id;
    // Seed follows: lena ↔ dev are mutual, lena follows maya, nina follows lena one-way.
    // maya follows lena back, so they are mutual too.
    await as(maya, "insert into public.follows (follower_id, following_id) values ($1, $2)", [maya, lena]);
  });

  it("show a trusted-locals place only to trusted locals (and its creator)", async () => {
    expect(await sees(priya, trustedPlace)).toBe(true);
    expect(await sees(jules, trustedPlace)).toBe(true);
    for (const viewer of [null, maya, theo, nina]) expect([viewer, await sees(viewer, trustedPlace)]).toEqual([viewer, false]);
  });

  it("show a followers place only to people the creator follows back", async () => {
    expect(await sees(lena, followersPlace)).toBe(true);
    expect(await sees(dev, followersPlace)).toBe(true);
    expect(await sees(maya, followersPlace)).toBe(true);
    for (const viewer of [null, nina, jules, theo]) expect([viewer, await sees(viewer, followersPlace)]).toEqual([viewer, false]);
  });

  it("keep photos, linked events, discovery, counts, aggregates and search consistent with the place", async () => {
    await as(priya, "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, 'storage:x', $2, $3)", [trustedPlace, `${priya}/gem.webp`, priya]);
    await as(priya, "insert into public.events (title, description, place_id, location_name, lat, lng, starts_at, creator_id, category_slug) values ('Gem night', 'An event at the trusted gem.', $1, 'Gem', 39.96, -83.0, now() + interval '2 days', $2, 'outdoors')", [trustedPlace, priya]);
    for (const [viewer, ok] of [[jules, true], [maya, false], [null, false]] as const) {
      const photos = await as(viewer, "select id from public.place_photos where place_id = $1", [trustedPlace]);
      const events = await as(viewer, "select id from public.events where place_id = $1", [trustedPlace]);
      const listed = await as(viewer, "select id from public.discover_places(p_neighborhood => 'trusted hood')");
      const counted = (await as<{ n: number }>(viewer, "select count(*)::int as n from public.discover_places(p_neighborhood => 'trusted hood')"))[0].n;
      const hoods = await as<{ key: string }>(viewer, "select key from public.discover_neighborhoods()");
      const found = await as(viewer, "select public.discover_place_text_ids('Trusted gem', '{}', '{}')");
      expect([viewer, photos.length, events.length, listed.length, counted, hoods.some((h) => h.key === "trusted hood"), found.length])
        .toEqual([viewer, ok ? 1 : 0, ok ? 1 : 0, ok ? 1 : 0, ok ? 1 : 0, ok, ok ? 1 : 0]);
    }
  });

  it("keep saved lists to what the owner can still see", async () => {
    // maya saves the followers place, then lena stops following her back.
    const [list] = await as<{ id: string }>(maya, "insert into public.saved_lists (owner_id, name) values ($1, 'Friends') returning id", [maya]);
    await as(maya, "select public.add_to_saved_list($1, $2)", [list.id, followersPlace]);
    expect((await as<{ c: number }>(maya, "select place_count as c from public.saved_list_summaries() where id = $1", [list.id]))[0].c).toBe(1);
    await as(lena, "delete from public.follows where follower_id = $1 and following_id = $2", [lena, maya]);
    expect((await as<{ c: number }>(maya, "select place_count as c from public.saved_list_summaries() where id = $1", [list.id]))[0].c).toBe(0);
    expect(await sees(maya, followersPlace)).toBe(false);
  });

  it("agree with the demo repository for every seeded viewer", async () => {
    const store = createIsolatedStore();
    const repo = createDemoRepository(store);
    store.state.profiles.find((p) => p.id === jules)!.reputationLevel = "trusted";
    const demoTrusted = await repo.places.create({ name: "Trusted gem", description: "A long enough description", categorySlug: "food", lat: 39.96, lng: -83, city: "Columbus", tags: [], visibility: "trusted" }, priya);
    const demoFollowers = await repo.places.create({ name: "Friends only", description: "A long enough description", categorySlug: "food", lat: 39.97, lng: -83, city: "Columbus", tags: [], visibility: "followers" }, lena);
    // Mirror the SQL side: maya followed lena back, then lena unfollowed maya.
    store.state.follows.push({ followerId: maya, followingId: lena, createdAt: new Date().toISOString() });
    store.state.follows = store.state.follows.filter((f) => !(f.followerId === lena && f.followingId === maya));
    for (const viewer of [null, ...SEED_USERS.map((u) => u.id)]) {
      const sql = [await sees(viewer, trustedPlace), await sees(viewer, followersPlace)];
      const demo = [!!(await repo.places.get(demoTrusted.id, viewer)), !!(await repo.places.get(demoFollowers.id, viewer))];
      expect([viewer, demo]).toEqual([viewer, sql]);
    }
  });
});

describe("reputation parity", () => {
  it("computes the same score and level for every seeded user in SQL and the demo store", async () => {
    const db = await createSeededDb();
    const store = createIsolatedStore();
    // Same timestamps on both sides: the place-survival signal depends on them.
    for (const p of store.state.places) await db.query("update public.places set created_at = $2 where id = $1", [p.id, p.createdAt]);
    await db.query("select public.refresh_all_reputation()");
    refreshDemoReputation(store.state);
    const { rows } = await db.query<{ user_id: string; score: string; level: string }>("select user_id, score, level from public.reputation_cache");
    for (const r of rows) {
      const demo = computeDemoReputation(store.state, r.user_id)!;
      expect([r.user_id, demo.score, demo.level]).toEqual([r.user_id, Number(r.score), r.level]);
    }
    expect(rows.some((r) => r.level !== "new")).toBe(true);
  });
});
