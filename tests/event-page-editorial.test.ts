/**
 * Roadmap 4.1: the event page in the Local editorial treatment (pilotEvents), the "Your first time?"
 * newcomer fields (0050_event_newcomer.sql) and the "free to join" copy fix. Database rules and RLS on
 * PGlite (anon, owner, another user, moderator), demo parity, the real create/update actions, and the
 * real page rendered on the demo repository with the flag on and off.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { eventNewcomerSchema } from "../packages/shared/src/events";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), sam = user("sam_k"); // sam_k is a moderator
const soccer = stableId("event:Sunday pickup soccer"); // maya_r's, future
const opener = stableId("event:Season opener watch party"); // theo's, past

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

const NEWCOMER = { meetingSpot: "North goal, orange cones", welcomer: "Maya (blue cap)", bring: "Water and a dark shirt", soloWelcome: true };

describe("newcomer shape (shared schema)", () => {
  it("trims, drops empty fields, null when nothing is set, and refuses unknown keys or long text", () => {
    expect(eventNewcomerSchema.parse({ meetingSpot: "  Gate 2 ", welcomer: "", bring: null, soloWelcome: false })).toEqual({ meetingSpot: "Gate 2" });
    expect(eventNewcomerSchema.parse({})).toBeNull();
    expect(eventNewcomerSchema.safeParse({ meetingSpot: "x".repeat(141) }).success).toBe(false);
    expect(eventNewcomerSchema.safeParse({ extra: "no" }).success).toBe(false);
  });
});

describe("events.newcomer in the database (PGlite, RLS)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const set = (who: string | null, id: string, v: unknown) =>
    queryAs<{ id: string }>(db, who, "update public.events set newcomer = $2::jsonb where id = $1 returning id", [id, v === null ? null : JSON.stringify(v)]);

  it("the owner sets it on their own future event, through the column grant", async () => {
    expect(await set(maya, soccer, NEWCOMER)).toHaveLength(1);
    expect((await db.query<{ newcomer: unknown }>("select newcomer from public.events where id = $1", [soccer])).rows[0].newcomer).toEqual(NEWCOMER);
  });
  it("another user, a moderator and anon cannot change it; everyone who can see the event can read it", async () => {
    expect(await set(theo, soccer, { bring: "hijack" })).toHaveLength(0);
    expect(await set(sam, soccer, { bring: "hijack" })).toHaveLength(0);
    expect(await set(null, soccer, { bring: "hijack" })).toHaveLength(0);
    const read = await queryAs<{ newcomer: { bring: string } }>(db, null, "select newcomer from public.events where id = $1", [soccer]);
    expect(read[0].newcomer.bring).toBe(NEWCOMER.bring);
  });
  it("the owner guard still applies: no edits to a past event", async () => {
    // RLS (future events only) or the guard refuses; either way nothing changes.
    const tried = await set(theo, opener, NEWCOMER).catch((e: Error) => e);
    expect(tried instanceof Error ? tried.message : tried).toEqual(expect.anything());
    if (!(tried instanceof Error)) expect(tried).toHaveLength(0);
    expect((await db.query<{ newcomer: unknown }>("select newcomer from public.events where id = $1", [opener])).rows[0].newcomer).toBeNull();
  });
  it("the check constraint refuses unknown keys, wrong types and long text", async () => {
    await expect(set(maya, soccer, { extra: "x" })).rejects.toThrow(/events_newcomer_valid/);
    await expect(set(maya, soccer, { soloWelcome: "yes" })).rejects.toThrow(/events_newcomer_valid/);
    await expect(set(maya, soccer, { bring: "x".repeat(201) })).rejects.toThrow(/events_newcomer_valid/);
    await expect(set(maya, soccer, ["not", "an", "object"])).rejects.toThrow(/events_newcomer_valid/);
    expect(await set(maya, soccer, null)).toHaveLength(1);
  });
});

describe("demo repository parity", () => {
  let repo: DataRepository;
  beforeEach(() => { repo = createDemoRepository(createIsolatedStore()); });
  const base = async () => {
    const e = await repo.events.get(soccer, maya);
    return { title: e!.title, description: e!.description, placeId: e!.placeId, locationName: e!.locationName, address: e!.address, lat: e!.lat, lng: e!.lng, startsAt: e!.startsAt, endsAt: e!.endsAt, categorySlug: e!.categorySlug, capacity: e!.capacity, tags: e!.tags };
  };
  it("update stores it, undefined leaves it, null clears it, and a bad shape is refused", async () => {
    await repo.events.update(soccer, { ...(await base()), newcomer: NEWCOMER }, maya);
    expect((await repo.events.get(soccer, null))!.newcomer).toEqual(NEWCOMER);
    await repo.events.update(soccer, await base(), maya);
    expect((await repo.events.get(soccer, null))!.newcomer).toEqual(NEWCOMER);
    await repo.events.update(soccer, { ...(await base()), newcomer: null }, maya);
    expect((await repo.events.get(soccer, null))!.newcomer).toBeNull();
    await expect(repo.events.update(soccer, { ...(await base()), newcomer: { bring: "x".repeat(201) } }, maya)).rejects.toThrow(/Invalid newcomer/);
    await expect(repo.events.update(soccer, { ...(await base()), newcomer: NEWCOMER }, theo)).rejects.toThrow(/permission/);
  });
});

describe("create and edit actions (real code path, demo repository)", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = maya; });
  afterEach(() => vi.unstubAllEnvs());
  const form = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries({ title: "Newcomer friendly run", description: "Easy loop with a regroup at the end.", locationName: "Goodale Park", city: "Columbus", lat: "39.97", lng: "-83.0", date: tomorrow, startTime: "18:00", categorySlug: "fitness", tzOffsetMinutes: "300", ...extra })) f.set(k, v);
    return f;
  };
  it("pilotEvents on: the newcomer fields are saved", async () => {
    const { createEventAction } = await import("../src/server/actions/events");
    const err = await createEventAction(null, form({ newcomerMeetingSpot: "By the fountain", newcomerSolo: "on" })).catch((e: Error) => e);
    const id = /\/events\/([0-9a-f-]+)/.exec(String((err as Error).message))?.[1];
    expect(id).toBeTruthy();
    expect((await ctx.repo.events.get(id!, null))!.newcomer).toEqual({ meetingSpot: "By the fountain", soloWelcome: true });
  });
  it("pilotEvents on: an over-long field comes back as a field error and nothing is created", async () => {
    const { createEventAction } = await import("../src/server/actions/events");
    const res = await createEventAction(null, form({ newcomerBring: "x".repeat(201) }));
    expect(res).toMatchObject({ ok: false, fieldErrors: { newcomerBring: expect.stringMatching(/under 200/) } });
  });
  it("pilotEvents off: the fields are ignored exactly as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    const { createEventAction } = await import("../src/server/actions/events");
    const err = await createEventAction(null, form({ newcomerMeetingSpot: "By the fountain", newcomerBring: "x".repeat(500) })).catch((e: Error) => e);
    const id = /\/events\/([0-9a-f-]+)/.exec(String((err as Error).message))?.[1];
    expect((await ctx.repo.events.get(id!, null))!.newcomer).toBeNull();
  });
});

describe("/events/[id] page", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = user("nina"); });
  afterEach(() => vi.unstubAllEnvs());
  const render = async (id: string) => {
    const { default: Page } = await import("../src/app/events/[id]/page");
    const el = await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never);
    return renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: el })));
  };

  it("pilotEvents on: editorial order — what, when (plain text + zone), where, host, cost, then the action", async () => {
    const html = await render(soccer);
    expect(html).toContain("treatment-editorial");
    const order = ["<h1", ">When<", ">Meeting point<", ">Host<", ">Cost and spots<", "Join event"].map((s) => html.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/(EST|EDT)/);
    // No calendar date block, and no first-time block when the host entered nothing.
    expect(html).not.toContain("Your first time?");
    expect(html).toContain(">Free<");
  });

  it("shows 'Your first time?' from the host's fields", async () => {
    const e = (await ctx.repo.events.get(soccer, maya))!;
    await ctx.repo.events.update(soccer, { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: e.tags, newcomer: NEWCOMER }, maya);
    const html = await render(soccer);
    expect(html).toContain("Your first time?");
    expect(html).toContain("North goal, orange cones");
    expect(html).toContain("Maya (blue cap)");
    expect(html).toContain("Coming alone is normal here.");
  });

  it("a paid event never says 'Free' or 'Free to join' (flag on and off)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilot,payments");
    const created = await ctx.repo.events.create({ title: "Paid clinic", description: "A coached clinic with drills.", locationName: "Goodale Park", lat: 39.97, lng: -83, startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), categorySlug: "fitness", capacity: 10, tags: [] }, maya);
    await ctx.repo.payments.setEventPrice(maya, created.id, 1500);
    ctx.viewer = user("nina");
    const on = await render(created.id);
    expect(on).toContain("$15.00 per ticket");
    expect(on).not.toMatch(/Free to join|>Free</);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "payments");
    const off = await render(created.id);
    expect(off).not.toContain("Free to join");
    expect(off).toContain("Get a ticket to join.");
  });

  it("pilotEvents off: today's page (hero band and 'Details' section)", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    const html = await render(soccer);
    expect(html).not.toContain("treatment-editorial");
    expect(html).toContain(">Details<");
    expect(html).toContain("Free to join. Just show up.");
  });
});
