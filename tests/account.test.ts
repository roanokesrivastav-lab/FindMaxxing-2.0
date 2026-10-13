/**
 * Account features (Session 9): deletion and password recovery. The database
 * test deletes the auth user the way the admin API does and checks what the
 * cascades leave; the parity test runs the same deletion through the demo
 * store; the action tests go through the real demo flows.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, type DemoState } from "../src/lib/data/demo/store";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const jules = user("jules");
const maya = user("maya_r");
const sam = user("sam_k");
const priya = user("priya");
const ridgeline = stableId("place:Ridgeline Loop"); // jules'
const ridgelineEvent = stableId("event:Ridgeline sunrise hike"); // jules', with other attendees
const lumen = stableId("place:The Lumen Rooftop"); // lena's

/** Rows that mention a user, table by table, the way both stores can count them. */
const SQL_COUNTS: Record<string, string> = {
  profiles: "select count(*)::int as n from public.profiles where id = $1",
  places: "select count(*)::int as n from public.places where creator_id = $1",
  events: "select count(*)::int as n from public.events where creator_id = $1",
  photos: "select count(*)::int as n from public.place_photos where uploader_id = $1",
  ratings: "select count(*)::int as n from public.place_ratings where user_id = $1",
  saves: "select count(*)::int as n from public.saved_places where user_id = $1",
  lists: "select count(*)::int as n from public.saved_lists where owner_id = $1",
  follows: "select count(*)::int as n from public.follows where follower_id = $1 or following_id = $1",
  attending: "select count(*)::int as n from public.event_attendees where user_id = $1",
  reportsFiled: "select count(*)::int as n from public.reports where reporter_id = $1",
};

function demoCounts(state: DemoState, id: string): Record<string, number> {
  return {
    profiles: state.profiles.filter((p) => p.id === id).length,
    places: state.places.filter((p) => p.creatorId === id).length,
    events: state.events.filter((e) => e.creatorId === id).length,
    photos: state.placePhotos.filter((p) => p.uploaderId === id).length,
    ratings: state.placeRatings.filter((r) => r.userId === id).length,
    saves: state.savedPlaces.filter((s) => s.userId === id).length,
    lists: state.savedLists.filter((l) => l.ownerId === id).length,
    follows: state.follows.filter((f) => f.followerId === id || f.followingId === id).length,
    attending: state.eventAttendees.filter((a) => a.userId === id).length,
    reportsFiled: state.reports.filter((r) => r.reporterId === id).length,
  };
}

describe("account deletion in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const counts = async (id: string) => {
    const out: Record<string, number> = {};
    for (const [key, sql] of Object.entries(SQL_COUNTS)) out[key] = (await db.query<{ n: number }>(sql, [id])).rows[0].n;
    return out;
  };

  beforeAll(async () => {
    db = await createSeededDb();
    // Give jules one of everything: a list, a photo on someone else's place,
    // a photo on their own place from someone else, and a report.
    const [list] = await as<{ id: string }>(jules, "insert into public.saved_lists (owner_id, name) values ($1, 'Mine') returning id", [jules]);
    await as(jules, "select public.add_to_saved_list($1, $2)", [list.id, lumen]);
    await as(jules, "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, 'storage:x', $2, $3)", [lumen, `${jules}/on-lumen.webp`, jules]);
    await as(maya, "insert into public.place_photos (place_id, url, storage_path, uploader_id) values ($1, 'storage:x', $2, $3)", [ridgeline, `${maya}/on-ridgeline.webp`, maya]);
    await as(jules, "insert into public.reports (reporter_id, target_type, target_id, reason) values ($1, 'place', $2, 'spam')", [jules, lumen]);
    // maya bookmarks jules' place into a list of her own.
    const [trails] = await as<{ id: string }>(maya, "insert into public.saved_lists (owner_id, name) values ($1, 'Trails') returning id", [maya]);
    await as(maya, "select public.add_to_saved_list($1, $2)", [trails.id, ridgeline]);
    // sam moderates something, then is deleted later: the history must survive.
    await as(sam, "select * from public.moderate_target('place', $1, 'review', 'checked')", [lumen]);
  });

  it("lists every stored object the deletion must remove, for the service role only", async () => {
    await expect(as(jules, "select * from public.account_storage_paths($1)", [jules])).rejects.toThrow(/permission denied/);
    await db.exec("set role service_role");
    try {
      const { rows } = await db.query<{ storage_path: string }>("select storage_path from public.account_storage_paths($1) order by 1", [jules]);
      expect(rows.map((r) => r.storage_path)).toEqual([`${jules}/on-lumen.webp`, `${maya}/on-ridgeline.webp`].sort());
    } finally {
      await db.exec("reset role");
    }
  });

  it("removes the profile and everything that hangs off it, including events other people joined", async () => {
    const before = await counts(jules);
    expect(before.places).toBeGreaterThan(0);
    expect(before.events).toBeGreaterThan(0);
    await db.query("delete from auth.users where id = $1", [jules]);
    expect(await counts(jules)).toEqual({ ...Object.fromEntries(Object.keys(before).map((k) => [k, 0])) });
    // Nothing of theirs is readable by anyone.
    expect(await as(priya, "select id from public.places where id = $1", [ridgeline])).toHaveLength(0);
    expect(await as(priya, "select id from public.events where id = $1", [ridgelineEvent])).toHaveLength(0);
    expect(await as(null, "select 1 from public.place_photos where storage_path like $1", [`${jules}/%`])).toHaveLength(0);
    // Other people's bookmarks of their places went with the places.
    expect((await db.query("select 1 from public.saved_places where place_id = $1", [ridgeline])).rows).toHaveLength(0);
    expect((await db.query("select 1 from public.saved_list_items where place_id = $1", [ridgeline])).rows).toHaveLength(0);
  });

  it("keeps the reports they filed, with nothing that identifies them", async () => {
    const { rows } = await db.query<{ reporter_id: string | null }>("select reporter_id from public.reports where target_id = $1 and reason = 'spam'", [lumen]);
    expect(rows).toEqual([{ reporter_id: null }]);
  });

  it("keeps moderation history when a moderator leaves, without their name", async () => {
    await db.query("delete from auth.users where id = $1", [sam]);
    const { rows } = await db.query<{ moderator_id: string | null; action: string }>("select moderator_id, action from public.moderation_actions where target_id = $1", [lumen]);
    expect(rows).toEqual([{ moderator_id: null, action: "review" }]);
  });
});

describe("account deletion parity", () => {
  it("leaves the same counts in the demo store as the database cascades", async () => {
    const db = await createSeededDb();
    const handle = createIsolatedStore();
    const sqlCount = async (id: string) => {
      const out: Record<string, number> = {};
      for (const [key, sql] of Object.entries(SQL_COUNTS)) out[key] = (await db.query<{ n: number }>(sql, [id])).rows[0].n;
      return out;
    };
    // Same starting point for jules in both stores.
    expect(demoCounts(handle.state, jules)).toEqual(await sqlCount(jules));
    const totals = async () => ({
      places: (await db.query<{ n: number }>("select count(*)::int as n from public.places")).rows[0].n,
      events: (await db.query<{ n: number }>("select count(*)::int as n from public.events")).rows[0].n,
      saves: (await db.query<{ n: number }>("select count(*)::int as n from public.saved_places")).rows[0].n,
      attendees: (await db.query<{ n: number }>("select count(*)::int as n from public.event_attendees")).rows[0].n,
      reports: (await db.query<{ n: number }>("select count(*)::int as n from public.reports")).rows[0].n,
    });
    await db.query("delete from auth.users where id = $1", [jules]);
    const objects = deleteDemoAccount(handle, jules);
    expect(objects).toEqual({ placePhotos: [], avatars: [] });
    expect(demoCounts(handle.state, jules)).toEqual(await sqlCount(jules));
    const s = handle.state;
    expect({ places: s.places.length, events: s.events.length, saves: s.savedPlaces.length, attendees: s.eventAttendees.length, reports: s.reports.length }).toEqual(await totals());
    // Ratings on other places were recomputed in both.
    for (const p of s.places) {
      const { rows } = await db.query<{ rating_count: number; rating_avg: string }>("select rating_count, rating_avg from public.places where id = $1", [p.id]);
      expect([p.id, p.ratingCount, p.ratingAvg]).toEqual([p.id, rows[0].rating_count, Number(rows[0].rating_avg)]);
    }
  });
});

// ----------------------------------------------------------------------------
// Actions, through the real demo flows
// ----------------------------------------------------------------------------
const nav = vi.hoisted(() => ({ cookies: new Map<string, string>(), ip: "203.0.113.9" }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": nav.ip }),
  cookies: async () => ({
    get: (name: string) => (nav.cookies.has(name) ? { name, value: nav.cookies.get(name) } : undefined),
    set: (name: string, value: string) => nav.cookies.set(name, value),
    delete: (name: string) => nav.cookies.delete(name),
    getAll: () => [...nav.cookies].map(([name, value]) => ({ name, value })),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` });
  },
}));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => {
    const id = nav.cookies.get("fm_demo_session");
    const u = id ? globalThis.__findmaxxingDemoStore?.state.authUsers.find((x) => x.id === id) : undefined;
    return u ? { id: u.id, email: u.email } : null;
  },
}));

describe("account actions (demo mode)", async () => {
  const { requestPasswordResetAction, resetPasswordAction, deleteAccountAction } = await import("../src/server/actions/account");
  const { limiters } = await import("../src/server/limiters");
  const { getDemoStore, verifyPassword } = await import("../src/lib/data/demo/store");
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  beforeEach(() => {
    globalThis.__findmaxxingDemoStore = createIsolatedStore();
    nav.cookies.clear();
    nav.ip = "203.0.113.9";
    limiters().passwordReset.reset();
  });

  it("answers a reset request the same way whether or not the account exists", async () => {
    const known = await requestPasswordResetAction(null, form({ email: "maya@example.com" }));
    const unknown = await requestPasswordResetAction(null, form({ email: "nobody@example.com" }));
    expect(known).toMatchObject({ ok: true, data: { demoLink: expect.stringMatching(/^\/auth\/reset\?token=/) } });
    expect(unknown).toMatchObject({ ok: true, data: { demoLink: expect.stringMatching(/^\/auth\/reset\?token=/) } });
  });

  it("resets the password once with a real link, signs the user in, and refuses the link afterwards", async () => {
    const res = await requestPasswordResetAction(null, form({ email: "maya@example.com" }));
    const token = new URL(`http://x${res.ok ? res.data.demoLink : ""}`).searchParams.get("token")!;
    expect(await resetPasswordAction(null, form({ token, password: "new-password-1", confirm: "nope" }))).toMatchObject({ ok: false, fieldErrors: { confirm: "The passwords don't match" } });
    await expect(resetPasswordAction(null, form({ token, password: "new-password-1", confirm: "new-password-1" }))).rejects.toMatchObject({ digest: expect.stringContaining("/profile") });
    expect(nav.cookies.get("fm_demo_session")).toBe(maya);
    const stored = getDemoStore().state.authUsers.find((u) => u.id === maya)!;
    expect(verifyPassword("new-password-1", stored.passwordHash)).toBe(true);
    expect(await resetPasswordAction(null, form({ token, password: "another-one", confirm: "another-one" }))).toMatchObject({ ok: false, error: expect.stringMatching(/expired or was already used/) });
  });

  it("fails a decoy link exactly like an expired one", async () => {
    const res = await requestPasswordResetAction(null, form({ email: "nobody@example.com" }));
    const token = new URL(`http://x${res.ok ? res.data.demoLink : ""}`).searchParams.get("token")!;
    expect(await resetPasswordAction(null, form({ token, password: "new-password-1", confirm: "new-password-1" }))).toMatchObject({ ok: false, error: expect.stringMatching(/expired or was already used/) });
    expect(await resetPasswordAction(null, form({ token: "made-up", password: "new-password-1", confirm: "new-password-1" }))).toMatchObject({ ok: false, error: expect.stringMatching(/expired or was already used/) });
  });

  it("limits reset requests per network", async () => {
    for (let i = 0; i < 5; i++) expect(await requestPasswordResetAction(null, form({ email: `x${i}@example.com` }))).toMatchObject({ ok: true });
    expect(await requestPasswordResetAction(null, form({ email: "y@example.com" }))).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("deletes an account only with the right password, then signs out", async () => {
    nav.cookies.set("fm_demo_session", jules);
    expect(await deleteAccountAction(null, form({ password: "wrong" }))).toMatchObject({ ok: false, fieldErrors: { password: "That password isn't right" } });
    expect(getDemoStore().state.profiles.some((p) => p.id === jules)).toBe(true);
    await expect(deleteAccountAction(null, form({ password: "findmaxxing" }))).rejects.toMatchObject({ digest: expect.stringContaining("/?deleted=1") });
    expect(nav.cookies.has("fm_demo_session")).toBe(false);
    expect(demoCounts(getDemoStore().state, jules)).toEqual(Object.fromEntries(Object.keys(SQL_COUNTS).map((k) => [k, 0])));
    expect(getDemoStore().state.authUsers.some((u) => u.id === jules)).toBe(false);
  });
});
