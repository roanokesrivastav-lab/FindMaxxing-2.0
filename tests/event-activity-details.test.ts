/**
 * Roadmap 4.2: structured activity details per kind and events.time_zone (0051). Shared validation and
 * plain-language rendering, the SQL checks and RLS on PGlite, demo parity, the form parser, the real
 * create action, and the real event page (requirements section, display in the event's own zone).
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
import { activityDetailsSchema, describeActivity, SKILL_LABELS } from "../packages/shared/src/events";
import { parseEventPilotFields } from "../src/lib/events/form";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), sam = user("sam_k"), nina = user("nina");
const soccer = stableId("event:Sunday pickup soccer");
const run3v3 = stableId("event:3v3 basketball run");

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

const RUN = { kind: "run", distance: 5, unit: "km", paceFrom: "5:00", paceTo: "6:30", regroup: "At the corner", noDrop: true, noDropNote: "A sweeper at the back" };

describe("shared schema and plain language", () => {
  it("each kind keeps only its own fields and drops empty ones", () => {
    expect(activityDetailsSchema.parse({ kind: "basketball", format: "3v3", playerLimit: "9", beginnersWelcome: true })).toEqual({ kind: "basketball", format: "3v3", playerLimit: 9, beginnersWelcome: true });
    expect(activityDetailsSchema.parse({ kind: "walk", note: "" })).toEqual({ kind: "walk" });
    expect(activityDetailsSchema.safeParse({ kind: "walk", format: "3v3" }).success).toBe(false);
    expect(activityDetailsSchema.safeParse({ kind: "chess" }).success).toBe(false);
  });
  it("skill is a plain description from a list, never a number; paces are m:ss with the faster first", () => {
    expect(activityDetailsSchema.safeParse({ kind: "pickleball", level: 3 }).success).toBe(false);
    expect(activityDetailsSchema.safeParse({ kind: "pickleball", level: "3.5" }).success).toBe(false);
    expect(activityDetailsSchema.parse({ kind: "pickleball", level: "casual" })).toEqual({ kind: "pickleball", level: "casual" });
    for (const label of Object.values(SKILL_LABELS)) expect(label).not.toMatch(/\d/);
    expect(activityDetailsSchema.safeParse({ ...RUN, paceFrom: "9" }).success).toBe(false);
    expect(activityDetailsSchema.safeParse({ ...RUN, paceFrom: "7:00", paceTo: "6:00" }).success).toBe(false);
  });
  it("describes only what the host filled in", () => {
    expect(describeActivity(RUN as never)).toEqual(["5 km run", "Pace 5:00 to 6:30 per km", "Regroup: At the corner", "No-drop: A sweeper at the back"]);
    expect(describeActivity({ kind: "run", noDrop: true })).toEqual(["No-drop: nobody gets left behind"]);
    expect(describeActivity({ kind: "pickleball", level: "new", play: "either", paddlesAvailable: true })).toEqual([`Level: ${SKILL_LABELS.new}`, "Singles or doubles", "Paddles available to borrow"]);
    expect(describeActivity({ kind: "volleyball" })).toEqual([]);
    expect(describeActivity(null)).toEqual([]);
  });
});

describe("database (PGlite, RLS)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const set = (who: string | null, col: string, v: unknown) =>
    queryAs<{ id: string }>(db, who, `update public.events set ${col} = $2 where id = $1 returning id`, [soccer, v]);

  it("every existing event is backfilled to America/New_York; seeded details are present", async () => {
    const zones = (await db.query<{ time_zone: string }>("select distinct time_zone from public.events")).rows;
    expect(zones).toEqual([{ time_zone: "America/New_York" }]);
    const seeded = (await db.query<{ activity_details: unknown }>("select activity_details from public.events where id = $1", [run3v3])).rows[0];
    expect(seeded.activity_details).toMatchObject({ kind: "basketball", playerLimit: 12 });
  });
  it("the owner sets details and zone; another user, a moderator and anon cannot", async () => {
    expect(await set(maya, "activity_details", JSON.stringify(RUN))).toHaveLength(1);
    expect(await set(maya, "time_zone", "Europe/Berlin")).toHaveLength(1);
    for (const who of [theo, sam, null]) expect(await set(who, "time_zone", "Asia/Tokyo")).toHaveLength(0);
    expect((await db.query<{ time_zone: string }>("select time_zone from public.events where id = $1", [soccer])).rows[0].time_zone).toBe("Europe/Berlin");
  });
  it("refuses unknown zones, foreign keys per kind, numeric skill and bad paces", async () => {
    await expect(set(maya, "time_zone", "Mars/Olympus")).rejects.toThrow(/Unknown time zone/);
    await expect(set(maya, "activity_details", JSON.stringify({ kind: "walk", format: "3v3" }))).rejects.toThrow(/events_activity_details_valid/);
    await expect(set(maya, "activity_details", JSON.stringify({ kind: "pickleball", level: 4 }))).rejects.toThrow(/events_activity_details_valid/);
    await expect(set(maya, "activity_details", JSON.stringify({ kind: "run", paceFrom: "fast" }))).rejects.toThrow(/events_activity_details_valid/);
    await expect(set(maya, "activity_details", JSON.stringify({ kind: "basketball", playerLimit: 2.5 }))).rejects.toThrow(/events_activity_details_valid/);
    await expect(set(maya, "activity_details", JSON.stringify({ kind: "chess" }))).rejects.toThrow(/events_activity_details_valid/);
    expect(await set(maya, "activity_details", JSON.stringify({ kind: "pickleball", level: "competitive", play: "doubles", paddlesAvailable: false }))).toHaveLength(1);
  });
});

describe("demo parity and the form parser", () => {
  it("demo refuses what SQL refuses and stores what it stores", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const e = (await repo.events.get(soccer, maya))!;
    const input = { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: e.tags };
    await expect(repo.events.update(soccer, { ...input, timeZone: "Mars/Olympus" }, maya)).rejects.toThrow(/Unknown time zone/);
    await expect(repo.events.update(soccer, { ...input, activityDetails: { kind: "pickleball", level: 4 } as never }, maya)).rejects.toThrow(/Invalid activity/);
    await repo.events.update(soccer, { ...input, activityDetails: RUN as never, timeZone: "Europe/Berlin" }, maya);
    const after = (await repo.events.get(soccer, null))!;
    expect(after.activityDetails).toEqual(RUN);
    expect(after.timeZone).toBe("Europe/Berlin");
    expect((await repo.events.get(run3v3, null))!.activityDetails).toMatchObject({ kind: "basketball", playerLimit: 12 });
    expect((await repo.events.get(run3v3, null))!.timeZone).toBe("America/New_York");
  });
  it("parses only the chosen kind's inputs, keys errors by input name, and 'None' clears", () => {
    const read = (o: Record<string, string>) => (k: string) => o[k] ?? "";
    expect(parseEventPilotFields(read({ activityKind: "pickleball", pbLevel: "new", pbPaddles: "on", runDistance: "5" }))).toMatchObject({ ok: true, data: { activityDetails: { kind: "pickleball", level: "new", paddlesAvailable: true } } });
    expect(parseEventPilotFields(read({ activityKind: "run", runPaceFrom: "nine" }))).toMatchObject({ ok: false, errors: { runPaceFrom: expect.any(String) } });
    expect(parseEventPilotFields(read({ activityKind: "" }))).toMatchObject({ ok: true, data: { activityDetails: null } });
    expect(parseEventPilotFields(read({ timeZone: "Nowhere/Land" }))).toMatchObject({ ok: false, errors: { timeZone: "Unknown time zone" } });
  });
});

describe("real create action and page", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = maya; });
  afterEach(() => vi.unstubAllEnvs());
  const render = async (id: string) => {
    const { default: Page } = await import("../src/app/events/[id]/page");
    const el = await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never);
    return renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: el })));
  };

  it("create stores the details and the host's zone; the page lists them under Requirements and shows the event's zone", async () => {
    const { createEventAction } = await import("../src/server/actions/events");
    const f = new FormData();
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries({ title: "Berlin pickleball", description: "Friendly doubles on the river courts.", locationName: "River courts", city: "Berlin", lat: "52.5", lng: "13.4", date: day, startTime: "18:00", categorySlug: "pickup-sports", tzOffsetMinutes: "-60", activityKind: "pickleball", pbLevel: "casual", pbPlay: "doubles", timeZone: "Europe/Berlin" })) f.set(k, v);
    const err = await createEventAction(null, f).catch((e: Error) => e);
    const id = /\/events\/([0-9a-f-]+)/.exec(String((err as Error).message))![1];
    const ev = (await ctx.repo.events.get(id, null))!;
    expect(ev.activityDetails).toEqual({ kind: "pickleball", level: "casual", play: "doubles" });
    expect(ev.timeZone).toBe("Europe/Berlin");
    ctx.viewer = nina;
    const html = await render(id);
    expect(html).toContain(">Requirements<");
    expect(html).toContain(`Level: ${SKILL_LABELS.casual}`);
    expect(html).toContain("Doubles");
    // 18:00 in Berlin, labelled in Berlin's zone, not New York's.
    expect(html).toMatch(/6:00 PM (GMT\+1|CET)/);
  });

  it("no details: no Requirements section", async () => {
    ctx.viewer = nina;
    expect(await render(soccer)).not.toContain(">Requirements<");
    expect(await render(run3v3)).toContain("Format: Half-court 3s, games to 15");
  });
});
