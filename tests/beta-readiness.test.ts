/**
 * Session 9 odds and ends: onboarding, the production demo-mode guard, the
 * Content-Security-Policy, map provider selection and pin labels, and the
 * observability module's Sentry envelope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, migrateDemoState, STATE_VERSION } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { demoModeRefusal } from "../src/lib/config";
import { buildCsp, createNonce } from "../src/lib/security/csp";
import { mapProvider } from "../src/lib/map/config";
import { eventMarker, placeMarker } from "../src/lib/map/markers";
import { parseSentryDsn, sentryEnvelope } from "../src/lib/observability";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;

describe("onboarding", () => {
  it("counts every existing account as onboarded, and lets a user mark only their own", async () => {
    const db = await createSeededDb();
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.profiles where onboarded_at is null");
    expect(rows[0].n).toBe(0);
    await db.query("insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-4000-8000-0000000000aa', 'new@example.test', '{\"username\":\"newcomer\"}')");
    const fresh = "00000000-0000-4000-8000-0000000000aa";
    expect((await db.query<{ o: string | null }>("select onboarded_at as o from public.profiles where id = $1", [fresh])).rows[0].o).toBeNull();
    await queryAs(db, maya, "update public.profiles set onboarded_at = now() where id = $1", [fresh]);
    expect((await db.query<{ o: string | null }>("select onboarded_at as o from public.profiles where id = $1", [fresh])).rows[0].o).toBeNull();
    await queryAs(db, fresh, "update public.profiles set onboarded_at = now() where id = $1", [fresh]);
    expect((await db.query<{ o: string | null }>("select onboarded_at as o from public.profiles where id = $1", [fresh])).rows[0].o).not.toBeNull();
  }, 30_000);

  it("carries a v4 demo store forward with everyone onboarded", () => {
    const v4 = JSON.parse(JSON.stringify(createIsolatedStore().state)) as Record<string, unknown>;
    v4.version = 4;
    for (const p of v4.profiles as Record<string, unknown>[]) delete p.onboardedAt;
    const result = migrateDemoState(v4);
    expect(result.ok && result.state.version).toBe(STATE_VERSION);
    if (result.ok) expect(result.state.profiles.every((p) => p.onboardedAt)).toBe(true);
  });
});

// The actions, against a real demo repository.
const ctx: { viewer: string | null; repo: DataRepository } = { viewer: null, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => (ctx.viewer ? { id: ctx.viewer, profile: await ctx.repo.profiles.getById(ctx.viewer) } : null),
}));

describe("onboarding actions", async () => {
  const { saveOnboardingStepAction, finishOnboardingAction } = await import("../src/server/actions/onboarding");
  let newcomer: string;
  beforeEach(async () => {
    const store = createIsolatedStore();
    ctx.repo = createDemoRepository(store);
    newcomer = "00000000-0000-4000-8000-0000000000bb";
    store.state.profiles.push({ id: newcomer, username: "newcomer", displayName: "New Comer", avatarUrl: null, bio: null, homeCity: null, homeCityChangedAt: null, onboardedAt: null, analyticsOptOut: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    ctx.viewer = newcomer;
  });

  it("saves each step on top of the profile and finishes once", async () => {
    expect(await saveOnboardingStepAction({ interests: ["coffee", "hiking", "not-a-tag"] })).toEqual({ ok: true, data: undefined });
    expect(await saveOnboardingStepAction({ homeCity: "Columbus" })).toEqual({ ok: true, data: undefined });
    const profile = await ctx.repo.profiles.getById(newcomer);
    expect(profile).toMatchObject({ interests: ["coffee", "hiking"], homeCity: "Columbus", onboardedAt: null });
    expect(await finishOnboardingAction()).toEqual({ ok: true, data: { interests: ["coffee", "hiking"] } });
    const done = (await ctx.repo.profiles.getById(newcomer))!.onboardedAt;
    expect(done).not.toBeNull();
    await finishOnboardingAction();
    expect((await ctx.repo.profiles.getById(newcomer))!.onboardedAt).toBe(done);
  });

  it("applies the home city cooldown on the home city step", async () => {
    await saveOnboardingStepAction({ homeCity: "Columbus" });
    expect(await saveOnboardingStepAction({ homeCity: "Dayton" })).toMatchObject({ ok: false, fieldErrors: { homeCity: expect.stringMatching(/change your home city again/) } });
  });

  it("requires a session", async () => {
    ctx.viewer = null;
    expect(await finishOnboardingAction()).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});

describe("demo mode in production", () => {
  it("is refused unless Supabase is configured or a public demo is declared", () => {
    expect(demoModeRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(demoModeRefusal({ NODE_ENV: "test" })).toBeNull();
    expect(demoModeRefusal({ NODE_ENV: "production" })).toMatch(/will not run in demo mode in production/);
    expect(demoModeRefusal({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" })).toMatch(/demo mode/);
    expect(demoModeRefusal({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(demoModeRefusal({ NODE_ENV: "production", FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION: "1" })).toBeNull();
    expect(demoModeRefusal({ NODE_ENV: "production", FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION: "true" })).not.toBeNull();
  });

  it("stops the server at startup", async () => {
    const { register } = await import("../src/instrumentation");
    const env = { ...process.env };
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION", "");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(register()).rejects.toThrow(/demo mode/);
      err.mockRestore();
    } finally {
      vi.unstubAllEnvs();
      process.env = env;
    }
  });
});

describe("Content-Security-Policy", () => {
  it("nonces scripts, allows the map providers and Supabase, and forbids framing", () => {
    const nonce = createNonce();
    const csp = buildCsp(nonce);
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toMatch(/connect-src [^;]*https:\/\/tiles\.openfreemap\.org/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.mapbox\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/\*\.supabase\.co/);
    expect(csp).toMatch(/worker-src 'self' blob:/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(buildCsp(nonce, { dev: true })).toContain("'unsafe-eval'");
    expect(createNonce()).not.toBe(nonce);
  });
});

describe("map provider and pins", () => {
  it("uses Mapbox only with a public pk. token, never a secret or malformed one", () => {
    expect(mapProvider(undefined)).toBe("maplibre");
    expect(mapProvider("")).toBe("maplibre");
    expect(mapProvider("sk.eyJ1IjoiYWJjIiwiYSI6ImRlZiJ9.secret")).toBe("maplibre");
    expect(mapProvider("not-a-token")).toBe("maplibre");
    expect(mapProvider("pk.eyJ1IjoiZmluZG1heHhpbmciLCJhIjoiY2x4eXoifQ.abc123")).toBe("mapbox");
  });

  it("gives every pin an accessible name with its category and rating or time", () => {
    expect(placeMarker({ id: "1", lat: 0, lng: 0, name: "Meeple Cellar", categorySlug: "food", ratingAvg: 4.5, ratingCount: 12 }).label).toMatch(/^Meeple Cellar, .+, rated 4\.5 from 12 ratings$/);
    expect(placeMarker({ id: "1", lat: 0, lng: 0, name: "New spot", categorySlug: "food", ratingAvg: 0, ratingCount: 0 }).label).toMatch(/not rated yet$/);
    expect(eventMarker({ id: "2", lat: 0, lng: 0, title: "Run club", categorySlug: "outdoors", startsAt: "2026-10-08T22:00:00Z" }).label).toMatch(/^Run club, Outdoors event, \w{3}, Oct \d+/);
  });
});

describe("observability", () => {
  it("parses a Sentry DSN and builds an envelope without personal data keys", async () => {
    expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/456")).toEqual({ publicKey: "abc123", host: "o1.ingest.sentry.io", projectId: "456", protocol: "https" });
    expect(parseSentryDsn("not a dsn")).toBeNull();
    expect(parseSentryDsn("https://o1.ingest.sentry.io/456")).toBeNull();
    const dsn = parseSentryDsn("https://abc123@o1.ingest.sentry.io/456")!;
    const lines = sentryEnvelope(dsn, { name: "Error", message: "boom" }, { where: "test" }, "e1").split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ event_id: "e1" });
    expect(lines[1]).toEqual({ type: "event" });
    expect(lines[2]).toMatchObject({ exception: { values: [{ type: "Error", value: "boom" }] }, extra: { where: "test" } });
  });

  it("logs one JSON line per error and drops sensitive context keys", async () => {
    const { reportError } = await import("../src/lib/observability");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError(new Error("db down"), { where: "health", password: "hunter2", email: "a@b.c", userId: "u1" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    expect(line).toMatchObject({ level: "error", message: "db down", where: "health", userId: "u1" });
    expect(line.password).toBeUndefined();
    expect(line.email).toBeUndefined();
  });
});
