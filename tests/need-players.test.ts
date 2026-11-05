/**
 * Roadmap R2: opt-in need-players alerts (0058; spec docs/features/R2.md). Off by default; own settings
 * only (RLS); coarse cell; one alert per session, three per 24 hours; every exclusion in the spec;
 * blocks and mutes through notify(); never RSVPs. PGlite on a frozen clock, demo parity, the real action
 * and page.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), nina = user("nina"), lena = user("lena"), sam = user("sam_k");
const HOUR = 3_600_000;
const HERE = { lat: 39.97, lng: -83.0 };

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: nina, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null), requireViewer: async () => ({ id: ctx.viewer, profile: {} }) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, back() {} }),
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
  redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); },
}));

describe("database (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const now = () => new Date().toISOString();
  /** A free session by maya near HERE, starting in `inHours`, needing `min` with the host going. */
  const session = async (o: { inHours?: number; min?: number | null; category?: string; lat?: number; lng?: number } = {}) => {
    const [{ id }] = await queryAs<{ id: string }>(db, maya, "select public.create_event_with_details('Needs players', 'A game that needs players.', null, 'Courts', null, $1, $2, $3, null, $4, 10, '{}') as id",
      [o.lat ?? HERE.lat + 0.005, o.lng ?? HERE.lng, new Date(Date.now() + (o.inHours ?? 24) * HOUR).toISOString(), o.category ?? "pickup-sports"]);
    if (o.min !== null) await queryAs(db, maya, "update public.events set min_attendance = $2 where id = $1", [id, o.min ?? 4]);
    return id;
  };
  const optIn = (who: string, categories = ["pickup-sports"], radius = 3) =>
    queryAs(db, who, "select public.set_need_player_alerts(true, $1, $2, $3, $4)", [categories, HERE.lat + 0.004321, HERE.lng - 0.001234, radius]);
  const sent = async (who: string) => (await db.query<{ subject_id: string; detail: string }>("select subject_id, detail from public.notifications where user_id = $1 and type = 'need_players' order by created_at", [who])).rows;
  const run = async () => (await db.query<{ n: number }>("select public.send_need_player_alerts($1) as n", [now()])).rows[0].n;

  it("off by default; own settings only (RLS); the stored area is a rounded cell", async () => {
    await session();
    expect(await run()).toBe(0); // nobody opted in
    await optIn(nina);
    const mine = await queryAs<{ cell_lat: string; cell_lng: string }>(db, nina, "select cell_lat, cell_lng from public.need_player_alerts");
    expect(mine).toEqual([{ cell_lat: "39.97", cell_lng: "-83.00" }]);
    for (const who of [theo, sam, null]) expect(await queryAs(db, who, "select user_id from public.need_player_alerts where user_id = $1", [nina])).toEqual([]);
    await expect(queryAs(db, nina, "update public.need_player_alerts set radius_km = 10")).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, nina, "select public.set_need_player_alerts(true, '{not-a-category}', 0, 0, 3)")).rejects.toThrow(/Unknown activity/);
    await expect(queryAs(db, null, "select public.set_need_player_alerts(true, '{pickup-sports}', 0, 0, 3)")).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, nina, "select public.send_need_player_alerts()")).rejects.toThrow(/permission denied/);
  });

  it("one alert per session (dedupe), with how many more are needed; never an RSVP", async () => {
    await db.query("delete from public.notifications where type = 'need_players'");
    const ev = await session({ min: 4 });
    expect(await run()).toBeGreaterThanOrEqual(1);
    expect((await sent(nina)).filter((n) => n.subject_id === ev)).toEqual([{ subject_id: ev, detail: "3 more needed" }]);
    await run();
    expect((await sent(nina)).filter((n) => n.subject_id === ev)).toHaveLength(1);
    expect((await db.query("select 1 from public.event_attendees where event_id = $1 and user_id = $2", [ev, nina])).rows).toEqual([]);
    expect((await db.query("select 1 from public.event_participants where event_id = $1 and user_id = $2", [ev, nina])).rows).toEqual([]);
  });

  it("at most three need-players alerts per person per 24 hours", async () => {
    await db.query("delete from public.notifications where type = 'need_players'");
    for (let i = 0; i < 5; i++) await session({ inHours: 10 + i });
    await run();
    expect((await sent(nina)).length).toBe(3);
  });

  it("no alert for other activities, far away, met minimum, decided, past deadline, >48 h, priced, own, already going, hidden, blocked, muted", async () => {
    await db.query("delete from public.notifications where type = 'need_players'");
    await optIn(lena, ["pickup-sports"], 1);
    const excluded = {
      otherCategory: await session({ category: "music" }),
      farAway: await session({ lat: HERE.lat + 0.2 }),
      minMet: await session({ min: 2 }),
      tooLate: await session({ inHours: 60 }),
      noMin: await session({ min: null }),
    };
    const decided = await session(); await queryAs(db, maya, "select public.confirm_session($1)", [decided]);
    const pastDeadline = await session(); await queryAs(db, maya, "update public.events set decision_deadline = now() + interval '1 minute' where id = $1", [pastDeadline]);
    const priced = await session(); await db.query("update public.events set price_cents = 900 where id = $1", [priced]);
    const going = await session(); await queryAs(db, lena, "select public.join_event($1)", [going]);
    const hidden = await session(); await db.query("alter table public.events disable trigger user"); await db.query("update public.events set status = 'hidden' where id = $1", [hidden]); await db.query("alter table public.events enable trigger user");
    const [{ id: own }] = await queryAs<{ id: string }>(db, lena, "select public.create_event_with_details('Mine', 'My own game that needs players.', null, 'Courts', null, $1, $2, $3, null, 'pickup-sports', 10, '{}') as id", [HERE.lat, HERE.lng, new Date(Date.now() + 5 * HOUR).toISOString()]);
    await queryAs(db, lena, "update public.events set min_attendance = 4 where id = $1", [own]);
    await db.query("select public.send_need_player_alerts($1)", [new Date(Date.now() + 2 * 60_000).toISOString()]);
    const got = new Set((await sent(lena)).map((n) => n.subject_id));
    for (const id of [...Object.values(excluded), decided, pastDeadline, priced, going, hidden, own]) expect(got.has(id)).toBe(false);
    // Blocks and mutes go through notify(): theo blocked the host; jules muted the type.
    await optIn(theo); await db.query("insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [theo, maya]);
    const jules = user("jules"); await optIn(jules);
    await queryAs(db, jules, "insert into public.notification_settings (user_id, muted_types) values (auth.uid(), array['need_players'])");
    const fresh = await session({ inHours: 6 });
    await run();
    // theo may still hear about lena's own session above (he blocked maya, not lena), never maya's.
    const hosts = async (ids: string[]) => (await db.query<{ creator_id: string }>("select creator_id from public.events where id = any($1)", [ids])).rows.map((r) => r.creator_id);
    expect(await hosts((await sent(theo)).map((n) => n.subject_id))).not.toContain(maya);
    expect((await sent(theo)).map((n) => n.subject_id)).not.toContain(fresh);
    expect(await sent(jules)).toEqual([]);
  });
});

describe("demo parity, action and page", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = nina; });
  afterEach(() => vi.unstubAllEnvs());
  const make = async (o: { inHours?: number; min?: number; category?: string; lat?: number } = {}) => {
    const e = await ctx.repo.events.create({ title: "Needs players", description: "A game that needs players.", locationName: "Courts", lat: o.lat ?? HERE.lat + 0.005, lng: HERE.lng, startsAt: new Date(Date.now() + (o.inHours ?? 24) * HOUR).toISOString(), categorySlug: o.category ?? "pickup-sports", capacity: 10, tags: [], minAttendance: o.min ?? 4 }, maya);
    return e.id;
  };

  it("the real save action stores a rounded cell; the demo sends like SQL (dedupe, cap, exclusions)", async () => {
    const { saveNeedPlayerAlertsAction } = await import("../src/server/actions/events");
    expect(await saveNeedPlayerAlertsAction({ enabled: true, categories: [], cellLat: 1, cellLng: 1, radiusKm: 3 })).toMatchObject({ ok: false, fieldErrors: { categories: expect.any(String) } });
    expect(await saveNeedPlayerAlertsAction({ enabled: true, categories: ["pickup-sports"], cellLat: HERE.lat + 0.004321, cellLng: HERE.lng - 0.001234, radiusKm: 3 })).toMatchObject({ ok: true });
    expect(await ctx.repo.events.needPlayerAlerts(nina)).toEqual({ enabled: true, categories: ["pickup-sports"], cellLat: 39.97, cellLng: -83, radiusKm: 3 });
    const ev = await make();
    await make({ category: "music" });
    await make({ lat: HERE.lat + 0.2 });
    await make({ min: 2 });
    for (let i = 0; i < 4; i++) await make({ inHours: 30 + i });
    const now = new Date().toISOString();
    expect(await ctx.repo.events.sendNeedPlayerAlerts(now)).toBe(3);
    expect(await ctx.repo.events.sendNeedPlayerAlerts(now)).toBe(0);
    const notes = (await ctx.repo.notifications.list(nina)).items.filter((n) => n.type === "need_players");
    expect(notes).toHaveLength(3);
    expect(notes.some((n) => n.subjectId === ev && n.detail === "3 more needed")).toBe(true);
    expect((await ctx.repo.events.get(ev, nina))!.viewerJoined).toBe(false);
  });

  it("the settings page: off by default; flag off → 404", async () => {
    const { default: Page } = await import("../src/app/events/alerts/page");
    const html = renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: await Page() })));
    expect(html).toContain("Need-players alerts");
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*>[^<]*Tell me/);
    expect(html).toContain("never your exact location");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    await expect(Page()).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
