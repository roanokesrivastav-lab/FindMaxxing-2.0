/**
 * Applies the real migration + generated seed to an embedded Postgres (PGlite)
 * with minimal stubs for the Supabase `auth` and `storage` schemas, then
 * exercises the triggers and constraints the app relies on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { SEED_PLACES, SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";

let db: PGlite;

beforeAll(async () => {
  db = await createSeededDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const maya = SEED_USERS.find((u) => u.username === "maya_r")!;
const theo = SEED_USERS.find((u) => u.username === "theo")!;

describe("schema + seed", () => {
  it("creates a profile for every auth user via trigger", async () => {
    const { rows } = await db.query<{ count: number }>("select count(*)::int as count from public.profiles");
    expect(rows[0].count).toBe(SEED_USERS.length);
    const p = await db.query<{ username: string; display_name: string; bio: string }>("select username, display_name, bio from public.profiles where id = $1", [maya.id]);
    expect(p.rows[0]).toMatchObject({ username: "maya_r", display_name: "Maya Reyes" });
    expect(p.rows[0].bio).toBe(maya.bio);
  });

  it("seeds places with aggregated ratings", async () => {
    const { rows } = await db.query<{ rating_avg: string; rating_count: number }>(
      "select rating_avg, rating_count from public.places where id = $1",
      [stableId("place:Cannon & Crown")],
    );
    // theo 5, maya 4, marcus 5 → 4.67
    expect(rows[0].rating_count).toBe(3);
    expect(Number(rows[0].rating_avg)).toBeCloseTo(4.67, 2);
  });

  it("recomputes rating on update and delete", async () => {
    const place = stableId("place:Cannon & Crown");
    await db.query("update public.place_ratings set score = 1 where place_id = $1 and user_id = $2", [place, theo.id]);
    let r = await db.query<{ rating_avg: string }>("select rating_avg from public.places where id = $1", [place]);
    expect(Number(r.rows[0].rating_avg)).toBeCloseTo(3.33, 2);
    await db.query("delete from public.place_ratings where place_id = $1 and user_id = $2", [place, theo.id]);
    r = await db.query<{ rating_avg: string; rating_count: number }>("select rating_avg, rating_count from public.places where id = $1", [place]);
    expect(r.rows[0]).toMatchObject({ rating_count: 2 });
    expect(Number(r.rows[0].rating_avg)).toBeCloseTo(4.5, 2);
  });

  it("rejects a second rating from the same user for the same place", async () => {
    await expect(
      db.query("insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 3)", [stableId("place:Tuttle Lot Fields"), maya.id]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("rejects out-of-range scores and coordinates", async () => {
    await expect(db.query("insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 6)", [stableId("place:Ridgeline Loop"), theo.id])).rejects.toThrow(/check/);
    await expect(
      db.query("insert into public.places (name, description, category_slug, lat, lng, city) values ('Bad', 'A description here', 'other', 95, 0, 'X')"),
    ).rejects.toThrow(/check/);
  });

  it("prevents duplicate event joins", async () => {
    const ev = stableId("event:Sunday pickup soccer");
    await expect(db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, maya.id])).rejects.toThrow(/duplicate key/);
  });

  it("enforces capacity in the join trigger", async () => {
    const ev = stableId("event:Sunday pickup soccer");
    await db.query("update public.events set capacity = 5 where id = $1", [ev]); // 5 seeded attendees
    const lena = SEED_USERS.find((u) => u.username === "lena")!;
    await expect(db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, lena.id])).rejects.toThrow(/full/);
    await db.query("update public.events set capacity = 6 where id = $1", [ev]);
    await db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, lena.id]);
    const { rows } = await db.query<{ count: number }>("select count(*)::int as count from public.event_attendees where event_id = $1", [ev]);
    expect(rows[0].count).toBe(6);
  });

  it("blocks joining an ended event", async () => {
    const ev = stableId("event:Season opener watch party");
    const jules = SEED_USERS.find((u) => u.username === "jules")!;
    await expect(db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, jules.id])).rejects.toThrow(/ended/);
  });

  it("blocks self-follow and duplicate follows", async () => {
    await expect(db.query("insert into public.follows (follower_id, following_id) values ($1, $1)", [maya.id])).rejects.toThrow(/check/);
    await expect(db.query("insert into public.follows (follower_id, following_id) values ($1, $2)", [maya.id, theo.id])).rejects.toThrow(/duplicate key/);
  });

  it("allows one open report per reporter per target", async () => {
    const place = stableId("place:Lantern Bowl");
    await db.query("insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'closed')", [maya.id, place]);
    await expect(
      db.query("insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'spam')", [maya.id, place]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("enables RLS on every public table", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r.relrowsecurity, `${r.relname} should have RLS`).toBe(true);
  });

  it("hides non-public places from other users and shows public ones to anon under RLS", async () => {
    const place = stableId("place:Lantern Bowl");
    // Simulate a hidden row and query as the anon role.
    await db.query("update public.places set status = 'hidden' where id = $1", [place]);
    await db.exec("grant usage on schema public to anon; grant select on all tables in schema public to anon;");
    await db.exec("set role anon;");
    const hidden = await db.query<{ count: number }>("select count(*)::int as count from public.places where id = $1", [place]);
    const visible = await db.query<{ count: number }>("select count(*)::int as count from public.places");
    await db.exec("reset role;");
    expect(hidden.rows[0].count).toBe(0);
    expect(visible.rows[0].count).toBeGreaterThan(0);
  });
});

describe("tier 2 — locals tier, photo cap, and report views in SQL", () => {
  const nina = SEED_USERS.find((u) => u.username === "nina")!;
  const jules = SEED_USERS.find((u) => u.username === "jules")!;
  const lena = SEED_USERS.find((u) => u.username === "lena")!;
  const ridgeline = stableId("place:Ridgeline Loop");
  const ridgelineEvent = stableId("event:Ridgeline sunrise hike");
  const lumen = stableId("place:The Lumen Rooftop");

  /** Runs a query as the `authenticated` role with a given user's JWT subject. */
  async function asUser<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.exec("grant usage on schema public to authenticated;");
    await db.exec("grant select, insert, update, delete on all tables in schema public to authenticated;");
    await db.exec("set role authenticated;");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
    try {
      const { rows } = await db.query<T>(sql, params);
      return rows;
    } finally {
      await db.exec("reset role;");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  }

  it("is_local matches on home city", async () => {
    const [local] = await asUser<{ ok: boolean }>(jules.id, "select public.is_local('Columbus') as ok");
    const [visitor] = await asUser<{ ok: boolean }>(nina.id, "select public.is_local('Columbus') as ok");
    expect(local.ok).toBe(true);
    expect(visitor.ok).toBe(false);
  });

  it("is_local is case and whitespace insensitive", async () => {
    const [row] = await asUser<{ ok: boolean }>(jules.id, "select public.is_local('  cOlUmBuS ') as ok");
    expect(row.ok).toBe(true);
  });

  it("does not expose local status as an anonymous RPC", async () => {
    await db.exec("grant usage on schema public to anon; set role anon;");
    await expect(db.query("select public.is_local('Columbus')")).rejects.toThrow(/permission denied|execute/i);
    await db.exec("reset role;");
  });

  it("hides locals-only places from non-locals and anonymous readers", async () => {
    const seenByLocal = await asUser<{ id: string }>(jules.id, "select id from public.places where id = $1", [ridgeline]);
    const seenByVisitor = await asUser<{ id: string }>(nina.id, "select id from public.places where id = $1", [ridgeline]);
    expect(seenByLocal).toHaveLength(1);
    expect(seenByVisitor).toHaveLength(0);

    await db.exec("grant usage on schema public to anon; grant select on all tables in schema public to anon;");
    await db.exec("set role anon;");
    const anonRows = await db.query<{ count: number }>("select count(*)::int as count from public.places where id = $1", [ridgeline]);
    await db.exec("reset role;");
    expect(anonRows.rows[0].count).toBe(0);
  });

  it("also hides tags, ratings, and photos belonging to locals-only places", async () => {
    const photo = await db.query<{ id: string }>(
      "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, 'https://example.test/local.jpg', $2, $3) returning id",
      [ridgeline, `${jules.id}/local.jpg`, jules.id],
    );

    const visitorTags = await asUser(nina.id, "select interest_slug from public.place_tags where place_id = $1", [ridgeline]);
    const visitorRatings = await asUser(nina.id, "select id from public.place_ratings where place_id = $1", [ridgeline]);
    const visitorPhotos = await asUser(nina.id, "select id from public.place_photos where place_id = $1", [ridgeline]);
    expect(visitorTags).toHaveLength(0);
    expect(visitorRatings).toHaveLength(0);
    expect(visitorPhotos).toHaveLength(0);

    expect((await asUser(jules.id, "select interest_slug from public.place_tags where place_id = $1", [ridgeline])).length).toBeGreaterThan(0);
    expect((await asUser(jules.id, "select id from public.place_ratings where place_id = $1", [ridgeline])).length).toBeGreaterThan(0);
    expect(await asUser(jules.id, "select id from public.place_photos where id = $1", [photo.rows[0].id])).toHaveLength(1);
    await db.query("delete from public.place_photos where id = $1", [photo.rows[0].id]);
  });

  it("does not leak a locals-only place through its linked event", async () => {
    expect(await asUser<{ id: string }>(nina.id, "select id from public.events where id = $1", [ridgelineEvent])).toHaveLength(0);
    expect(await asUser<{ event_id: string }>(nina.id, "select event_id from public.event_tags where event_id = $1", [ridgelineEvent])).toHaveLength(0);
    expect(await asUser<{ event_id: string }>(nina.id, "select event_id from public.event_attendees where event_id = $1", [ridgelineEvent])).toHaveLength(0);
    expect(await asUser<{ id: string }>(jules.id, "select id from public.events where id = $1", [ridgelineEvent])).toHaveLength(1);
  });

  it("blocks non-locals from rating or saving a locals-only place", async () => {
    await expect(
      asUser(nina.id, "insert into public.place_ratings (place_id, user_id, score) values ($1, $2, 5)", [ridgeline, nina.id]),
    ).rejects.toThrow();
    await expect(
      asUser(nina.id, "insert into public.saved_places (place_id, user_id) values ($1, $2)", [ridgeline, nina.id]),
    ).rejects.toThrow();
  });

  it("makes a contributor a local of that city", async () => {
    expect((await asUser<{ ok: boolean }>(nina.id, "select public.is_local('Columbus') as ok"))[0].ok).toBe(false);
    await db.query(
      `insert into public.places (name, description, category_slug, lat, lng, city, creator_id)
       values ('Nina contribution', 'A place added by a visitor to the city.', 'food', 39.96, -83.0, 'Columbus', $1)`,
      [nina.id],
    );
    expect((await asUser<{ ok: boolean }>(nina.id, "select public.is_local('Columbus') as ok"))[0].ok).toBe(true);
    expect(await asUser<{ id: string }>(nina.id, "select id from public.places where id = $1", [ridgeline])).toHaveLength(1);
    await db.query("delete from public.places where name = 'Nina contribution'");
  });

  it("creates and edits a place with related rows transactionally", async () => {
    const [created] = await asUser<{ id: string }>(
      nina.id,
      `select public.create_place_with_details(
        'RPC place', 'A place created through the transactional function.', null,
        'food', 40, -83, null, null, 'Cleveland', 'locals',
        array['food'], $1::jsonb
      ) as id`,
      [JSON.stringify([{ url: "https://example.test/rpc.jpg", storagePath: `${nina.id}/rpc.jpg` }])],
    );
    const placeId = created.id;
    const [place] = await asUser<{ visibility: string; name: string }>(nina.id, "select visibility, name from public.places where id = $1", [placeId]);
    expect(place).toMatchObject({ visibility: "locals", name: "RPC place" });
    expect(await asUser(nina.id, "select 1 from public.place_tags where place_id = $1", [placeId])).toHaveLength(1);
    expect(await asUser(nina.id, "select 1 from public.place_photos where place_id = $1", [placeId])).toHaveLength(1);

    await asUser(
      nina.id,
      `select public.update_place_with_tags(
        $1, 'RPC place edited', 'The transaction also replaces its tags safely.', null,
        'food', 40, -83, null, null, 'Cleveland', array['coffee']
      )`,
      [placeId],
    );
    expect((await db.query<{ name: string }>("select name from public.places where id = $1", [placeId])).rows[0].name).toBe("RPC place edited");
    expect((await db.query<{ interest_slug: string }>("select interest_slug from public.place_tags where place_id = $1", [placeId])).rows).toEqual([{ interest_slug: "coffee" }]);
    await db.query("delete from public.places where id = $1", [placeId]);
  });

  it("caps a place at six photos", async () => {
    for (let i = 0; i < 6; i++) {
      await db.query("insert into public.place_photos (place_id, url, uploader_id) values ($1, $2, $3)", [
        lumen,
        `https://example.test/p${i}.jpg`,
        lena.id,
      ]);
    }
    await expect(
      db.query("insert into public.place_photos (place_id, url, uploader_id) values ($1, $2, $3)", [
        lumen,
        "https://example.test/seventh.jpg",
        lena.id,
      ]),
    ).rejects.toThrow(/at most 6 photos/);
    await db.query("delete from public.place_photos where place_id = $1", [lumen]);
  });

  it("lets a place owner remove a community-contributed photo", async () => {
    const photo = await db.query<{ id: string }>(
      "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, 'https://example.test/community.jpg', $2, $3) returning id",
      [lumen, `${theo.id}/community.jpg`, theo.id],
    );
    await asUser(lena.id, "delete from public.place_photos where id = $1", [photo.rows[0].id]);
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.place_photos where id = $1", [photo.rows[0].id])).rows[0].count).toBe(0);
  });

  it("refuses moderation statuses from an owner but allows hiding", async () => {
    await expect(
      asUser(lena.id, "update public.places set status = 'removed' where id = $1", [lumen]),
    ).rejects.toThrow();
    await asUser(lena.id, "update public.places set status = 'hidden' where id = $1", [lumen]);
    const [row] = await db.query<{ status: string }>("select status from public.places where id = $1", [lumen]).then((r) => r.rows);
    expect(row.status).toBe("hidden");
    await db.query("update public.places set status = 'published' where id = $1", [lumen]);
  });

  it("stops a non-owner from changing someone else's listing", async () => {
    await asUser(nina.id, "update public.places set status = 'hidden' where id = $1", [lumen]);
    const [row] = await db.query<{ status: string }>("select status from public.places where id = $1", [lumen]).then((r) => r.rows);
    expect(row.status).toBe("published");
  });

  it("exposes reports through views that omit the reporter", async () => {
    const cols = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name in ('reports_i_filed','reports_about_my_stuff')",
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain("reporter_id");

    // maya filed a report about lena's rooftop; each side sees their own view.
    const filed = await asUser<{ id: string }>(maya.id, "select id from public.reports_i_filed");
    expect(filed.length).toBeGreaterThan(0);

    const againstLena = await asUser<{ target_id: string }>(lena.id, "select target_id from public.reports_about_my_stuff");
    expect(againstLena.some((r) => r.target_id === lumen)).toBe(true);

    // A user with no reported content sees an empty inbox.
    expect(await asUser(nina.id, "select id from public.reports_about_my_stuff")).toHaveLength(0);
  });

  it("rejects reports for targets that do not exist", async () => {
    await expect(
      asUser(
        maya.id,
        "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'spam')",
        [maya.id, "00000000-0000-4000-a000-000000000099"],
      ),
    ).rejects.toThrow(/target does not exist|foreign key/i);
  });

  it("prevents moving an event into the past and deleting one remaining non-creator attendee", async () => {
    const event = await db.query<{ id: string }>(
      `insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug)
       values ('Guard test', 'An event used to validate owner invariants.', 'Test field', 40, -83, now() + interval '1 day', $1, 'outdoors') returning id`,
      [maya.id],
    );
    await db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [event.rows[0].id, theo.id]);

    const deleted = await asUser<{ id: string }>(maya.id, "delete from public.events where id = $1 returning id", [event.rows[0].id]);
    expect(deleted).toHaveLength(0);
    expect((await db.query<{ count: number }>("select count(*)::int as count from public.events where id = $1", [event.rows[0].id])).rows[0].count).toBe(1);
    await expect(
      asUser(maya.id, "update public.events set starts_at = now() - interval '1 day' where id = $1", [event.rows[0].id]),
    ).rejects.toThrow(/future/);

    await db.query("delete from public.event_attendees where event_id = $1", [event.rows[0].id]);
    await db.query("delete from public.events where id = $1", [event.rows[0].id]);
  });
});

describe("session 1 — private photos and save counts", () => {
  const nina = SEED_USERS.find((u) => u.username === "nina")!;
  const jules = SEED_USERS.find((u) => u.username === "jules")!;
  const ridgeline = stableId("place:Ridgeline Loop");
  const lumen = stableId("place:The Lumen Rooftop");

  /** Runs a query as `anon` (userId null) or `authenticated` with a JWT subject. */
  async function as<T>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const role = userId ? "authenticated" : "anon";
    await db.exec(`grant usage on schema public to ${role}; grant usage on schema storage to ${role};`);
    await db.exec(`grant select, insert, update, delete on all tables in schema public to ${role};`);
    await db.exec(`grant select on storage.objects to ${role};`);
    await db.exec(`set role ${role};`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("reset role;");
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  }

  beforeAll(async () => {
    // Supabase enables RLS on storage.objects; the stub needs it to exercise the policies.
    await db.exec("alter table storage.objects enable row level security;");
  });

  it("makes the place-photos bucket private and leaves avatars public", async () => {
    const { rows } = await db.query<{ id: string; public: boolean }>("select id, public from storage.buckets order by id");
    expect(rows).toEqual([
      { id: "avatars", public: true },
      { id: "place-photos", public: false },
    ]);
  });

  describe("storage objects for a locals-only place", () => {
    const objectPath = `${jules.id}/ridgeline-cover.jpg`;
    const orphanPath = `${nina.id}/not-yet-attached.jpg`;

    beforeAll(async () => {
      await db.query("insert into storage.objects (bucket_id, name) values ('place-photos', $1), ('place-photos', $2), ('avatars', $3)", [
        objectPath, orphanPath, `${nina.id}/avatar.jpg`,
      ]);
      await db.query(
        "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, $2, $3, $4)",
        [ridgeline, `storage:place-photos/${objectPath}`, objectPath, jules.id],
      );
    });

    const readObject = (userId: string | null, name: string) =>
      as<{ name: string }>(userId, "select name from storage.objects where bucket_id = 'place-photos' and name = $1", [name]);

    it("denies the object to a non-local and to anonymous readers", async () => {
      expect(await readObject(nina.id, objectPath)).toHaveLength(0);
      expect(await readObject(null, objectPath)).toHaveLength(0);
    });

    it("allows the object to a local", async () => {
      expect(await readObject(jules.id, objectPath)).toHaveLength(1);
    });

    it("lets an uploader read their own not-yet-attached object, and nobody else", async () => {
      expect(await readObject(nina.id, orphanPath)).toHaveLength(1);
      expect(await readObject(jules.id, orphanPath)).toHaveLength(0);
      expect(await readObject(null, orphanPath)).toHaveLength(0);
    });

    it("ends the uploader exception once the object backs a photo row, even on a place they cannot view", async () => {
      // Attach nina's orphan object to jules' private place (creator-only),
      // where nina has no visibility.
      await db.query(
        "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, $2, $3, $4)",
        [ridgeline, `storage:place-photos/${orphanPath}`, orphanPath, nina.id],
      );
      try {
        expect(await readObject(nina.id, orphanPath)).toHaveLength(0);
        expect(await readObject(jules.id, orphanPath)).toHaveLength(1); // place creator
      } finally {
        await db.query("delete from public.place_photos where storage_path = $1", [orphanPath]);
      }
      // Detached again: the orphaned object is the uploader's to clean up.
      expect(await readObject(nina.id, orphanPath)).toHaveLength(1);
    });

    it("follows the place when its visibility changes", async () => {
      await db.query("update public.places set visibility = 'public' where id = $1", [ridgeline]);
      expect(await readObject(nina.id, objectPath)).toHaveLength(1);
      expect(await readObject(null, objectPath)).toHaveLength(1);
      await db.query("update public.places set visibility = 'locals' where id = $1", [ridgeline]);
      expect(await readObject(nina.id, objectPath)).toHaveLength(0);
    });

    it("keeps avatars readable by anyone", async () => {
      const rows = await as<{ name: string }>(null, "select name from storage.objects where bucket_id = 'avatars'");
      expect(rows).toHaveLength(1);
    });
  });

  it("backfills storage paths for legacy public-URL photo rows, and re-applies cleanly", async () => {
    const legacyPath = `${jules.id}/legacy.jpg`;
    const { rows } = await db.query<{ id: string }>(
      "insert into public.place_photos (place_id, url, uploader_id) values ($1, $2, $3) returning id",
      [lumen, `https://abc.supabase.co/storage/v1/object/public/place-photos/${legacyPath}`, jules.id],
    );
    await db.exec(readFileSync(path.join(__dirname, "../supabase/migrations/0005_private_photos_and_save_counts.sql"), "utf8"));
    const photo = await db.query<{ storage_path: string }>("select storage_path from public.place_photos where id = $1", [rows[0].id]);
    expect(photo.rows[0].storage_path).toBe(legacyPath);
    await db.query("delete from public.place_photos where id = $1", [rows[0].id]);
  });

  describe("save counts", () => {
    const saveCount = async (userId: string | null, placeId: string) =>
      (await as<{ save_count: number }>(userId, "select save_count from public.places where id = $1", [placeId]))[0]?.save_count;

    it("matches the true number of saves for every place", async () => {
      const { rows } = await db.query<{ id: string; save_count: number; actual: number }>(
        "select p.id, p.save_count, (select count(*)::int from public.saved_places s where s.place_id = p.id) as actual from public.places p",
      );
      expect(rows.some((r) => r.actual > 1)).toBe(true);
      for (const r of rows) expect(r.save_count, r.id).toBe(r.actual);
    });

    it("shows the full total to someone who has not saved, without exposing savers", async () => {
      // Seeded: maya, jules, sam_k and priya saved Ridgeline Loop.
      expect(await saveCount(jules.id, ridgeline)).toBe(4);
      const visibleSaves = await as<{ user_id: string }>(jules.id, "select user_id from public.saved_places where place_id = $1", [ridgeline]);
      expect(visibleSaves.map((s) => s.user_id)).toEqual([jules.id]);
      // The old count path, for the record: RLS limits it to the viewer's own row.
      const [{ count }] = await as<{ count: number }>(jules.id, "select count(*)::int as count from public.saved_places where place_id = $1", [ridgeline]);
      expect(count).toBe(1);
    });

    it("agrees with the demo repository for every seeded place", async () => {
      const demo = createDemoRepository(createIsolatedStore());
      const { rows } = await db.query<{ id: string; save_count: number; creator_id: string }>("select id, save_count, creator_id from public.places");
      const sql = new Map(rows.map((r) => [r.id, r]));
      for (const seeded of SEED_PLACES) {
        const row = sql.get(seeded.id)!;
        const detail = await demo.places.get(seeded.id, row.creator_id);
        expect(detail?.saveCount, seeded.name).toBe(row.save_count);
      }
    });

    it("hides the total along with a place the viewer cannot see", async () => {
      expect(await saveCount(nina.id, ridgeline)).toBeUndefined();
    });

    it("increments on save and decrements on unsave", async () => {
      const before = await saveCount(nina.id, lumen);
      await as(nina.id, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina.id, lumen]);
      expect(await saveCount(nina.id, lumen)).toBe(before + 1);
      await as(nina.id, "delete from public.saved_places where user_id = $1 and place_id = $2", [nina.id, lumen]);
      expect(await saveCount(nina.id, lumen)).toBe(before);
    });

    it("ignores client-supplied aggregates on insert", async () => {
      await as(
        nina.id,
        `insert into public.places (name, description, category_slug, lat, lng, city, creator_id, save_count, rating_count, rating_avg)
         values ('Inflated', 'A place that claims to be popular.', 'food', 40, -83, 'Columbus', $1, 999, 50, 5)`,
        [nina.id],
      );
      const [created] = await as<{ id: string; save_count: number; rating_count: number }>(
        nina.id, "select id, save_count, rating_count from public.places where name = 'Inflated'",
      );
      expect(created).toMatchObject({ save_count: 0, rating_count: 0 });
      await db.query("delete from public.places where id = $1", [created.id]);
    });

    it("does not bump updated_at for aggregate-only changes", async () => {
      const read = async () => (await db.query<{ updated_at: string }>("select updated_at::text from public.places where id = $1", [lumen])).rows[0].updated_at;
      await db.query("update public.places set updated_at = '2020-01-01' where id = $1", [lumen]);
      const before = await read();
      await db.query("insert into public.saved_places (user_id, place_id) values ($1, $2)", [nina.id, lumen]);
      await db.query("delete from public.saved_places where user_id = $1 and place_id = $2", [nina.id, lumen]);
      expect(await read()).toBe(before);
      await db.query("update public.places set name = name || '' , description = description || ' ' where id = $1", [lumen]);
      expect(await read()).not.toBe(before);
    });
  });
});
