/**
 * Creating an event in one step (0036_create_event_with_details.sql): the
 * event, its tags and the creator's attendance happen together or not at all,
 * under the caller's own RLS policies and triggers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const theo = user("theo");
const nina = user("nina");

const CREATE = `select public.create_event_with_details($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as id`;
const args = (over: Partial<Record<string, unknown>> = {}) => {
  const v = {
    title: "Atomic picnic", description: "Blankets, snacks and a frisbee in the park.", placeId: null, locationName: "Goodale Park", address: null,
    lat: 39.97, lng: -83.0, startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: null, category: "outdoors", capacity: 12, tags: ["hiking", "fitness"],
    ...over,
  };
  return [v.title, v.description, v.placeId, v.locationName, v.address, v.lat, v.lng, v.startsAt, v.endsAt, v.category, v.capacity, v.tags];
};
const countEvents = async (db: PGlite, title: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from public.events where title = $1", [title])).rows[0].n;

describe("create_event_with_details", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("creates the event as the caller, with its tags and the creator attending", async () => {
    const [{ id }] = await queryAs<{ id: string }>(db, theo, CREATE, args({ tags: ["hiking", "fitness", "hiking"] }));
    const event = (await db.query<{ creator_id: string; status: string; capacity: number }>("select creator_id, status, capacity from public.events where id = $1", [id])).rows[0];
    expect(event).toEqual({ creator_id: theo, status: "published", capacity: 12 });
    const tags = (await db.query<{ interest_slug: string }>("select interest_slug from public.event_tags where event_id = $1 order by 1", [id])).rows;
    expect(tags.map((t) => t.interest_slug)).toEqual(["fitness", "hiking"]);
    expect((await db.query("select user_id from public.event_attendees where event_id = $1", [id])).rows).toEqual([{ user_id: theo }]);
    // The creator's chat membership follows from attendance, as with the separate inserts.
    expect((await db.query("select m.user_id from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.event_id = $1", [id])).rows).toEqual([{ user_id: theo }]);
  });

  it("leaves nothing behind when a later step fails", async () => {
    await expect(queryAs(db, theo, CREATE, args({ title: "Half-made event", tags: ["hiking", "no-such-interest"] }))).rejects.toThrow(/foreign key/);
    expect(await countEvents(db, "Half-made event")).toBe(0);
  });

  it("keeps the insert policies: no linking a place the caller cannot see", async () => {
    const place = stableId("place:Ridgeline Loop");
    await db.query("update public.places set status = 'removed' where id = $1", [place]);
    try {
      await expect(queryAs(db, nina, CREATE, args({ title: "Hidden place event", placeId: place }))).rejects.toThrow(/row-level security/);
      expect(await countEvents(db, "Hidden place event")).toBe(0);
    } finally {
      await db.query("update public.places set status = 'published' where id = $1", [place]);
    }
  });

  it("keeps the table checks and is not callable signed out", async () => {
    await expect(queryAs(db, theo, CREATE, args({ title: "Bad coordinates", lat: 95 }))).rejects.toThrow(/check/);
    await expect(queryAs(db, null, CREATE, args({ title: "Anon event" }))).rejects.toThrow(/permission denied/);
    expect(await countEvents(db, "Anon event")).toBe(0);
  });

  it("runs as the caller, not as the function owner", async () => {
    const { rows } = await db.query<{ prosecdef: boolean }>("select prosecdef from pg_proc where proname = 'create_event_with_details'");
    expect(rows).toEqual([{ prosecdef: false }]);
  });
});
