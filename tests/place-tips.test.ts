/**
 * Roadmap 2.6: tip provenance and freshness (0060_place_tips.sql). The database
 * tests run as anon, the author, another user and a moderator, the way PostgREST
 * would; the demo tests hold the demo twin to the same rules; a parity test compares
 * the seeded state; the server actions and the place page are exercised for real.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { DataError } from "../src/lib/data/types";
import type { DataRepository } from "../src/lib/data/repository";
import { RATE_LIMITS } from "../src/lib/rateLimits";
import { isCurrentTip, normalizeTipInput, recentObservation, timeAgo, type PlaceTip } from "../src/lib/places/tips";
import { ToastProvider } from "../src/components/ui/Toast";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";

const ctx = vi.hoisted(() => ({ repo: null as unknown as DataRepository, viewer: null as { id: string } | null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));
vi.mock("@/components/map/MiniMap", () => ({ MiniMap: () => null }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const place = (name: string) => stableId(`place:${name}`);
const theo = user("theo"); // wrote the Cannon & Crown tip
const maya = user("maya_r"); // confirmed it in the seed
const nina = user("nina"); // not a Columbus local
const mod = user("mo_moderator");
const cannon = place("Cannon & Crown");
const basement = place("Fourth Street Basement"); // locals-only
const DAY = 86_400_000;

describe("tip rules (pure)", () => {
  it("needs an end date for temporary conditions only, in the future, within 90 days", () => {
    expect(normalizeTipInput({ body: " Cash only ", kind: "practical", expiresAt: "2030-01-01" })).toEqual({ body: "Cash only", kind: "practical", expiresAt: null });
    expect(() => normalizeTipInput({ body: "Patio closed", kind: "temporary" })).toThrow(/end date/);
    expect(() => normalizeTipInput({ body: "x", kind: "temporary", expiresAt: new Date(Date.now() - DAY).toISOString() })).toThrow(/future/);
    expect(() => normalizeTipInput({ body: "x", kind: "temporary", expiresAt: new Date(Date.now() + 120 * DAY).toISOString() })).toThrow(/90 days/);
    expect(() => normalizeTipInput({ body: "", kind: "story" })).toThrow(DataError);
    expect(() => normalizeTipInput({ body: "x".repeat(281), kind: "story" })).toThrow(/280/);
  });

  it("an observation is a current tip confirmed recently by someone else; unconfirmed or expired tips are not", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const base: PlaceTip = { id: "a", placeId: "p", body: "b", kind: "practical", expiresAt: null, status: "published", author: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", lastConfirmedAt: null, lastConfirmedBy: null };
    const confirmed = { ...base, id: "b", lastConfirmedAt: "2026-10-20T00:00:00Z" };
    const old = { ...base, id: "c", lastConfirmedAt: "2025-01-01T00:00:00Z" };
    const expired = { ...base, id: "d", kind: "temporary" as const, expiresAt: "2026-11-01T00:00:00Z", lastConfirmedAt: "2026-11-04T00:00:00Z" };
    expect(recentObservation([base, old, expired], now)).toBeNull();
    expect(recentObservation([base, confirmed, old, expired], now)?.id).toBe("b");
    expect(isCurrentTip(expired, now)).toBe(false);
    expect(timeAgo("2026-10-22T12:00:00Z", now)).toBe("2 weeks ago");
    expect(timeAgo("2026-11-05T08:00:00Z", now)).toBe("today");
  });
});

describe("tips in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const tipOf = async (placeId: string) => (await db.query<{ id: string }>("select id from public.place_tips where place_id = $1 order by created_at limit 1", [placeId])).rows[0].id;
  const addTip = async (author: string, placeId: string, body: string, kind = "practical", expires: string | null = null) =>
    (await as<{ id: string }>(author, "insert into public.place_tips (place_id, author_id, body, kind, expires_at) values ($1, $2, $3, $4, $5) returning id", [placeId, author, body, kind, expires]))[0].id;

  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("copies every existing local tip as an unconfirmed practical tip by the place's creator, then applies seeded confirmations", async () => {
    const { rows } = await db.query<{ n: number; tips: number }>(
      "select (select count(*)::int from public.places where local_tip is not null and btrim(local_tip) <> '') as n, (select count(*)::int from public.place_tips) as tips",
    );
    expect(rows[0].tips).toBe(rows[0].n);
    const tip = (await db.query<{ author_id: string; kind: string; last_confirmed_by: string | null }>("select author_id, kind, last_confirmed_by from public.place_tips where place_id = $1", [cannon])).rows[0];
    expect(tip).toEqual({ author_id: theo, kind: "practical", last_confirmed_by: maya });
  });

  it("anon reads published tips of a public place but not of a locals-only place; a non-local neither", async () => {
    expect(await as(null, "select id from public.place_tips where place_id = $1", [cannon])).toHaveLength(1);
    const locals = await db.query("select id from public.place_tips where place_id = $1", [basement]);
    expect(locals.rows.length).toBeGreaterThan(0);
    expect(await as(null, "select id from public.place_tips where place_id = $1", [basement])).toHaveLength(0);
    expect(await as(nina, "select id from public.place_tips where place_id = $1", [basement])).toHaveLength(0);
    expect(await as(nina, "select tip_id from public.place_tip_confirmations c join public.place_tips t on t.id = c.tip_id where t.place_id = $1", [basement])).toHaveLength(0);
  });

  it("refuses self-confirmation and counts someone else's, with server time", async () => {
    const tip = await addTip(maya, cannon, "Wings half price Tuesdays");
    await expect(as(maya, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, maya])).rejects.toThrow(/own tip/);
    await as(theo, "insert into public.place_tip_confirmations (tip_id, user_id, created_at) values ($1, $2, '2001-01-01')", [tip, theo]);
    const row = (await db.query<{ last_confirmed_by: string; recent: boolean }>("select last_confirmed_by, last_confirmed_at > now() - interval '1 minute' as recent from public.place_tips where id = $1", [tip])).rows[0];
    expect(row).toEqual({ last_confirmed_by: theo, recent: true });
    // Nobody confirms as someone else.
    await expect(as(theo, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, nina])).rejects.toThrow();
    // Anon cannot confirm at all.
    await expect(as(null, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, theo])).rejects.toThrow();
  });

  it("an edit is not a confirmation, and nobody writes the confirmation columns directly", async () => {
    const tip = await tipOf(cannon);
    const before = (await db.query<{ last_confirmed_at: string }>("select last_confirmed_at from public.place_tips where id = $1", [tip])).rows[0];
    await as(theo, "update public.place_tips set body = 'Sound on for every OSU game' where id = $1", [tip]);
    const after = (await db.query<{ body: string; last_confirmed_at: string; edited: boolean }>("select body, last_confirmed_at, updated_at > created_at as edited from public.place_tips where id = $1", [tip])).rows[0];
    expect(after.body).toBe("Sound on for every OSU game");
    expect(after.last_confirmed_at).toEqual(before.last_confirmed_at);
    expect(after.edited).toBe(true);
    await expect(as(theo, "update public.place_tips set last_confirmed_at = now(), last_confirmed_by = $2 where id = $1", [tip, theo])).rejects.toThrow(/permission denied/);
    // Another user cannot edit it.
    expect(await as(maya, "update public.place_tips set body = 'hijack' where id = $1 returning id", [tip])).toHaveLength(0);
  });

  it("temporary tips need an expiry and lasting ones must not have one", async () => {
    await expect(addTip(maya, cannon, "Patio closed", "temporary", null)).rejects.toThrow(/place_tips_expiry/);
    await expect(addTip(maya, cannon, "Old story", "story", "2030-01-01")).rejects.toThrow(/place_tips_expiry/);
    expect(await addTip(maya, cannon, "Patio closed", "temporary", new Date(Date.now() + DAY).toISOString())).toBeTruthy();
  });

  it("only moderators hide tips; hidden tips and their evidence vanish for everyone but the author and moderators", async () => {
    const tip = await addTip(maya, cannon, "Ask for the back booth");
    await as(theo, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, theo]);
    await as(nina, "insert into public.place_tip_corrections (tip_id, author_id, body) values ($1, $2, 'Booth was removed')", [tip, nina]);
    await expect(as(maya, "update public.place_tips set status = 'removed' where id = $1", [tip])).rejects.toThrow(/moderators/);
    expect(await as(theo, "update public.place_tips set status = 'hidden' where id = $1 returning id", [tip])).toHaveLength(0);
    await as(mod, "update public.place_tips set status = 'hidden' where id = $1", [tip]);
    for (const viewer of [null, theo, nina]) {
      expect(await as(viewer, "select id from public.place_tips where id = $1", [tip])).toHaveLength(0);
      expect(await as(viewer, "select tip_id from public.place_tip_confirmations where tip_id = $1", [tip])).toHaveLength(0);
      expect(await as(viewer, "select id from public.place_tip_corrections where tip_id = $1", [tip])).toHaveLength(0);
    }
    expect(await as(maya, "select id from public.place_tips where id = $1", [tip])).toHaveLength(1);
    expect(await as(mod, "select tip_id from public.place_tip_confirmations where tip_id = $1", [tip])).toHaveLength(1);
    // A hidden tip cannot be confirmed, and its author cannot un-hide it.
    await expect(as(nina, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, nina])).rejects.toThrow();
    await expect(as(maya, "update public.place_tips set status = 'published' where id = $1", [tip])).rejects.toThrow(/moderators/);
  });

  it("confirmations are append-only", async () => {
    const tip = await tipOf(cannon);
    expect(await as(maya, "delete from public.place_tip_confirmations where tip_id = $1 returning tip_id", [tip]).catch((e: Error) => e.message)).toMatch(/permission denied/);
  });

  it("rate-limits confirmations per user", async () => {
    const tip = await addTip(theo, cannon, "Kitchen closes at 11");
    await db.query(
      `insert into public.rate_limit_counters (user_id, action, window_start, count)
       select $1, 'tip_confirmations', to_timestamp(floor(extract(epoch from now()) / 86400) * 86400), $2`,
      [nina, RATE_LIMITS.tip_confirmations.max],
    );
    await expect(as(nina, "insert into public.place_tip_confirmations (tip_id, user_id) values ($1, $2)", [tip, nina])).rejects.toThrow(/rate_limited:tip_confirmations/);
  });

  it("a suspended account writes no tips", async () => {
    await db.query("insert into public.suspensions (user_id, reason) values ($1, 'test')", [nina]);
    await expect(addTip(nina, cannon, "spam")).rejects.toThrow(/account_suspended/);
    await db.query("delete from public.suspensions where user_id = $1", [nina]);
  });
});

describe("tips in the demo repository", () => {
  let repo: DataRepository;
  beforeEach(() => {
    repo = createDemoRepository(createIsolatedStore());
  });

  it("starts with the same seeded tips and confirmation as the database", async () => {
    const tips = await repo.tips.list(cannon, null);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ kind: "practical", author: { id: theo }, lastConfirmedBy: { id: maya } });
    expect(await repo.tips.list(basement, null)).toEqual([]);
    expect(await repo.tips.list(basement, nina)).toEqual([]);
  });

  it("refuses self-confirmation, records others, and an edit does not confirm", async () => {
    const tip = await repo.tips.add(maya, cannon, { body: "Ask for the back booth", kind: "practical" });
    await expect(repo.tips.confirm(maya, tip.id)).rejects.toMatchObject({ code: "forbidden" });
    await repo.tips.confirm(theo, tip.id);
    const edited = await repo.tips.edit(maya, tip.id, { body: "Ask for the corner booth", kind: "practical" });
    expect(edited.lastConfirmedBy?.id).toBe(theo);
    await expect(repo.tips.edit(theo, tip.id, { body: "hijack", kind: "practical" })).rejects.toMatchObject({ code: "forbidden" });
    const ev = await repo.tips.evidence(tip.id, null);
    expect(ev?.confirmations.map((c) => c.user?.id)).toEqual([theo]);
  });

  it("hides expired temporary tips from the current list", async () => {
    const tip = await repo.tips.add(maya, cannon, { body: "Patio closed", kind: "temporary", expiresAt: new Date(Date.now() + 2 * DAY).toISOString() });
    expect((await repo.tips.list(cannon, null)).map((t) => t.id)).toContain(tip.id);
    expect((await repo.tips.list(cannon, null, Date.now() + 3 * DAY)).map((t) => t.id)).not.toContain(tip.id);
  });

  it("moderator hide removes the tip and its evidence from everyone but author and moderators", async () => {
    const tip = await repo.tips.add(maya, cannon, { body: "Back booth", kind: "practical" });
    await repo.tips.suggestCorrection(nina, tip.id, "Booth was removed");
    await expect(repo.tips.setStatus(theo, tip.id, "hidden")).rejects.toMatchObject({ code: "forbidden" });
    await repo.tips.setStatus(mod, tip.id, "hidden");
    expect(await repo.tips.evidence(tip.id, theo)).toBeNull();
    expect(await repo.tips.evidence(tip.id, null)).toBeNull();
    expect((await repo.tips.list(cannon, maya)).map((t) => t.id)).not.toContain(tip.id);
    expect((await repo.tips.evidence(tip.id, maya))?.corrections).toHaveLength(1);
    expect(await repo.tips.evidence(tip.id, mod)).not.toBeNull();
    await expect(repo.tips.confirm(theo, tip.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rate-limits confirmations like the database", async () => {
    const tip = await repo.tips.add(theo, cannon, { body: "Kitchen closes at 11", kind: "practical" });
    for (let i = 0; i < RATE_LIMITS.tip_confirmations.max; i++) await repo.tips.confirm(nina, tip.id);
    await expect(repo.tips.confirm(nina, tip.id)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("tip actions and the place page", () => {
  beforeEach(() => {
    ctx.repo = createDemoRepository(createIsolatedStore());
    ctx.viewer = null;
  });

  it("the confirm action refuses signed-out viewers and the author, and records anyone else", async () => {
    const { confirmTipAction, addTipAction } = await import("../src/server/actions/tips");
    const [tip] = await ctx.repo.tips.list(cannon, null);
    expect(await confirmTipAction(cannon, tip.id)).toMatchObject({ ok: false, code: "unauthenticated" });
    ctx.viewer = { id: theo };
    expect(await confirmTipAction(cannon, tip.id)).toMatchObject({ ok: false, code: "forbidden" });
    ctx.viewer = { id: nina };
    expect(await confirmTipAction(cannon, tip.id)).toEqual({ ok: true, data: undefined });
    expect((await ctx.repo.tips.list(cannon, null))[0].lastConfirmedBy?.id).toBe(nina);
    expect(await addTipAction({ placeId: cannon, body: "", kind: "practical" })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("the page shows the recent observation with its date and each tip's provenance and evidence", async () => {
    const { default: PlacePage } = await import("../src/app/places/[id]/page");
    const el = (await PlacePage({ params: Promise.resolve({ id: cannon }), searchParams: Promise.resolve({}) } as never)) as ReactElement;
    const html = renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
    expect(html).toContain('data-block="observation"');
    expect(html).toMatch(/Confirmed by Maya Reyes, today/);
    expect(html).toContain("Practical tip · by Theo");
    expect(html).toMatch(/data-tip-evidence=/);
    expect(html.indexOf('data-block="observation"')).toBeLessThan(html.indexOf('data-block="you"'));
  });
});
