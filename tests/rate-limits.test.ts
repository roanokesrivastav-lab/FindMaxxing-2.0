/**
 * Write rate limits (Session 8). The database enforces them for Supabase mode
 * (0011_rate_limits.sql), so a client calling PostgREST or Storage directly
 * hits the same wall as the app; the demo repository mirrors every limit.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { DataError } from "../src/lib/data/types";
import type { DataRepository } from "../src/lib/data/repository";
import { RATE_LIMITS, createMemoryLimiter, parseRateLimitMessage, waitPhrase, type RateLimitAction } from "../src/lib/rateLimits";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const maya = user("maya_r");
const theo = user("theo");
const jules = user("jules");
const lumen = stableId("place:The Lumen Rooftop");
const cannon = stableId("place:Cannon & Crown");

describe("rate limits in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  /** Puts a user's counter for the current window at `count`, as if they had made that many writes. */
  const used = (userId: string, action: string, count: number) =>
    db.query(
      `insert into public.rate_limit_counters (user_id, action, window_start, count)
       select $1, r.action, to_timestamp(floor(extract(epoch from now()) / r.window_seconds) * r.window_seconds), $3
       from public.rate_limit_rules r where r.action = $2
       on conflict (user_id, action, window_start) do update set count = excluded.count`,
      [userId, action, count],
    );
  const counter = async (userId: string, action: string) =>
    (await db.query<{ count: number }>("select count from public.rate_limit_counters where user_id = $1 and action = $2", [userId, action])).rows[0]?.count ?? 0;
  const newList = (owner: string, name: string) =>
    as(owner, "insert into public.saved_lists (owner_id, name) values ($1, $2)", [owner, name]);

  beforeAll(async () => {
    db = await createSeededDb();
    await db.exec("alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select, insert on storage.objects to authenticated;");
  });

  it("keeps the limits in one table that matches src/lib/rateLimits.ts", async () => {
    const { rows } = await db.query<{ action: string; max_count: number; window_seconds: number; label: string }>("select * from public.rate_limit_rules order by action");
    expect(Object.fromEntries(rows.map((r) => [r.action, { max: r.max_count, windowSeconds: r.window_seconds, label: r.label }]))).toEqual(RATE_LIMITS);
  });

  it("refuses the write after the limit for that user only, saying how long to wait", async () => {
    await used(theo, "lists", RATE_LIMITS.lists.max - 1);
    await newList(theo, "Last one today");
    const err = await newList(theo, "One too many").catch((e: Error & { code?: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("FM429");
    expect((err as Error).message).toMatch(/^rate_limited:lists:\d+$/);
    const translated = parseRateLimitMessage((err as Error).message);
    expect(translated).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Too many lists for now\. Try again in /) });
    // Someone else is unaffected.
    await newList(jules, "Fine for me");
    expect(await counter(jules, "lists")).toBe(1);
  });

  it("does not count a write that fails for another reason", async () => {
    await newList(maya, "Coffee");
    const before = await counter(maya, "lists");
    await expect(newList(maya, "coffee")).rejects.toThrow(/duplicate key/);
    expect(await counter(maya, "lists")).toBe(before);
  });

  it("resets when the window moves on, and keeps one row per user and action", async () => {
    await db.query("update public.rate_limit_counters set window_start = window_start - interval '2 days' where user_id = $1 and action = 'lists'", [theo]);
    await newList(theo, "A new day");
    const rows = await db.query<{ count: number }>("select count from public.rate_limit_counters where user_id = $1 and action = 'lists'", [theo]);
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it("does not limit seeds, SQL maintenance or the service role", async () => {
    await used(theo, "lists", 999);
    await db.query("insert into public.saved_lists (owner_id, name) values ($1, 'From SQL')", [theo]);
  });

  it("covers places (through the create function), events, ratings and reports", async () => {
    const cases: [RateLimitAction, string, unknown[]][] = [
      ["places", "select public.create_place_with_details('Limit test', 'A long enough description', null, 'food', 39.96, -83.0, null, null, 'Columbus', 'public', '{}', '[]')", []],
      ["events", "insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug) values ('Limit test', 'A long enough description', 'Somewhere', 39.96, -83.0, now() + interval '1 day', $1, 'outdoors')", [jules]],
      ["ratings", "insert into public.place_ratings (place_id, user_id, score) values ($2, $1, 4)", [jules, lumen]],
      ["reports", "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'spam')", [jules, cannon]],
    ];
    for (const [action, sql, params] of cases) {
      await used(jules, action, RATE_LIMITS[action].max);
      await expect(as(jules, sql, params)).rejects.toThrow(new RegExp(`rate_limited:${action}:`));
      await used(jules, action, 0);
      await as(jules, sql, params);
    }
  });

  it("counts uploads per photo in Storage, not per stored size, and avatars separately", async () => {
    const upload = (bucket: string, name: string) =>
      as(maya, "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, maya]);
    await upload("place-photos", `${maya}/a.webp`);
    await upload("place-photos", `${maya}/a.md.webp`);
    await upload("place-photos", `${maya}/a.sm.webp`);
    expect(await counter(maya, "photos")).toBe(1);
    await upload("avatars", `${maya}/me.webp`);
    expect(await counter(maya, "avatars")).toBe(1);
    await used(maya, "photos", RATE_LIMITS.photos.max);
    await expect(upload("place-photos", `${maya}/b.webp`)).rejects.toThrow(/rate_limited:photos:/);
    // The other folder rule still holds first.
    await expect(upload("place-photos", `${theo}/c.webp`)).rejects.toThrow(/row-level security/);
  });
});

describe("rate limits in demo mode", () => {
  let store: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    store = createIsolatedStore();
    repo = createDemoRepository(store);
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(DataError);
      return (err as DataError).code;
    }
    return "ok";
  };

  it("refuses the write after the limit for that user only, and resets with the window", async () => {
    for (let i = 0; i < RATE_LIMITS.lists.max; i++) await repo.savedLists.create(theo, `List ${i}`);
    const err = await repo.savedLists.create(theo, "One too many").catch((e: DataError) => e);
    expect(err).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Too many lists for now\. Try again in /) });
    expect(await code(repo.savedLists.create(jules, "Fine for me"))).toBe("ok");
    for (const row of store.state.rateLimits) row.windowStart -= 2 * 86_400_000;
    expect(await code(repo.savedLists.create(theo, "A new day"))).toBe("ok");
    expect(store.state.rateLimits.filter((r) => r.userId === theo && r.action === "lists")).toHaveLength(1);
  });

  it("does not count a write that fails for another reason", async () => {
    await repo.savedLists.create(maya, "Coffee");
    expect(await code(repo.savedLists.create(maya, "coffee"))).toBe("conflict");
    expect(store.state.rateLimits.find((r) => r.userId === maya && r.action === "lists")?.count).toBe(1);
  });

  it("covers places, events, ratings, reports and uploads", async () => {
    const fill = (action: RateLimitAction) => {
      store.state.rateLimits = store.state.rateLimits.filter((r) => !(r.userId === jules && r.action === action));
      store.state.rateLimits.push({ userId: jules, action, windowStart: Math.floor(Date.now() / (RATE_LIMITS[action].windowSeconds * 1000)) * RATE_LIMITS[action].windowSeconds * 1000, count: RATE_LIMITS[action].max });
    };
    const writes: [RateLimitAction, () => Promise<unknown>][] = [
      ["places", () => repo.places.create({ name: "Limit test", description: "A long enough description", categorySlug: "food", lat: 39.96, lng: -83, city: "Columbus", tags: [] }, jules)],
      ["events", () => repo.events.create({ title: "Limit test", description: "A long enough description", locationName: "Somewhere", lat: 39.96, lng: -83, startsAt: new Date(Date.now() + 86_400_000).toISOString(), categorySlug: "outdoors", tags: [] }, jules)],
      ["ratings", () => repo.places.rate(jules, lumen, 4, null)],
      ["reports", () => repo.reports.create({ targetType: "place", targetId: cannon, reason: "spam" }, jules)],
      ["avatars", () => repo.storage.uploadImage({ main: new Uint8Array(4) }, "avatars", jules)],
    ];
    for (const [action, write] of writes) {
      fill(action);
      expect([action, await code(write())]).toEqual([action, "rate_limited"]);
    }
  });
});

describe("in-memory limiter for sign-ups and password resets", () => {
  it("allows the limit per key and window, then says how long to wait", () => {
    let now = Date.UTC(2026, 0, 1, 10, 0, 0);
    const limiter = createMemoryLimiter({ max: 2, windowSeconds: 3600 }, () => now);
    expect(limiter.consume("1.2.3.4")).toBeNull();
    expect(limiter.consume("1.2.3.4")).toBeNull();
    expect(limiter.consume("1.2.3.4")).toBe(3600);
    expect(limiter.consume("5.6.7.8")).toBeNull();
    now += 3600_000;
    expect(limiter.consume("1.2.3.4")).toBeNull();
  });

  it("phrases waits in plain words", () => {
    expect(waitPhrase(20)).toBe("a minute");
    expect(waitPhrase(600)).toBe("10 minutes");
    expect(waitPhrase(3 * 3600 - 10)).toBe("about 3 hours");
  });
});
