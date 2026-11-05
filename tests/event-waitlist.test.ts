/**
 * Roadmap 4.4: waitlist and offers (0054), logic and RLS on PGlite (the concurrency cases are in
 * event-waitlist-pg.test.ts on real PostgreSQL). Every state transition, offer window and cutoff,
 * D-M (skip ineligible, keep place), price and capacity locks, cancellation, phase-2 legacy writes,
 * account deletion, RLS as anon / participant / host / another user / moderator, demo parity on the same
 * script, the real action and page, and a source check that no direct event_attendees write is left.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
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
const maya = user("maya_r"), theo = user("theo"), nina = user("nina"), lena = user("lena"), dev = user("dev"), jules = user("jules"), sam = user("sam_k");

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: maya, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/time/server", () => ({ getViewerTime: async () => ({ timeZone: "America/New_York", now: Date.now() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, back() {} }),
  usePathname: () => "/events",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
  redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); },
}));

const HOUR = 3_600_000;

describe("database (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const make = async (capacity: number | null, startsInMs = 3 * 24 * HOUR) => {
    const [{ id }] = await queryAs<{ id: string }>(db, maya, "select public.create_event_with_details('Waitlist test', 'Testing the waitlist here.', null, 'Goodale', null, 39.97, -83, $1, null, 'pickup-sports', $2, '{}') as id", [new Date(Date.now() + startsInMs).toISOString(), capacity]);
    return id;
  };
  const rpc = async (who: string, fn: string, ev: string) => (await queryAs<{ r: string }>(db, who, `select public.${fn}($1) as r`, [ev]))[0].r;
  const row = async (ev: string, who: string) => (await db.query<{ status: string; queue_position: string | null; offer_expires_at: Date | null; offered_at: Date | null; reason: string | null }>("select status, queue_position, offer_expires_at, offered_at, reason from public.event_participants where event_id = $1 and user_id = $2", [ev, who])).rows[0] ?? null;
  const going = async (ev: string) => (await db.query<{ user_id: string }>("select user_id from public.event_attendees where event_id = $1", [ev])).rows.map((r) => r.user_id).sort();

  it("join: going while a seat is free, then waitlisted in FIFO order; already going is a no-op", async () => {
    const ev = await make(2);
    expect(await rpc(theo, "join_event", ev)).toBe("going");
    expect(await rpc(theo, "join_event", ev)).toBe("going");
    expect(await rpc(nina, "join_event", ev)).toBe("waitlisted");
    expect(await rpc(nina, "join_event", ev)).toBe("waitlisted");
    expect(await rpc(lena, "join_event", ev)).toBe("waitlisted");
    expect(Number((await row(ev, nina)).queue_position)).toBeLessThan(Number((await row(ev, lena)).queue_position));
    expect(await going(ev)).toEqual([maya, theo].sort());
    const [{ r }] = await queryAs<{ r: { waitlist: number; spotsOpen: number } }>(db, null, "select public.event_readiness($1::uuid) as r", [ev]);
    expect(r).toMatchObject({ waitlist: 2, spotsOpen: 0 });
  });

  it("leave frees the seat as an offer to the next person (2 h, or 30 min before the start), holding it", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(nina, "join_event", ev);
    await rpc(lena, "join_event", ev);
    expect(await rpc(theo, "leave_event", ev)).toBe("left");
    const offer = await row(ev, nina);
    expect(offer.status).toBe("offered");
    expect(offer.offer_expires_at!.getTime() - offer.offered_at!.getTime()).toBe(2 * HOUR);
    // The held seat is not open: a newcomer is waitlisted behind lena.
    expect(await rpc(dev, "join_event", ev)).toBe("waitlisted");
    const notes = (await db.query<{ type: string; user_id: string }>("select type, user_id from public.notifications where subject_id = $1 and type like 'event_offer%'", [ev])).rows;
    expect(notes).toEqual([{ type: "event_offer", user_id: nina }]);
    // Accept converts the held seat; the participant row goes; only now are they going.
    expect(await rpc(nina, "accept_offer", ev)).toBe("going");
    expect(await row(ev, nina)).toBeNull();
    expect(await going(ev)).toEqual([maya, nina].sort());
  });

  it("an offer close to the start is capped at 30 min before it; inside the cutoff no offers are made", async () => {
    const soon = await make(2, 90 * 60_000); // starts in 90 min → expires 60 min from now
    await rpc(theo, "join_event", soon);
    await rpc(nina, "join_event", soon);
    await rpc(theo, "leave_event", soon);
    const o = await row(soon, nina);
    const starts = (await db.query<{ s: Date }>("select starts_at as s from public.events where id = $1", [soon])).rows[0].s;
    expect(o.offer_expires_at!.getTime()).toBe(starts.getTime() - 30 * 60_000);
    const inside = await make(2, 20 * 60_000);
    await rpc(theo, "join_event", inside);
    await rpc(nina, "join_event", inside);
    await rpc(theo, "leave_event", inside);
    expect((await row(inside, nina)).status).toBe("waitlisted");
    // The freed seat just becomes open.
    expect(await rpc(lena, "join_event", inside)).toBe("going");
  });

  it("decline passes the seat on; accepting after expiry → offer_expired, off the list, passed on (no re-queue)", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    for (const u of [nina, lena, dev]) await rpc(u, "join_event", ev);
    await rpc(theo, "leave_event", ev);
    expect(await rpc(nina, "decline_offer", ev)).toBe("declined");
    expect((await row(ev, nina))).toMatchObject({ status: "declined", reason: "declined" });
    expect((await row(ev, lena)).status).toBe("offered");
    await db.query("update public.event_participants set offer_expires_at = clock_timestamp() - interval '1 second' where event_id = $1 and user_id = $2", [ev, lena]);
    // Expired offers stop holding at once, before any sweep: the readiness shows the seat as open.
    expect((await queryAs<{ r: { spotsOpen: number } }>(db, null, "select public.event_readiness($1::uuid) as r", [ev]))[0].r.spotsOpen).toBe(1);
    expect(await rpc(lena, "accept_offer", ev)).toBe("offer_expired");
    expect(await row(ev, lena)).toMatchObject({ status: "declined", reason: "expired" });
    expect((await row(ev, dev)).status).toBe("offered");
    expect(await going(ev)).toEqual([maya]);
  });

  it("expire_offers is service-only; it declines, notifies once and offers the next person", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(nina, "join_event", ev);
    await rpc(lena, "join_event", ev);
    await rpc(theo, "leave_event", ev);
    await expect(queryAs(db, maya, "select public.expire_offers()")).rejects.toThrow(/permission denied/);
    await db.query("update public.event_participants set offer_expires_at = clock_timestamp() - interval '1 second' where event_id = $1 and status = 'offered'", [ev]);
    expect((await db.query<{ n: number }>("select public.expire_offers() as n")).rows[0].n).toBeGreaterThanOrEqual(1);
    await db.query("select public.expire_offers()");
    expect(await row(ev, nina)).toMatchObject({ status: "declined", reason: "expired" });
    expect((await row(ev, lena)).status).toBe("offered");
    const expired = (await db.query("select 1 from public.notifications where subject_id = $1 and user_id = $2 and type = 'event_offer_expired'", [ev, nina])).rows;
    expect(expired).toHaveLength(1);
  });

  it("interested never touches seats or the queue; leave from the waitlist; host removal; the host can't remove themselves", async () => {
    const ev = await make(2);
    expect((await queryAs<{ r: string }>(db, theo, "select public.set_interest($1, true) as r", [ev]))[0].r).toBe("interested");
    expect((await queryAs<{ r: { spotsOpen: number } }>(db, null, "select public.event_readiness($1::uuid) as r", [ev]))[0].r.spotsOpen).toBe(1);
    expect(await rpc(theo, "join_event", ev)).toBe("going");
    expect(await row(ev, theo)).toBeNull(); // converting to going deletes the participant row
    expect((await queryAs<{ r: string }>(db, theo, "select public.set_interest($1, true) as r", [ev]))[0].r).toBe("going");
    await rpc(nina, "join_event", ev);
    await rpc(lena, "join_event", ev);
    expect(await rpc(nina, "leave_event", ev)).toBe("left");
    expect((await row(ev, nina)).status).toBe("left");
    await expect(queryAs(db, theo, "select public.host_remove_participant($1, $2)", [ev, lena])).rejects.toThrow(/do not host/);
    expect((await queryAs<{ r: string }>(db, maya, "select public.host_remove_participant($1, $2) as r", [ev, theo]))[0].r).toBe("removed");
    expect((await row(ev, lena)).status).toBe("offered"); // the seat theo had is passed on
    expect((await queryAs<{ r: string }>(db, maya, "select public.host_remove_participant($1, $2) as r", [ev, lena]))[0].r).toBe("removed");
    expect(await row(ev, lena)).toMatchObject({ status: "left", reason: "removed" });
    await expect(queryAs(db, maya, "select public.host_remove_participant($1, $2)", [ev, maya])).rejects.toThrow(/cannot remove themselves/);
  });

  it("D-M: suspended or closing waitlisted people are skipped at offer time but keep their place", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(nina, "join_event", ev);
    await rpc(lena, "join_event", ev);
    await db.query("insert into public.suspensions (user_id, reason) values ($1, 'test')", [nina]);
    await rpc(theo, "leave_event", ev);
    expect((await row(ev, nina)).status).toBe("waitlisted");
    expect((await row(ev, lena)).status).toBe("offered");
    await db.query("delete from public.suspensions where user_id = $1", [nina]);
    await rpc(lena, "decline_offer", ev);
    expect((await row(ev, nina)).status).toBe("offered"); // offered once eligible again, in order
  });

  it("capacity can't drop below going + live offers; raising it offers seats; the price locks with a waitlist", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(nina, "join_event", ev);
    await rpc(lena, "join_event", ev);
    await rpc(theo, "leave_event", ev); // nina offered: going 1 + offer 1
    await expect(queryAs(db, maya, "update public.events set capacity = 1 where id = $1", [ev])).rejects.toThrow(/going plus open offers/);
    await queryAs(db, maya, "update public.events set capacity = 3 where id = $1", [ev]);
    expect((await row(ev, lena)).status).toBe("offered");
    await db.query("insert into public.host_accounts (user_id, stripe_account_id, charges_enabled) values ($1, 'acct_test', true) on conflict (user_id) do update set charges_enabled = true", [maya]);
    await expect(queryAs(db, maya, "select public.set_event_price($1, 1500)", [ev])).rejects.toThrow(/payments:price_locked/);
  });

  it("paid events: no waitlist (ticket required), and a refund or leave never creates offers", async () => {
    const ev = await make(2);
    await db.query("update public.events set price_cents = 1500 where id = $1", [ev]);
    await expect(rpc(theo, "join_event", ev)).rejects.toThrow(/payments:ticket_required/);
    expect(await row(ev, theo)).toBeNull();
  });

  it("cancelling ends live offers and stops new joins", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(nina, "join_event", ev);
    await rpc(theo, "leave_event", ev);
    await queryAs(db, maya, "update public.events set status = 'cancelled' where id = $1", [ev]);
    expect(await row(ev, nina)).toMatchObject({ status: "declined", reason: "cancelled" });
    await expect(rpc(lena, "join_event", ev)).rejects.toThrow(/not found|not open/);
  });

  it("RLS: participants see their own row; the host sees all; another user, a moderator and anon see none; no direct writes", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev); // going
    await rpc(nina, "join_event", ev); // waitlisted
    await rpc(lena, "join_event", ev); // waitlisted
    const sel = (who: string | null) => queryAs<{ user_id: string }>(db, who, "select user_id from public.event_participants where event_id = $1", [ev]);
    expect((await sel(nina)).map((r) => r.user_id)).toEqual([nina]);
    expect((await sel(maya)).map((r) => r.user_id).sort()).toEqual([nina, lena].sort());
    expect(await sel(theo)).toEqual([]);
    expect(await sel(dev)).toEqual([]);
    expect(await sel(sam)).toEqual([]);
    expect(await sel(null)).toEqual([]);
    await expect(queryAs(db, dev, "insert into public.event_participants (event_id, user_id, status) values ($1, $2, 'interested')", [ev, dev])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, nina, "update public.event_participants set queue_position = 0 where event_id = $1", [ev])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, nina, "delete from public.event_participants where event_id = $1", [ev])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, null, "select public.join_event($1)", [ev])).rejects.toThrow(/permission denied/);
  });

  it("phase 2: API users cannot insert or delete going rows directly; a creator still attends their own new event", async () => {
    const ev = await make(10);
    await expect(queryAs(db, theo, "insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, theo])).rejects.toThrow(/row-level security/);
    await rpc(theo, "join_event", ev);
    expect(await queryAs(db, theo, "delete from public.event_attendees where event_id = $1 and user_id = $2 returning user_id", [ev, theo])).toEqual([]);
    expect(await going(ev)).toContain(theo);
    expect(await going(ev)).toContain(maya); // inserted by create_event_with_details as the caller
  });

  it("the invariant: never going and a participant at once; account deletion cascades participant rows", async () => {
    const ev = await make(2);
    await rpc(theo, "join_event", ev);
    await rpc(jules, "join_event", ev);
    await expect(db.query("insert into public.event_participants (event_id, user_id, status) values ($1, $2, 'interested')", [ev, theo])).rejects.toThrow(/Already going/);
    expect((await row(ev, jules)).status).toBe("waitlisted");
    await db.query("delete from public.profiles where id = $1", [jules]);
    expect(await row(ev, jules)).toBeNull();
  });
});

describe("demo parity, action, page and source", () => {
  let repo: DataRepository;
  let ev: string;
  beforeEach(async () => {
    ctx.repo = repo = createDemoRepository(createIsolatedStore());
    ctx.viewer = maya;
    ev = (await repo.events.create({ title: "Demo waitlist", description: "Testing the waitlist here.", locationName: "Goodale", lat: 39.97, lng: -83, startsAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString(), categorySlug: "pickup-sports", capacity: 2, tags: [] }, maya)).id;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the same script gives the same statuses as SQL", async () => {
    expect(await repo.events.join(theo, ev)).toBe("going");
    expect(await repo.events.join(nina, ev)).toBe("waitlisted");
    expect(await repo.events.join(lena, ev)).toBe("waitlisted");
    await repo.events.leave(theo, ev);
    expect((await repo.events.get(ev, nina))!.viewerParticipant).toMatchObject({ status: "offered" });
    expect(await repo.events.join(dev, ev)).toBe("waitlisted");
    expect((await repo.events.get(ev, null))!.readiness).toMatchObject({ going: 1, held: 1, spotsOpen: 0, waitlist: 2 });
    expect((await repo.notifications.list(nina)).items.filter((n) => n.type === "event_offer")).toHaveLength(1);
    await repo.events.declineOffer(nina, ev);
    expect((await repo.events.get(ev, lena))!.viewerParticipant).toMatchObject({ status: "offered" });
    expect(await repo.events.acceptOffer(lena, ev)).toBe("going");
    expect(await repo.events.acceptOffer(lena, ev)).toBe("going");
    expect((await repo.events.get(ev, lena))!.viewerJoined).toBe(true);
    expect(await repo.events.participants(maya, ev)).toEqual([expect.objectContaining({ userId: dev, status: "waitlisted" })]);
    expect(await repo.events.participants(theo, ev)).toEqual([]); // names to hosts only
    await expect(repo.events.update(ev, { ...(await base(repo, ev)), capacity: 1 }, maya)).rejects.toThrow(/attendee count|offers/);
    // Expiry: offers past their time are declined and passed on.
    await repo.events.leave(lena, ev);
    expect((await repo.events.get(ev, dev))!.viewerParticipant).toMatchObject({ status: "offered" });
    expect(await repo.events.expireOffers(new Date(Date.now() + 3 * HOUR).toISOString())).toBe(1);
    expect((await repo.events.get(ev, dev))!.viewerParticipant).toMatchObject({ status: "declined", reason: "expired" });
    expect(await repo.events.acceptOffer(dev, ev)).toBe("offer_expired");
  });

  it("the real join action: a full free event puts you on the waitlist", async () => {
    await repo.events.join(theo, ev);
    ctx.viewer = nina;
    const { toggleAttendanceAction, participationAction } = await import("../src/server/actions/events");
    expect(await toggleAttendanceAction(ev, true)).toMatchObject({ ok: true, data: { joined: false, status: "waitlisted" } });
    expect(await participationAction(ev, "leave")).toMatchObject({ ok: true, data: { status: "left" } });
    ctx.viewer = lena;
    expect(await participationAction(ev, "interest-on")).toMatchObject({ ok: true, data: { status: "interested" } });
  });

  it("the page: Join waitlist when full, Leave waitlist when waiting, Accept/Decline when offered, names for the host", async () => {
    const { default: Page } = await import("../src/app/events/[id]/page");
    const render = async () => renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: await Page({ params: Promise.resolve({ id: ev }), searchParams: Promise.resolve({}) } as never) })));
    await repo.events.join(theo, ev);
    ctx.viewer = nina;
    expect(await render()).toContain(">Join waitlist<");
    await repo.events.join(nina, ev);
    await repo.events.join(lena, ev);
    const waiting = await render();
    expect(waiting).toContain(">Leave waitlist<");
    expect(waiting).toContain("Waitlisted (2 waiting)");
    await repo.events.leave(theo, ev);
    const offered = await render();
    expect(offered).toContain(">Accept spot<");
    expect(offered).toContain(">Decline<");
    expect(offered).toMatch(/Held for you until/);
    ctx.viewer = maya;
    const host = await render();
    expect(host).toContain("Waitlist (only you see names)");
    expect(host).toContain("Lena");
    ctx.viewer = dev;
    expect(await render()).not.toContain("only you see names");
  });

  it("source check: the web repository writes no event_attendees rows directly; joins go through the RPCs", () => {
    const src = readFileSync(path.join(__dirname, "../src/lib/data/supabase/repository.ts"), "utf8");
    expect(src).not.toMatch(/from\("event_attendees"\)\s*\.(insert|delete|update|upsert)/);
    expect(src).toMatch(/rpc\("join_event"/);
    expect(src).toMatch(/rpc\("leave_event"/);
  });
});

async function base(repo: DataRepository, id: string) {
  const e = (await repo.events.get(id, null))!;
  return { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: e.tags };
}
