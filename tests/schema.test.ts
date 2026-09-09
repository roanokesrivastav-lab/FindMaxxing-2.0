/**
 * Applies the real migration + generated seed to an embedded Postgres (PGlite)
 * with minimal stubs for the Supabase `auth` and `storage` schemas, then
 * exercises the triggers and constraints the app relies on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { buildSeedSql } from "../scripts/generate-seed-sql";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    instance_id uuid, aud text, role text, email text unique,
    encrypted_password text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb, raw_user_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create extension if not exists pgcrypto;");
  await db.exec(SUPABASE_STUBS);
  // Apply every migration in filename order so later ones are covered too.
  const migrationsDir = path.join(__dirname, "../supabase/migrations");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  await db.exec(buildSeedSql());
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
