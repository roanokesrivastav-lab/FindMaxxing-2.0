/**
 * Roadmap 4.3: minimum attendance and the Readiness row (0052). Row text vectors (nothing false when a
 * field is missing), SQL event_readiness() vs the TS mirror, constraints and RLS (anon, owner, another
 * user, moderator), confirm_session, and decide_sessions on a frozen clock (just before, at, after the
 * deadline; host confirm; dedupe; refunds), plus demo parity and the rendered card/page.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import type { Event } from "../src/lib/data/types";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { computeReadiness, readinessParts } from "../src/lib/events/readiness";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";
import { EventCard } from "../src/components/events/EventCard";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), sam = user("sam_k"), nina = user("nina"), lena = user("lena"), dev = user("dev"), jules = user("jules");
const hanaRun = stableId("event:Thursday pickup basketball");

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

const NY = "America/New_York";
const NOW = Date.parse("2026-11-07T15:00:00Z"); // Saturday 10:00 in New York
const text = (r: Parameters<typeof readinessParts>[0], cancelled = false) => readinessParts(r, NY, NOW, cancelled).map((p) => p.text).join(" · ");
const base = { going: 8, held: 0, capacity: 12, minAttendance: 10, decisionDeadline: "2026-11-07T21:00:00Z", decision: "open" as const, venueStatus: "confirmed" as const };

describe("the Readiness row text", () => {
  it("reads like the ticket: '8 going · 4 spots open · 2 more needed · host confirms by 4 p.m.'", () => {
    expect(text(computeReadiness(base))).toBe("8 going · 4 spots open · 2 more needed · host confirms by 4 p.m.");
  });
  it("says nothing about a field that is not set (never zero, never invented)", () => {
    expect(text(computeReadiness({ ...base, capacity: null }))).toBe("8 going · 2 more needed · host confirms by 4 p.m.");
    expect(text(computeReadiness({ ...base, minAttendance: null }))).toBe("8 going · 4 spots open · host confirms by 4 p.m.");
    expect(text(computeReadiness({ ...base, decisionDeadline: null }))).toBe("8 going · 4 spots open · 2 more needed");
    expect(text(computeReadiness({ ...base, capacity: null, minAttendance: null, decisionDeadline: null }))).toBe("8 going");
  });
  it("held seats are not open; met, confirmed, not happening, waitlist, venue and cancelled states", () => {
    expect(text(computeReadiness({ ...base, held: 4 }))).toBe("8 going · Full · 2 more needed · host confirms by 4 p.m.");
    expect(text(computeReadiness({ ...base, going: 10 }))).toBe("10 going · 2 spots open · Minimum met · host confirms by 4 p.m.");
    expect(text(computeReadiness({ ...base, decision: "happening" }))).toBe("8 going · 4 spots open · Confirmed");
    expect(text(computeReadiness({ ...base, decision: "not_happening" }))).toBe("8 going · 4 spots open · Not happening");
    expect(text(computeReadiness({ ...base, waitlist: 3, venueStatus: "unconfirmed" }))).toContain("3 on the waitlist · Venue not confirmed yet");
    expect(text(computeReadiness(base), true)).toBe("8 going");
  });
  it("the deadline is in the event's zone, with the day when it is not today", () => {
    expect(readinessParts(computeReadiness({ ...base, decisionDeadline: "2026-11-08T21:30:00Z" }), NY, NOW).at(-1)!.text).toBe("host confirms by tomorrow 4:30 p.m.");
    expect(readinessParts(computeReadiness({ ...base, decisionDeadline: "2026-11-10T14:00:00Z" }), NY, NOW).at(-1)!.text).toBe("host confirms by Tue 9 a.m.");
    expect(readinessParts(computeReadiness(base), "Europe/Berlin", NOW).at(-1)!.text).toBe("host confirms by 10 p.m.");
  });
});

describe("database (PGlite)", () => {
  let db: PGlite;
  let ev: string;
  const day = 86_400_000;
  const make = async (over: { capacity?: number; min?: number | null; deadlineIn?: number } = {}) => {
    const starts = new Date(Date.now() + 3 * day).toISOString();
    const [{ id }] = await queryAs<{ id: string }>(db, maya, "select public.create_event_with_details('Readiness test', 'Testing the readiness row here.', null, 'Goodale', null, 39.97, -83, $1, null, 'pickup-sports', $2, '{}') as id", [starts, over.capacity ?? 12]);
    await queryAs(db, maya, "update public.events set min_attendance = $2, decision_deadline = $3 where id = $1", [id, over.min === undefined ? 4 : over.min, new Date(Date.now() + (over.deadlineIn ?? day)).toISOString()]);
    return id;
  };
  const row = async (id: string) => (await db.query<{ status: string; decision: string; cancel_reason: string | null }>("select status, decision, cancel_reason from public.events where id = $1", [id])).rows[0];
  const join = (id: string, ...users: string[]) => Promise.all(users.map((u) => db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [id, u])));
  beforeAll(async () => { db = await createSeededDb(); ev = await make(); });

  it("constraints: 2 <= min <= capacity, deadline on or before the start; only the owner sets the rules", async () => {
    await expect(queryAs(db, maya, "update public.events set min_attendance = 1 where id = $1", [ev])).rejects.toThrow(/events_min_attendance_valid/);
    await expect(queryAs(db, maya, "update public.events set min_attendance = 13 where id = $1", [ev])).rejects.toThrow(/events_min_attendance_valid/);
    await expect(queryAs(db, maya, "update public.events set decision_deadline = starts_at + interval '1 minute' where id = $1", [ev])).rejects.toThrow(/events_decision_deadline_valid/);
    await expect(queryAs(db, maya, "update public.events set venue_status = 'maybe' where id = $1", [ev])).rejects.toThrow(/events_venue_status_valid/);
    for (const who of [theo, sam, null]) expect(await queryAs(db, who, "update public.events set min_attendance = 2 where id = $1 returning id", [ev])).toHaveLength(0);
    // decision and cancel_reason have no grant at all: only the RPCs write them.
    await expect(queryAs(db, maya, "update public.events set decision = 'happening' where id = $1", [ev])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, maya, "update public.events set cancel_reason = 'host' where id = $1", [ev])).rejects.toThrow(/permission denied/);
  });

  it("event_readiness matches the TS mirror, counts live paid holds as held, and is null for an event you can't see", async () => {
    await join(ev, theo, nina);
    await db.query("insert into public.tickets (event_id, user_id, status, amount_cents, expires_at) values ($1, $2, 'pending', 500, now() + interval '20 minutes'), ($1, $3, 'pending', 500, now() - interval '1 minute')", [ev, lena, dev]);
    const [{ r }] = await queryAs<{ r: Record<string, unknown> }>(db, null, "select public.event_readiness($1::uuid) as r", [ev]);
    const deadline = (await db.query<{ d: string }>("select to_json(decision_deadline)#>>'{}' as d from public.events where id = $1", [ev])).rows[0].d;
    expect(r).toEqual({ ...computeReadiness({ going: 3, held: 1, capacity: 12, minAttendance: 4, decisionDeadline: deadline, decision: "open", venueStatus: "confirmed" }) });
    await db.query("delete from public.tickets where event_id = $1", [ev]);
    await db.exec("set session_replication_role = replica");
    await db.query("update public.events set status = 'hidden' where id = $1", [ev]);
    await db.exec("set session_replication_role = origin");
    expect((await queryAs<{ r: unknown }>(db, nina, "select public.event_readiness($1::uuid) as r", [ev]))[0].r).toBeNull();
    await db.exec("set session_replication_role = replica");
    await db.query("update public.events set status = 'published' where id = $1", [ev]);
    await db.exec("set session_replication_role = origin");
  });

  it("confirm_session: the owner only, before the deadline; another user, a moderator and anon are refused", async () => {
    await expect(queryAs(db, theo, "select public.confirm_session($1)", [ev])).rejects.toThrow(/do not own/);
    await expect(queryAs(db, sam, "select public.confirm_session($1)", [ev])).rejects.toThrow(/do not own/);
    await expect(queryAs(db, null, "select public.confirm_session($1)", [ev])).rejects.toThrow(/permission denied/);
    const late = await make({ deadlineIn: -60_000 + 0 });
    await expect(queryAs(db, maya, "select public.confirm_session($1)", [late])).rejects.toThrow(/deadline has passed/);
    expect((await queryAs<{ s: string }>(db, maya, "select public.confirm_session($1) as s", [ev]))[0].s).toBe("happening");
    expect((await row(ev)).decision).toBe("happening");
  });

  it("decide_sessions is service-only", async () => {
    await expect(queryAs(db, maya, "select public.decide_sessions()")).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, null, "select public.decide_sessions()")).rejects.toThrow(/permission denied/);
  });

  it("frozen clock: before the deadline nothing; at it, below minimum → not happening, attendees told once, paid tickets refunded", async () => {
    const id = await make({ min: 4 });
    await join(id, theo); // maya (creator) + theo = 2 < 4
    await db.query("insert into public.tickets (event_id, user_id, status, amount_cents, expires_at, paid_at) values ($1, $2, 'paid', 500, now(), now())", [id, theo]);
    const deadline = (await db.query<{ d: Date }>("select decision_deadline as d from public.events where id = $1", [id])).rows[0].d;
    const at = (ms: number) => new Date(deadline.getTime() + ms).toISOString();
    await db.query("select public.decide_sessions($1)", [at(-1)]);
    expect(await row(id)).toEqual({ status: "published", decision: "open", cancel_reason: null });
    expect((await db.query<{ n: number }>("select public.decide_sessions($1) as n", [at(0)])).rows[0].n).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toEqual({ status: "cancelled", decision: "not_happening", cancel_reason: "below_minimum" });
    // Run again: nothing changes, nobody is told twice. The creator is told too (not the actor: there is none).
    await db.query("select public.decide_sessions($1)", [at(60_000)]);
    const notes = (await db.query<{ user_id: string; type: string; detail: string }>("select user_id, type, detail from public.notifications where subject_id = $1 order by user_id", [id])).rows;
    expect(notes.map((n) => n.user_id).sort()).toEqual([maya, theo].sort());
    expect(new Set(notes.map((n) => `${n.type}|${n.detail}`))).toEqual(new Set(["event_cancelled|Not enough people signed up"]));
    expect((await db.query<{ status: string }>("select status from public.tickets where event_id = $1", [id])).rows[0].status).toBe("refund_pending");
  });

  it("at or above minimum → happening; a host-confirmed session is untouched; no minimum → happening", async () => {
    const enough = await make({ min: 3 });
    await join(enough, theo, jules);
    const confirmed = await make({ min: 6 });
    await queryAs(db, maya, "select public.confirm_session($1)", [confirmed]);
    const noMin = await make({ min: null });
    const later = new Date(Date.now() + 2 * day).toISOString();
    await db.query("select public.decide_sessions($1)", [later]);
    expect((await row(enough)).decision).toBe("happening");
    expect(await row(confirmed)).toEqual({ status: "published", decision: "happening", cancel_reason: null });
    expect((await row(noMin)).decision).toBe("happening");
  });
});

describe("demo parity, card and page", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = nina; });
  afterEach(() => vi.unstubAllEnvs());

  it("demo: readiness numbers, rule checks, confirm and decide like SQL", async () => {
    const repo = ctx.repo;
    const e = (await repo.events.get(hanaRun, null))!;
    expect(e.readiness).toMatchObject({ going: 2, capacity: 10, spotsOpen: 8, minAttendance: 8, moreNeeded: 6, decision: "open" });
    const input = { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: e.tags };
    const hana = e.creatorId!;
    await expect(repo.events.update(hanaRun, { ...input, minAttendance: 11 }, hana)).rejects.toThrow(/no more than capacity/);
    await expect(repo.events.update(hanaRun, { ...input, decisionDeadline: new Date(Date.parse(e.startsAt) + 60_000).toISOString() }, hana)).rejects.toThrow(/on or before the start/);
    expect((await repo.events.get(hanaRun, null))!.minAttendance).toBe(8); // nothing changed by the refused update
    await expect(repo.events.confirmSession(nina, hanaRun)).rejects.toThrow(/do not own/);
    // At the deadline, 2 < 8: not happening, both attendees told once.
    expect(await repo.events.decideSessions(e.decisionDeadline!)).toBe(1);
    expect(await repo.events.decideSessions(e.decisionDeadline!)).toBe(0);
    const after = (await repo.events.get(hanaRun, hana))!;
    expect(after).toMatchObject({ status: "cancelled", decision: "not_happening", cancelReason: "below_minimum" });
    const pat = user("pat_participant");
    const notes = (await repo.notifications.list(pat)).items.filter((n) => n.subjectId === hanaRun);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "event_cancelled", detail: "Not enough people signed up" });
  });

  it("demo: the host confirm blocks the auto-cancel", async () => {
    const e = (await ctx.repo.events.get(hanaRun, null))!;
    await ctx.repo.events.confirmSession(e.creatorId!, hanaRun);
    expect(await ctx.repo.events.decideSessions(e.decisionDeadline!)).toBe(0);
    expect((await ctx.repo.events.get(hanaRun, null))!.decision).toBe("happening");
  });

  it("the notifications cron job decides due sessions (real job, demo repository); off without pilotEvents", async () => {
    const { runNotificationJobs } = await import("../src/server/notifications/push");
    const e = (await ctx.repo.events.get(hanaRun, null))!;
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect(await runNotificationJobs(ctx.repo, null, e.decisionDeadline!)).not.toHaveProperty("notHappening");
    expect((await ctx.repo.events.get(hanaRun, null))!.status).toBe("published");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilot");
    expect(await runNotificationJobs(ctx.repo, null, e.decisionDeadline!)).toMatchObject({ notHappening: 1 });
    expect((await ctx.repo.events.get(hanaRun, e.creatorId))!.status).toBe("cancelled");
  });

  it("pilotEvents off: events carry no readiness, so every card stays today's card", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect((await ctx.repo.events.get(hanaRun, null))!.readiness).toBeUndefined();
  });

  it("the card is the Readiness row (no date block) and keeps price, Full and Cancelled visible", async () => {
    const e = (await ctx.repo.events.get(hanaRun, null))! as Event;
    const render = (ev: Event) => renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: NY, now: Date.now() }, children: h(EventCard, { event: ev }) }));
    const html = render(e);
    expect(html).toContain('data-card="readiness"');
    expect(html).toContain("2 going");
    expect(html).toContain("6 more needed");
    expect(html).toMatch(/host confirms by/);
    expect(html).not.toMatch(/bg-pulse-50/); // the old calendar date tile
    expect(render({ ...e, priceCents: 900 })).toContain("$9.00");
    expect(render({ ...e, readiness: { ...e.readiness!, spotsOpen: 0 } })).toMatch(/data-status="warning"[^>]*>.*Full/);
    expect(render({ ...e, status: "cancelled" })).toMatch(/data-status="negative"[^>]*>.*Cancelled/);
  });

  it("the event page shows the Readiness row; the host gets 'Confirm it's happening'", async () => {
    const { default: Page } = await import("../src/app/events/[id]/page");
    const render = async () => renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: NY, now: Date.now() }, children: await Page({ params: Promise.resolve({ id: hanaRun }), searchParams: Promise.resolve({}) } as never) })));
    const asNina = await render();
    expect(asNina).toContain("data-readiness");
    expect(asNina).not.toContain("Confirm it&#x27;s happening");
    ctx.viewer = user("hana_host");
    expect(await render()).toContain("Confirm it&#x27;s happening");
  });
});
