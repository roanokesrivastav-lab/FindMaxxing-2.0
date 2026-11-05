/**
 * Roadmap 4.8: the host-toggled Party poster (0053 events.card_style). Default off; only the host can
 * turn it on; Full and Cancelled stay visible; works with no photo and long titles; demo parity.
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
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { EventCard } from "../src/components/events/EventCard";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const maya = user("maya_r"), theo = user("theo"), sam = user("sam_k");
const soccer = stableId("event:Sunday pickup soccer");
const show = stableId("event:Basement show: three local bands");

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: maya, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); }, notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

describe("database (PGlite, RLS)", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  const set = (who: string | null, v: string) => queryAs<{ id: string }>(db, who, "update public.events set card_style = $2 where id = $1 returning id", [soccer, v]);
  it("default off: every event without a host choice is the Readiness row; the seeded show is a poster", async () => {
    const rows = (await db.query<{ card_style: string; n: number }>("select card_style, count(*)::int as n from public.events group by 1 order by 1")).rows;
    expect(rows).toEqual([{ card_style: "party_poster", n: 1 }, { card_style: "readiness", n: rows.find((r) => r.card_style === "readiness")!.n }]);
    expect((await db.query<{ card_style: string }>("select card_style from public.events where id = $1", [show])).rows[0].card_style).toBe("party_poster");
  });
  it("only the host can toggle it: another user, a moderator and anon change nothing", async () => {
    for (const who of [theo, sam, null]) expect(await set(who, "party_poster")).toHaveLength(0);
    expect(await set(maya, "party_poster")).toHaveLength(1);
    expect(await set(maya, "readiness")).toHaveLength(1);
    await expect(set(maya, "calendar_block")).rejects.toThrow(/events_card_style_valid/);
  });
});

describe("demo parity and the real actions", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = maya; });
  afterEach(() => vi.unstubAllEnvs());
  const form = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries({ title: "Rooftop party", description: "Music, snacks, and a view of the skyline.", locationName: "Rooftop", city: "Columbus", lat: "39.97", lng: "-83.0", date: day, startTime: "21:00", categorySlug: "music", tzOffsetMinutes: "300", ...extra })) f.set(k, v);
    return f;
  };
  const created = async (f: FormData) => {
    const { createEventAction } = await import("../src/server/actions/events");
    const err = await createEventAction(null, f).catch((e: Error) => e);
    return (await ctx.repo.events.get(/\/events\/([0-9a-f-]+)/.exec(String((err as Error).message))![1], null))!;
  };
  it("default off; the toggle turns it on; flag off ignores it", async () => {
    expect((await created(form())).cardStyle).toBe("readiness");
    expect((await created(form({ partyPoster: "on" }))).cardStyle).toBe("party_poster");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect((await created(form({ partyPoster: "on" }))).cardStyle).toBe("readiness");
  });
  it("demo: a non-host cannot change it; a bad value is refused", async () => {
    const e = (await ctx.repo.events.get(soccer, maya))!;
    const input = { title: e.title, description: e.description, placeId: e.placeId, locationName: e.locationName, address: e.address, lat: e.lat, lng: e.lng, startsAt: e.startsAt, endsAt: e.endsAt, categorySlug: e.categorySlug, capacity: e.capacity, tags: e.tags };
    await expect(ctx.repo.events.update(soccer, { ...input, cardStyle: "party_poster" }, theo)).rejects.toThrow(/permission/);
    await expect(ctx.repo.events.update(soccer, { ...input, cardStyle: "neon" as never }, maya)).rejects.toThrow(/Invalid card style/);
    expect((await ctx.repo.events.get(soccer, null))!.cardStyle).toBe("readiness");
    expect((await ctx.repo.events.get(show, user("jules")))!.cardStyle).toBe("party_poster");
  });
});

describe("the poster card", () => {
  const render = (e: Event) => renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(EventCard, { event: e }) }));
  it("renders as a poster with no photo and a long title; Full, Cancelled and price stay visible", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const e = (await repo.events.get(show, user("jules")))!;
    const html = render({ ...e, title: "A very long title ".repeat(10) });
    expect(html).toContain('data-card="party-poster"');
    expect(html).toContain("type-page-title");
    expect(html).toContain("line-clamp-4");
    expect(html).not.toContain("<img");
    expect(html).toContain("3 going");
    expect(render({ ...e, readiness: { ...e.readiness!, spotsOpen: 0 } })).toMatch(/data-status="warning"[\s\S]*Full/);
    expect(render({ ...e, status: "cancelled" })).toMatch(/data-status="negative"[\s\S]*Cancelled/);
    expect(render({ ...e, priceCents: 1000 })).toContain("$10.00");
  });
  it("a non-poster event keeps the Readiness card; without pilotEvents (no readiness) the legacy card", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const e = (await repo.events.get(soccer, null))!;
    expect(render(e)).toContain('data-card="readiness"');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { readiness: _readiness, ...legacy } = (await repo.events.get(show, user("jules")))!;
    expect(render(legacy as Event)).not.toContain("party-poster");
  });
});
