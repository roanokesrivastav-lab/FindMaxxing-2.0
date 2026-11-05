/**
 * Roadmap 0.3: pilot flags in the existing registry, and the pilot role seed accounts.
 * Pilot flags must never turn on through NEXT_PUBLIC_FEATURES=all; they turn on only when named,
 * or through the explicit "pilot" token. Existing flags keep their behaviour exactly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURES, PILOT_ALL_TOKEN, PILOT_FEATURES, featureEnabled, isPilotFeature, pilotFlags } from "../src/lib/config";
import { DEMO_PASSWORD, SEED_EVENTS, SEED_MODERATORS, SEED_ROLE_ACCOUNTS, SEED_USERS, seedOrigin, SEED_PLACES } from "../src/lib/seed/seed-data";
import { createSeededDb } from "./helpers/pglite";
import { buildSeedState } from "../src/lib/data/demo/store";

const env = (features: string, extra: Record<string, string> = {}) => ({ NEXT_PUBLIC_FEATURES: features, ...extra });

describe("pilot flags (roadmap 0.3)", () => {
  it("one per roadmap milestone, in the existing registry, with no name shared with existing flags", () => {
    expect(PILOT_FEATURES).toEqual(["pilotFoundation", "pilotExplore", "pilotLibrary", "pilotEvents", "pilotOutings", "pilotItinerary", "pilotLocal"]);
    for (const f of PILOT_FEATURES) expect((FEATURES as readonly string[]).includes(f)).toBe(false);
    expect(isPilotFeature("pilotEvents")).toBe(true);
    expect(isPilotFeature("messaging")).toBe(false);
  });

  it("existing flags are unchanged: off unless listed, on with their name or 'all', key checks still apply", () => {
    for (const f of FEATURES) {
      expect(featureEnabled(f, {})).toBe(false);
      expect(featureEnabled(f, env(""))).toBe(false);
      expect(featureEnabled(f, env("pilot"))).toBe(false);
    }
    expect(featureEnabled("messaging", env("all"))).toBe(true);
    expect(featureEnabled("messaging", env("analytics, messaging"))).toBe(true);
    expect(featureEnabled("tripPlanning", env("all"))).toBe(false);
    expect(featureEnabled("tripPlanning", env("all", { ANTHROPIC_API_KEY: "k" }))).toBe(true);
    expect(featureEnabled("payments", env("payments", { STRIPE_SECRET_KEY: "s" }))).toBe(false);
    expect(featureEnabled("payments", env("payments", { STRIPE_SECRET_KEY: "s", STRIPE_WEBHOOK_SECRET: "w" }))).toBe(true);
  });

  it("'all' never turns on a pilot flag, so a rebuilt deployment gains no unfinished feature", () => {
    for (const f of PILOT_FEATURES) {
      expect(featureEnabled(f, env("all"))).toBe(false);
      expect(featureEnabled(f, env("all,messaging,payments"))).toBe(false);
      expect(featureEnabled(f, {})).toBe(false);
    }
  });

  it("naming a pilot flag, or the explicit 'pilot' token, turns it on", () => {
    expect(featureEnabled("pilotEvents", env("pilotEvents"))).toBe(true);
    expect(featureEnabled("pilotExplore", env("pilotEvents"))).toBe(false);
    expect(featureEnabled("pilotExplore", env(" all , pilotExplore "))).toBe(true);
    for (const f of PILOT_FEATURES) expect(featureEnabled(f, env(PILOT_ALL_TOKEN))).toBe(true);
    expect(pilotFlags(env("pilotLibrary"))).toEqual(Object.fromEntries(PILOT_FEATURES.map((f) => [f, f === "pilotLibrary"])));
  });

  it("demo and test configuration enable pilot flags explicitly, not through a code default", () => {
    const root = path.join(__dirname, "..");
    expect(readFileSync(path.join(root, ".env.development"), "utf8")).toMatch(/^NEXT_PUBLIC_FEATURES=pilot$/m);
    expect(readFileSync(path.join(root, "scripts/lib/demo-server.mjs"), "utf8")).toMatch(/"pilot"\]/);
    expect(readFileSync(path.join(root, "vitest.config.mts"), "utf8")).toMatch(/NEXT_PUBLIC_FEATURES: "pilot"/);
    // Vitest applies it, so this suite runs with every pilot flag on and every existing flag off.
    expect(Object.values(pilotFlags()).every(Boolean)).toBe(true);
    expect(FEATURES.some((f) => featureEnabled(f))).toBe(false);
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).not.toMatch(/^NEXT_PUBLIC_FEATURES=.*pilot/m);
  });
});

describe("pilot role seed accounts (roadmap 0.3)", () => {
  const byName = (username: string) => SEED_USERS.find((u) => u.username === username)!;

  it("host, participant, outsider and moderator exist with credentials only in the seed file", () => {
    for (const [role, acct] of Object.entries(SEED_ROLE_ACCOUNTS)) {
      const user = byName(acct.username);
      expect([role, user?.email]).toEqual([role, acct.email]);
      expect(acct.password).toBe(DEMO_PASSWORD);
      expect(acct.email).toMatch(/@example\.com$/);
    }
    expect(SEED_MODERATORS).toContain(SEED_ROLE_ACCOUNTS.moderator.username);
  });

  it("the host hosts an event the participant joined; the outsider has no relationships", () => {
    const run = SEED_EVENTS.find((e) => e.creator === SEED_ROLE_ACCOUNTS.host.username)!;
    expect(run.attendees).toEqual([SEED_ROLE_ACCOUNTS.host.username, SEED_ROLE_ACCOUNTS.participant.username]);
    const outsider = SEED_ROLE_ACCOUNTS.outsider.username;
    expect(SEED_EVENTS.some((e) => e.creator === outsider || e.attendees.includes(outsider))).toBe(false);
  });

  it("every seed record is marked fictional or pilot, and today all of it is fictional", () => {
    for (const r of [...SEED_USERS, ...SEED_PLACES, ...SEED_EVENTS]) expect(["fictional", "pilot"]).toContain(seedOrigin(r));
    expect([...SEED_USERS, ...SEED_PLACES, ...SEED_EVENTS].filter((r) => seedOrigin(r) === "pilot")).toEqual([]);
  });

  it("the accounts reach both the SQL seed and the demo store, with the moderator granted", async () => {
    const db = await createSeededDb();
    try {
      const rows = (await db.query<{ username: string; moderator: boolean }>(
        `select p.username, exists (select 1 from public.moderators m where m.user_id = p.id) as moderator
         from public.profiles p where p.username = any($1) order by p.username`,
        [Object.values(SEED_ROLE_ACCOUNTS).map((a) => a.username)],
      )).rows;
      expect(rows).toEqual([
        { username: "hana_host", moderator: false },
        { username: "mo_moderator", moderator: true },
        { username: "olu_outsider", moderator: false },
        { username: "pat_participant", moderator: false },
      ]);
    } finally {
      await db.close();
    }
    const state = buildSeedState();
    for (const acct of Object.values(SEED_ROLE_ACCOUNTS)) expect(state.authUsers.some((u) => u.email === acct.email)).toBe(true);
  });
});
