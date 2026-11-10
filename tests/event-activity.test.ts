/**
 * Roadmap 4.2: structured activity details and events.time_zone
 * (0050_event_activity_and_time_zone.sql, packages/shared/src/activity.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { activityDetailsSchema, activityFromFields, activitySummary, describeActivity, parseActivityDetails } from "../src/lib/activity";
import { parseEventsMessage } from "../src/lib/data/events";
import { eventTimeZone } from "../src/lib/utils/timezone";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const theo = user("theo");
const nina = user("nina");
const basketball = stableId("event:Thursday pickup basketball");

const CREATE = `select public.create_event_with_details($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) as id`;
const UPDATE = `select public.update_event_with_tags($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`;
const base = () => ["Activity test run", "A steady loop along the river, all welcome.", null, "Scioto Mile", null, 39.96, -83.0,
  new Date(Date.now() + 2 * 86_400_000).toISOString(), null, "fitness", 12, ["running"]] as unknown[];
const json = (v: unknown) => (v === null ? null : JSON.stringify(v));

describe("0050: events.time_zone and activity_details", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  afterAll(async () => { await db?.close(); });
  const row = async (id: string) =>
    (await db.query<{ time_zone: string; activity_details: unknown }>("select time_zone, activity_details from public.events where id = $1", [id])).rows[0];

  it("gives every existing event the app's previous zone, and the seed its activity details", async () => {
    const zones = (await db.query<{ time_zone: string; n: number }>("select time_zone, count(*)::int as n from public.events group by 1")).rows;
    expect(zones).toEqual([{ time_zone: "America/New_York", n: expect.any(Number) }]);
    expect((await row(basketball)).activity_details).toEqual({ kind: "basketball", format: "4v4", playerLimit: 10, beginnersWelcome: true });
  });

  it("still accepts the old twelve-parameter create call", async () => {
    const [{ id }] = await queryAs<{ id: string }>(db, theo,
      "select public.create_event_with_details($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as id", base());
    expect(await row(id)).toEqual({ time_zone: "America/New_York", activity_details: null });
  });

  it("stores a zone and details on create", async () => {
    const details = { kind: "run", distanceMiles: 5, paceFrom: "9:00", paceTo: "10:30", noDrop: true };
    const [{ id }] = await queryAs<{ id: string }>(db, theo, CREATE, [...base(), "America/Chicago", json(details)]);
    expect(await row(id)).toEqual({ time_zone: "America/Chicago", activity_details: details });
  });

  it.each(["Mars/Phobos", "ABC+3", "EST5EDT", "", "america", "America/New_York; drop table events"])("refuses the zone %j", async (zone) => {
    await expect(queryAs(db, theo, CREATE, [...base(), zone, null])).rejects.toThrow(/events:bad_time_zone/);
  });

  it.each(["UTC", "America/Argentina/Buenos_Aires", "Europe/London", "Australia/Lord_Howe"])("accepts the zone %s", async (zone) => {
    const [{ id }] = await queryAs<{ id: string }>(db, theo, CREATE, [...base(), zone, null]);
    expect((await row(id)).time_zone).toBe(zone);
  });

  it.each([
    ["an unknown kind", { kind: "chess" }],
    ["no kind", { distanceMiles: 3 }],
    ["a nested value", { kind: "run", extra: { a: 1 } }],
    ["a list", ["run"]],
    ["an oversized object", { kind: "walk", pace: "x".repeat(700) }],
  ])("refuses activity details with %s", async (_name, details) => {
    await expect(queryAs(db, theo, CREATE, [...base(), null, json(details)])).rejects.toThrow(/events_activity_details_check/);
  });

  it("update: null keeps, an empty object clears, a value replaces; the zone is kept unless given", async () => {
    const [{ id }] = await queryAs<{ id: string }>(db, theo, CREATE, [...base(), "America/Chicago", json({ kind: "walk", pace: "easy" })]);
    const update = (zone: string | null, details: unknown) => queryAs(db, theo, UPDATE, [id, ...base(), zone, json(details)]);
    await update(null, null);
    expect(await row(id)).toEqual({ time_zone: "America/Chicago", activity_details: { kind: "walk", pace: "easy" } });
    await update(null, { kind: "pickleball", play: "doubles" });
    expect((await row(id)).activity_details).toEqual({ kind: "pickleball", play: "doubles" });
    await update("America/Denver", {});
    expect(await row(id)).toEqual({ time_zone: "America/Denver", activity_details: null });
    await expect(update("Nowhere/Land", null)).rejects.toThrow(/events:bad_time_zone/);
    expect((await row(id)).time_zone).toBe("America/Denver");
  });

  it("only the owner changes them, and only through the function", async () => {
    const [{ id }] = await queryAs<{ id: string }>(db, theo, CREATE, [...base(), null, null]);
    await expect(queryAs(db, nina, UPDATE, [id, ...base(), "UTC", json({ kind: "walk" })])).rejects.toThrow(/do not own/);
    // Neither column is in the column-level UPDATE grant (0001).
    await expect(queryAs(db, theo, "update public.events set time_zone = 'UTC' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, theo, "update public.events set activity_details = '{\"kind\":\"walk\"}' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, null, UPDATE, [id, ...base(), "UTC", null])).rejects.toThrow(/permission denied|Authentication required/);
    expect(await row(id)).toEqual({ time_zone: "America/New_York", activity_details: null });
  });

  it("anyone who can see the event can read both", async () => {
    const rows = await queryAs<{ time_zone: string; activity_details: { kind: string } }>(db, null, "select time_zone, activity_details from public.events where id = $1", [basketball]);
    expect(rows[0].activity_details.kind).toBe("basketball");
  });
});

describe("activity details: shape and wording", () => {
  it("accepts each kind and rejects what it does not know", () => {
    const ok = [
      { kind: "run" }, { kind: "run", distanceMiles: 3.1, paceFrom: "8:30", paceTo: "8:30", regroup: true, noDrop: true },
      { kind: "volleyball", format: "6v6", playerLimit: 12, beginnersWelcome: true }, { kind: "basketball", format: "open" },
      { kind: "pickleball", level: "all", play: "both", paddlesAvailable: true }, { kind: "walk" }, { kind: "walk", distanceMiles: 2, pace: "brisk" },
    ];
    for (const v of ok) expect(activityDetailsSchema.safeParse(v).success, JSON.stringify(v)).toBe(true);
    const bad = [
      { kind: "chess" }, {}, { kind: "run", paceFrom: "930" }, { kind: "run", paceFrom: "10:00", paceTo: "9:00" }, { kind: "run", distanceMiles: 0 },
      { kind: "run", skillRating: 4.5 }, { kind: "basketball", format: "7v7" }, { kind: "basketball", playerLimit: 1 }, { kind: "pickleball", level: 3.5 },
      { kind: "walk", paddlesAvailable: true },
    ];
    for (const v of bad) expect(activityDetailsSchema.safeParse(v).success, JSON.stringify(v)).toBe(false);
  });

  it("has no numeric skill rating anywhere", () => {
    expect(activityDetailsSchema.safeParse({ kind: "pickleball", level: "3.5" }).success).toBe(false);
    expect(describeActivity({ kind: "pickleball", level: "intermediate" })).toEqual(["For people who have played a fair bit"]);
  });

  it("describes only what was entered", () => {
    expect(describeActivity(null)).toEqual([]);
    expect(describeActivity({ kind: "run" })).toEqual([]);
    expect(describeActivity({ kind: "walk" })).toEqual([]);
    expect(describeActivity({ kind: "run", distanceMiles: 5, paceFrom: "9:00", paceTo: "10:30", regroup: true, noDrop: true })).toEqual([
      "5 miles", "9:00 to 10:30 per mile", "Regroups along the way", "No-drop: the group waits, nobody is left behind",
    ]);
    expect(describeActivity({ kind: "run", distanceMiles: 1, paceFrom: "9:00" })).toEqual(["1 mile", "About 9:00 per mile"]);
    // false is the same as not saying: the page never claims "no beginners".
    expect(describeActivity({ kind: "volleyball", beginnersWelcome: false })).toEqual([]);
    expect(describeActivity({ kind: "basketball", format: "4v4", playerLimit: 10, beginnersWelcome: true })).toEqual(["4 v 4", "Up to 10 players", "Beginners welcome"]);
    expect(activitySummary({ kind: "basketball", format: "4v4", playerLimit: 10, beginnersWelcome: true })).toBe("Basketball · 4 v 4 · Up to 10 players");
    expect(activitySummary({ kind: "walk" })).toBe("Walk");
    expect(activitySummary(null)).toBeNull();
  });

  it("reads the form's fields for the chosen kind only", () => {
    const fields = (o: Record<string, string>) => (name: string) => o[name] ?? null;
    expect(activityFromFields(fields({ "activity.kind": "" }))).toBeNull();
    expect(activityFromFields(fields({}))).toBeNull();
    expect(activityFromFields(fields({ "activity.kind": "run", "activity.distanceMiles": "5", "activity.paceFrom": " 9:00 ", "activity.noDrop": "on", "activity.format": "4v4" })))
      .toEqual({ kind: "run", distanceMiles: 5, paceFrom: "9:00", noDrop: true });
    expect(activityFromFields(fields({ "activity.kind": "basketball", "activity.playerLimit": "abc" }))).toEqual({ kind: "basketball", playerLimit: Number.NaN });
    expect(activityDetailsSchema.safeParse({ kind: "basketball", playerLimit: Number.NaN }).success).toBe(false);
  });

  it("treats a stored value it does not understand as absent", () => {
    expect(parseActivityDetails({ kind: "chess" })).toBeNull();
    expect(parseActivityDetails("nonsense")).toBeNull();
    expect(parseActivityDetails({ kind: "walk", pace: "easy" })).toEqual({ kind: "walk", pace: "easy" });
  });

  it("only hands the database zone names it accepts", () => {
    for (const z of ["UTC", "America/New_York", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(eventTimeZone(z)).toBe(z);
    for (const z of ["GMT", "EST5EDT", "Mars/Phobos", "", null, undefined, "ABC+3"]) expect(eventTimeZone(z)).toBeNull();
  });

  it("maps the database's error keys to plain messages", () => {
    expect(parseEventsMessage("events:bad_time_zone")?.message).toBe("Unknown time zone");
    expect(parseEventsMessage("something else")).toBeNull();
  });
});

describe("demo twin (4.2)", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    title: "Demo activity run", description: "A steady loop along the river, all welcome.", placeId: null, locationName: "Scioto Mile", address: null,
    lat: 39.96, lng: -83.0, startsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), endsAt: null, categorySlug: "fitness", capacity: 12, tags: ["running"],
    ...over,
  });

  it("seeds the zone and the activity details", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const ev = await repo.events.get(basketball, null);
    expect(ev?.timeZone).toBe("America/New_York");
    expect(ev?.activityDetails).toEqual({ kind: "basketball", format: "4v4", playerLimit: 10, beginnersWelcome: true });
  });

  it("create and update behave like the SQL functions", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const plain = await repo.events.create(input(), theo);
    expect([plain.timeZone, plain.activityDetails]).toEqual(["America/New_York", null]);
    const ev = await repo.events.create(input({ timeZone: "America/Chicago", activityDetails: { kind: "walk", pace: "easy" } }), theo);
    expect([ev.timeZone, ev.activityDetails]).toEqual(["America/Chicago", { kind: "walk", pace: "easy" }]);
    // Omitted keeps; a value replaces; null clears; the zone is kept unless given.
    let next = await repo.events.update(ev.id, input(), theo);
    expect([next.timeZone, next.activityDetails]).toEqual(["America/Chicago", { kind: "walk", pace: "easy" }]);
    next = await repo.events.update(ev.id, input({ activityDetails: { kind: "pickleball", play: "doubles" } }), theo);
    expect(next.activityDetails).toEqual({ kind: "pickleball", play: "doubles" });
    next = await repo.events.update(ev.id, input({ timeZone: "America/Denver", activityDetails: null }), theo);
    expect([next.timeZone, next.activityDetails]).toEqual(["America/Denver", null]);
    await expect(repo.events.update(ev.id, input({ timeZone: "Nowhere/Land" }), theo)).rejects.toThrow("Unknown time zone");
    await expect(repo.events.update(ev.id, input({ activityDetails: { kind: "chess" } }), theo)).rejects.toThrow("Check the activity details");
    await expect(repo.events.update(ev.id, input({ timeZone: "UTC" }), nina)).rejects.toThrow(/permission/);
    expect((await repo.events.get(ev.id, theo))?.timeZone).toBe("America/Denver");
  });

  it.each(["Mars/Phobos", "ABC+3", "EST5EDT", "", "america"])("refuses the zone %j like the database", async (zone) => {
    const repo = createDemoRepository(createIsolatedStore());
    await expect(repo.events.create(input({ timeZone: zone }), theo)).rejects.toThrow("Unknown time zone");
  });
});
