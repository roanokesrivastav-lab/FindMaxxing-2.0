/**
 * Sponsored cards (Session 18). The required test first: organic results are
 * identical with and without running campaigns. Then: only your own public
 * listing can be advertised, admins review (audited), payment activates,
 * serving is contextual, paced and budgeted, impressions are aggregated with
 * no person in them, clients cannot write or serve, Plus members see none,
 * and the demo store serves the same cards as SQL.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type Stripe from "stripe";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, migrateDemoState, buildSeedState } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import type { NewCampaignInput } from "../src/lib/data/types";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { dailyCap } from "../src/lib/data/ads";

vi.mock("server-only", () => ({}));
const { handleStripeEvent } = await import("../src/server/payments/webhook");

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, lena, dev, nina] = ["maya_r", "lena", "dev", "nina"].map(user); // dev is an admin
const DAY = 86_400_000;
const COLUMBUS = { north: 40.1, south: 39.85, east: -82.85, west: -83.15 };
const FAR_AWAY = { north: 41.6, south: 41.4, east: -87.5, west: -87.8 }; // Chicago

/** One of lena's public places, its location and category. */
function lenasPlace(repo: { state: ReturnType<typeof createIsolatedStore>["state"] }) {
  const p = repo.state.places.find((x) => x.creatorId === lena && x.status === "published" && x.visibility === "public")!;
  return p;
}
const campaign = (placeId: string, over: Partial<NewCampaignInput> = {}): NewCampaignInput => ({
  kind: "place", targetId: placeId, headline: "Half-price tea on Tuesdays", body: "Locals' favourite corner", bounds: COLUMBUS, categorySlug: null,
  startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 10 * DAY).toISOString(), budgetCents: 2000, ...over,
});

describe("organic results with and without sponsored campaigns", () => {
  it("are identical in SQL and in the demo store; sponsored cards only come from the separate slot", async () => {
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    const db = await createSeededDb();
    const viewers = [null, maya, nina];
    const sqlOrganic = async () => {
      const out: unknown[] = [];
      for (const v of viewers) {
        out.push(await queryAs(db, v, "select id from public.discover_places($1, $2, $3, $4) order by created_at desc, id desc", [COLUMBUS.north, COLUMBUS.south, COLUMBUS.east, COLUMBUS.west]));
        out.push(await queryAs(db, v, "select id, rating_avg, rating_count, save_count from public.places order by id"));
        out.push(await queryAs(db, v, "select id from public.events order by id"));
        if (v) out.push(await queryAs(db, v, "select place_id, score from public.recommend_places(null, null, 50)"));
      }
      return JSON.stringify(out);
    };
    const demoOrganic = async () => {
      const out: unknown[] = [];
      for (const v of viewers) {
        out.push((await repo.places.search({ bounds: COLUMBUS, viewerId: v, limit: 100 })).items.map((p) => p.id));
        out.push((await repo.events.search({ bounds: COLUMBUS, viewerId: v, limit: 100 })).items.map((e) => e.id));
        out.push(await repo.places.mapMarkers({ bounds: COLUMBUS, viewerId: v }));
        out.push((await repo.places.search({ viewerId: v, limit: 100 })).items.map((p) => [p.id, p.ratingAvg, p.ratingCount]));
        if (v) out.push((await repo.recommendations.places(v, { limit: 50 })).map((r) => [r.item.id, r.score]));
      }
      return JSON.stringify(out);
    };
    const [sqlBefore, demoBefore] = [await sqlOrganic(), await demoOrganic()];

    // Running campaigns on both sides, served many times.
    const place = lenasPlace(handle);
    const demoId = await repo.ads.create(lena, campaign(place.id, { budgetCents: 100_000 }));
    await repo.ads.review(dev, demoId, true, null);
    await repo.ads.attachCheckout(demoId, "cs_ad");
    expect(await repo.ads.activate("cs_ad", 100_000)).toBe("active");
    const sqlId = (await queryAs<{ id: string }>(db, lena, "select public.create_ad_campaign('place', $1, 'Half-price tea', null, null, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '10 days', 100000) as id",
      [place.id, COLUMBUS.north, COLUMBUS.south, COLUMBUS.east, COLUMBUS.west]))[0].id;
    await queryAs(db, dev, "select public.review_ad_campaign($1, true, null)", [sqlId]);
    await db.exec("set role service_role");
    await db.query("select public.attach_ad_checkout($1, 'cs_sql')", [sqlId]);
    await db.query("select public.activate_ad_campaign('cs_sql', 100000)");
    for (let i = 0; i < 5; i++) await db.query("select * from public.serve_ad('places', $1, $2, $3, $4, null, now())", [COLUMBUS.north, COLUMBUS.south, COLUMBUS.east, COLUMBUS.west]);
    await db.exec("reset role");
    for (let i = 0; i < 5; i++) expect((await repo.ads.serve("places", { bounds: COLUMBUS, categorySlug: null }))?.targetId).toBe(place.id);

    expect(await sqlOrganic()).toBe(sqlBefore);
    expect(await demoOrganic()).toBe(demoBefore);
  }, 120_000);
});

describe("sponsored cards in the database", () => {
  let db: PGlite;
  let placeId: string;
  let cat: string;
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
    await db.exec("set role service_role");
    try {
      return (await db.query<T>(sql, p)).rows;
    } finally {
      await db.exec("reset role");
    }
  };
  const create = (who: string, target: string, budget = 2000, bounds: typeof COLUMBUS | null = COLUMBUS, category: string | null = null) =>
    as<{ id: string }>(who, "select public.create_ad_campaign('place', $1, 'Half-price tea', null, $7, $2, $3, $4, $5, now() - interval '1 minute', now() + interval '10 days', $6) as id",
      [target, bounds?.north ?? null, bounds?.south ?? null, bounds?.east ?? null, bounds?.west ?? null, budget, category]).then((r) => r[0].id);
  const serve = (bounds: typeof COLUMBUS | null, category: string | null = null, at = "now()") =>
    service<{ campaign_id: string; target_id: string }>(`select * from public.serve_ad('places', $1, $2, $3, $4, $5, ${at})`, [bounds?.north ?? null, bounds?.south ?? null, bounds?.east ?? null, bounds?.west ?? null, category]);
  const run = async (id: string, session: string, amount: number) => {
    await as(dev, "select public.review_ad_campaign($1, true, null)", [id]);
    await service("select public.attach_ad_checkout($1, $2)", [id, session]);
    return (await service<{ r: string }>("select public.activate_ad_campaign($1, $2) as r", [session, amount]))[0].r;
  };
  beforeAll(async () => {
    db = await createSeededDb();
    const p = (await db.query<{ id: string; category_slug: string }>("select id, category_slug from public.places where creator_id = $1 and status = 'published' and visibility = 'public' limit 1", [lena])).rows[0];
    placeId = p.id;
    cat = p.category_slug;
  });

  it("lets people advertise only their own public listing", async () => {
    await expect(create(maya, placeId)).rejects.toThrow(/ads:bad_target/);
    const locals = (await db.query<{ id: string }>("select id from public.places where creator_id = $1 and visibility <> 'public' limit 1", [user("jules")])).rows[0];
    if (locals) await expect(create(user("jules"), locals.id)).rejects.toThrow(/ads:bad_target/);
    await expect(as(lena, "insert into public.ad_campaigns (advertiser_id, kind, place_id, headline, starts_at, ends_at, budget_cents) values (auth.uid(), 'place', $1, 'x', now(), now() + interval '1 day', 2000)", [placeId])).rejects.toThrow(/permission denied/);
    await expect(create(lena, placeId, 10)).rejects.toThrow(/check constraint/);
  });

  it("goes through admin review (audited) and runs only once paid in full", async () => {
    const id = await create(lena, placeId);
    expect(await serve(COLUMBUS)).toEqual([]);
    await expect(as(lena, "select public.review_ad_campaign($1, true, null)", [id])).rejects.toThrow(/Admins only/);
    await expect(as(dev, "select public.review_ad_campaign($1, false, null)", [id])).rejects.toThrow(/reason_required/);
    await service("select public.attach_ad_checkout($1, 'cs_early')", [id]);
    expect(await service("select public.activate_ad_campaign('cs_early', 2000) as r")).toEqual([{ r: "unknown" }]); // not approved yet
    expect(await run(id, "cs_1", 1999)).toBe("mismatch");
    expect(await service("select public.activate_ad_campaign('cs_1', 2000) as r")).toEqual([{ r: "active" }]);
    expect(await service("select public.activate_ad_campaign('cs_1', 2000) as r")).toEqual([{ r: "duplicate" }]);
    expect((await db.query("select action, target_type from public.moderation_actions where target_id = $1", [id])).rows).toEqual([{ action: "approve_ad", target_type: "campaign" }]);
    // Only the advertiser and admins see it.
    expect(await as(maya, "select * from public.ad_campaigns where id = $1", [id])).toEqual([]);
    expect((await as(dev, "select id from public.ad_campaigns where id = $1", [id]))).toHaveLength(1);
  });

  it("serves by context only, never to clients directly", async () => {
    await expect(as(maya, "select * from public.serve_ad('places', null, null, null, null, null, now())")).rejects.toThrow(/permission denied/);
    await expect(as(null, "select * from public.serve_ad('places', null, null, null, null, null, now())")).rejects.toThrow(/permission denied/);
    expect((await serve(COLUMBUS)).map((r) => r.target_id)).toEqual([placeId]);
    expect(await serve(FAR_AWAY)).toEqual([]);
    expect((await service("select * from public.serve_ad('events', null, null, null, null, null, now())"))).toEqual([]);
    // Impressions are aggregated: no column can hold a person.
    const cols = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'ad_impressions' order by 1")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["campaign_id", "day", "impressions", "slot"]);
    expect(await as(maya, "select * from public.ad_impressions")).toEqual([]);
    await expect(as(lena, "update public.ad_impressions set impressions = 0")).rejects.toThrow(/permission denied/);
  });

  it("respects the category, the daily pacing cap and the budget", async () => {
    await db.query("update public.ad_campaigns set status = 'ended'");
    const id = await create(lena, placeId, 2000, null, cat);
    expect(await run(id, "cs_2", 2000)).toBe("active");
    expect(await serve(null, "nightlife-not-this-one")).toEqual([]);
    const dates = (await db.query<{ starts_at: Date; ends_at: Date }>("select starts_at, ends_at from public.ad_campaigns where id = $1", [id])).rows[0];
    const cap = dailyCap(2000, dates.starts_at.toISOString(), dates.ends_at.toISOString());
    let served = 0;
    while ((await serve(null, cat)).length) served += 1;
    expect(served).toBe(cap); // 4,000 impressions spread over the run (10 days and a minute: 11 days)
    // Tomorrow it serves again; once the budget is spent it ends.
    await db.query("update public.ad_impressions set impressions = 3999 where campaign_id = $1", [id]);
    expect((await serve(null, cat, "now() + interval '1 day'")).length).toBe(1);
    expect((await db.query("select status from public.ad_campaigns where id = $1", [id])).rows).toEqual([{ status: "ended" }]);
    expect(await serve(null, cat, "now() + interval '2 days'")).toEqual([]);
  });

  it("stops serving when the listing stops being public, and pauses on request", async () => {
    await db.query("update public.ad_campaigns set status = 'ended'");
    const id = await create(lena, placeId);
    await run(id, "cs_3", 2000);
    await as(lena, "select public.set_ad_campaign_paused($1, true)", [id]);
    expect(await serve(COLUMBUS)).toEqual([]);
    await expect(as(maya, "select public.set_ad_campaign_paused($1, false)", [id])).rejects.toThrow(/ads:not_found/);
    await as(lena, "select public.set_ad_campaign_paused($1, false)", [id]);
    expect(await serve(COLUMBUS)).toHaveLength(1);
    await db.query("update public.places set visibility = 'locals' where id = $1", [placeId]);
    expect(await serve(COLUMBUS)).toEqual([]);
    await db.query("update public.places set visibility = 'public' where id = $1", [placeId]);
  });
});

describe("sponsored cards in demo mode", () => {
  let handle: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    handle = createIsolatedStore();
    repo = createDemoRepository(handle);
  });

  it("follows the same rules, and serves the same cards as SQL", async () => {
    const place = lenasPlace(handle);
    await expect(repo.ads.create(maya, campaign(place.id))).rejects.toMatchObject({ message: "You can promote your own public place or upcoming event" });
    await expect(repo.ads.create(lena, campaign(place.id, { budgetCents: 10 }))).rejects.toMatchObject({ code: "invalid" });
    const id = await repo.ads.create(lena, campaign(place.id));
    expect(await repo.ads.reviewQueue(maya)).toEqual([]);
    expect((await repo.ads.reviewQueue(dev)).map((c) => c.id)).toEqual([id]);
    await expect(repo.ads.review(maya, id, true, null)).rejects.toMatchObject({ code: "forbidden" });
    await repo.ads.review(dev, id, true, null);
    await repo.ads.attachCheckout(id, "cs");
    expect(await repo.ads.activate("cs", 2000)).toBe("active");
    expect(await repo.ads.serve("places", { bounds: FAR_AWAY, categorySlug: null })).toBeNull();
    const cap = dailyCap(2000, campaign(place.id).startsAt, campaign(place.id).endsAt);
    let served = 0;
    while (await repo.ads.serve("places", { bounds: COLUMBUS, categorySlug: null })) served += 1;
    expect(served).toBe(cap);
    expect((await repo.ads.mine(lena))[0]).toMatchObject({ delivered: cap, impressionBudget: 4000, status: "active" });
    expect(Object.keys(handle.state.adImpressions[0]).sort()).toEqual(["campaignId", "count", "day", "slot"]);
  });

  it("activates from a Stripe webhook once, and refunds a payment that can't run", async () => {
    const place = lenasPlace(handle);
    const id = await repo.ads.create(lena, campaign(place.id));
    await repo.ads.review(dev, id, true, null);
    await repo.ads.attachCheckout(id, "cs_ad");
    const calls: unknown[] = [];
    const stripe = { refunds: { create: vi.fn(async (...a: unknown[]) => (calls.push(a), { id: "re" })) } } as never;
    const ev = (id: string, session: string, amount: number) => ({ id, type: "checkout.session.completed", data: { object: { id: session, mode: "payment", metadata: { campaign_id: "c" }, payment_intent: `pi_${session}`, amount_total: amount } } }) as unknown as Stripe.Event;
    expect(await handleStripeEvent(ev("evt_a", "cs_ad", 2000), repo, stripe)).toBe("campaign_active");
    expect(await handleStripeEvent(ev("evt_a", "cs_ad", 2000), repo, stripe)).toBe("duplicate:campaign_duplicate");
    expect(await handleStripeEvent(ev("evt_b", "cs_other", 2000), repo, stripe)).toBe("campaign_unknown");
    expect(calls).toEqual([[{ payment_intent: "pi_cs_other" }, { idempotencyKey: "refund:campaign:cs_other" }]]);
  });

  it("migrates a v11 store with no campaigns", () => {
    const v11 = buildSeedState() as unknown as Record<string, unknown>;
    delete v11.adCampaigns;
    delete v11.adImpressions;
    v11.version = 11;
    const r = migrateDemoState(v11);
    expect(r.ok && r.state.adCampaigns).toEqual([]);
  });
});

const auth = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }) }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (auth.id ? { id: auth.id, email: "x@example.com" } : null) }));

describe("the ads endpoint and actions", async () => {
  const { GET } = await import("../src/app/api/ads/route");
  const actions = await import("../src/server/actions/ads");
  const bbox = `${COLUMBUS.west},${COLUMBUS.south},${COLUMBUS.east},${COLUMBUS.north}`;
  const get = () => GET(new Request(`http://x/api/ads?slot=places&bbox=${bbox}`));
  beforeEach(() => {
    globalThis.__findmaxxingDemoStore = createIsolatedStore();
    globalThis.__findmaxxingLimiters = undefined;
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "ads,payments");
  });

  it("runs the self-serve flow, labels nothing as organic, and shows Plus members nothing", async () => {
    const repo = createDemoRepository(globalThis.__findmaxxingDemoStore!);
    const place = lenasPlace(globalThis.__findmaxxingDemoStore!);
    auth.id = lena;
    const created = await actions.createCampaignAction({ kind: "place", targetId: place.id, headline: "Half-price tea", body: "", area: "near", matchCategory: true, startsOn: new Date().toISOString().slice(0, 10), days: 7, budgetDollars: 20 });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.data.id : "";
    const [c] = await repo.ads.mine(lena);
    expect(c).toMatchObject({ categorySlug: place.categorySlug, status: "pending_review" });
    expect(c.bounds!.north - c.bounds!.south).toBeCloseTo(0.09);
    expect(await actions.payCampaignAction(id)).toMatchObject({ ok: false }); // not approved yet
    auth.id = dev;
    expect(await actions.reviewCampaignAction({ campaignId: id, approve: true })).toMatchObject({ ok: false, code: "unavailable" }); // admin flag off
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "ads,payments,admin");
    expect(await actions.reviewCampaignAction({ campaignId: id, approve: true })).toEqual({ ok: true, data: undefined });
    auth.id = lena;
    expect(await actions.payCampaignAction(id)).toEqual({ ok: true, data: { url: `/checkout/demo?campaign=${id}` } });
    expect(await actions.demoPayCampaignAction(id)).toEqual({ ok: true, data: undefined });

    auth.id = maya;
    const res = await get();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await res.json()).card).toMatchObject({ campaignId: id, headline: "Half-price tea", title: place.name, href: `/places/${place.id}` });
    await repo.payments.setEntitlement(maya, "active", new Date(Date.now() + DAY).toISOString(), "sub");
    expect(await (await get()).json()).toEqual({ card: null });
    vi.unstubAllEnvs();
    expect((await get()).status).toBe(404);
  });

  it("caps cards per IP, so reloading can't burn a budget", async () => {
    const repo = createDemoRepository(globalThis.__findmaxxingDemoStore!);
    const place = lenasPlace(globalThis.__findmaxxingDemoStore!);
    const id = await repo.ads.create(lena, campaign(place.id, { budgetCents: 100_000 }));
    await repo.ads.review(dev, id, true, null);
    await repo.ads.attachCheckout(id, "cs");
    await repo.ads.activate("cs", 100_000);
    auth.id = null;
    let shown = 0;
    for (let i = 0; i < 130; i++) if ((await (await get()).json()).card) shown += 1;
    expect(shown).toBe(120);
    expect((await repo.ads.mine(lena))[0].delivered).toBe(120);
    vi.unstubAllEnvs();
  });
});
