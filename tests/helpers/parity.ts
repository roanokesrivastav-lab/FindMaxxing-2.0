import type { PGlite } from "@electric-sql/pglite";
import type { createIsolatedStore } from "../../src/lib/data/demo/store";

/**
 * Copies the demo store's timestamps into a seeded database, so SQL and the
 * demo twin rank on the same clock: "the most recent save" picks an
 * explanation, event times set "starts soon", a place's age decays its
 * popularity in the cold-start fallback, and the age of saves, ratings and
 * joins decays their weight in the viewer's taste. Triggers that would stamp now()
 * over the copied values (or refuse the change) are off while it runs.
 */
export async function alignDbWithDemo(db: PGlite, store: ReturnType<typeof createIsolatedStore>): Promise<void> {
  await db.exec("set session_replication_role = replica;");
  try {
    for (const s of store.state.savedPlaces) await db.query("update public.saved_places set created_at = $3 where user_id = $1 and place_id = $2", [s.userId, s.placeId, s.createdAt]);
    for (const r of store.state.placeRatings) await db.query("update public.place_ratings set updated_at = $3 where user_id = $1 and place_id = $2", [r.userId, r.placeId, r.updatedAt]);
    for (const e of store.state.events) await db.query("update public.events set starts_at = $2, ends_at = $3 where id = $1", [e.id, e.startsAt, e.endsAt]);
    for (const a of store.state.eventAttendees) await db.query("update public.event_attendees set created_at = $3 where user_id = $1 and event_id = $2", [a.userId, a.eventId, a.createdAt]);
    for (const p of store.state.places) await db.query("update public.places set created_at = $2 where id = $1", [p.id, p.createdAt]);
  } finally {
    await db.exec("set session_replication_role = default;");
  }
}
