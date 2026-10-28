/**
 * AI trip planning (Session 14), with a mocked Anthropic client: the tools
 * only read as the signed-in viewer, invented or invisible stops never reach
 * the plan, the agent loop is capped, failures fall back cleanly, and plans
 * are limited per person per day (in SQL and in demo mode).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

vi.mock("server-only", () => ({}));
const { TRIP_TOOLS, runTripTool } = await import("../src/server/trips/tools");
const { MAX_TOOL_ROUNDS, planTrip, validatePlan, TRIP_MODEL } = await import("../src/server/trips/planner");

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina, jules] = ["maya_r", "nina", "jules"].map(user);
const ridgeline = stableId("place:Ridgeline Loop"); // locals-only
const meeple = stableId("place:Meeple Cellar");
const request = {
  start: new Date(Date.now() + 86_400_000).toISOString(),
  end: new Date(Date.now() + 86_400_000 + 8 * 3600_000).toISOString(),
  vibe: "chill", interests: ["coffee"], budget: "low" as const, startPoint: { lat: 39.96, lng: -83.0, label: "Downtown" },
};

let repo: DataRepository;
beforeEach(() => {
  repo = createDemoRepository(createIsolatedStore());
});

describe("planner tools", () => {
  it("never take a user id from the model", () => {
    const schemas = JSON.stringify(TRIP_TOOLS.map((t) => t.input_schema));
    expect(schemas).not.toMatch(/user|viewer|owner/i);
    expect(TRIP_TOOLS.every((t) => t.strict === true)).toBe(true);
  });

  it("see only what the viewer can see", async () => {
    const asNina = await runTripTool(repo, nina, "search_places", { query: "Ridgeline", near: null });
    expect(JSON.parse(asNina.content)).toEqual([]);
    expect(await runTripTool(repo, nina, "get_place", { place_id: ridgeline })).toMatchObject({ isError: true });
    const asJules = await runTripTool(repo, jules, "get_place", { place_id: ridgeline });
    expect(JSON.parse(asJules.content).name).toBe("Ridgeline Loop");
    // my_saved is always the viewer's own.
    const saved = JSON.parse((await runTripTool(repo, maya, "my_saved", {})).content);
    expect(saved.saved.map((p: { id: string }) => p.id).sort()).toEqual((await repo.places.listSaved(maya)).map((p) => p.id).sort());
  });

  it("refuse bad input and unknown tools as error results, never throwing", async () => {
    expect(await runTripTool(repo, maya, "get_place", { place_id: "not-a-uuid" })).toMatchObject({ isError: true });
    expect(await runTripTool(repo, maya, "delete_everything", {})).toMatchObject({ isError: true });
    expect(await runTripTool(repo, maya, "distance", { from: { lat: 999, lng: 0 }, to: { lat: 0, lng: 0 } })).toMatchObject({ isError: true });
    expect(JSON.parse((await runTripTool(repo, maya, "distance", { from: { lat: 39.96, lng: -83 }, to: { lat: 39.97, lng: -83 } })).content).metres).toBeGreaterThan(1000);
  });
});

describe("plan validation", () => {
  it("keeps real, visible stops and drops invented, invisible, repeated and malformed ones", async () => {
    const plan = await validatePlan(repo, nina, {
      title: "  Saturday  ",
      summary: "A good day",
      stops: [
        { place_id: meeple, event_id: null, arrive: "10:00", leave: "11:00", travel_minutes: 0, why: "Games" },
        { place_id: stableId("place:Made Up"), event_id: null, arrive: "11:30", leave: "12:00", travel_minutes: 10, why: "Invented" },
        { place_id: ridgeline, event_id: null, arrive: "13:00", leave: "14:00", travel_minutes: 10, why: "Locals only" },
        { place_id: meeple, event_id: null, arrive: "15:00", leave: "16:00", travel_minutes: 5, why: "Again" },
        { place_id: meeple, event_id: null, arrive: "25:00", leave: "16:00", travel_minutes: 5, why: "Bad time" },
      ],
    });
    expect(plan.stops.map((s) => s.id)).toEqual([meeple]);
    expect(plan.dropped).toBe(4);
    expect(plan.title).toBe("Saturday");
  });
});

type Msg = { stop_reason: string; content: unknown[] };
const clientFrom = (turns: (Msg | Error)[]) => {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream: vi.fn((body: Record<string, unknown>) => {
          calls.push(JSON.parse(JSON.stringify(body)));
          const turn = turns[Math.min(i++, turns.length - 1)];
          return { finalMessage: async () => { if (turn instanceof Error) throw turn; return turn; } };
        }),
      },
    },
  };
  return { client: client as never, calls };
};
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

describe("the planning agent", () => {
  it("runs tools as the viewer, then validates and returns the submitted plan", async () => {
    const { client, calls } = clientFrom([
      { stop_reason: "tool_use", content: [toolUse("t1", "my_saved", {}), toolUse("t2", "search_places", { query: "coffee", near: null })] },
      { stop_reason: "tool_use", content: [toolUse("t3", "submit_plan", { title: "Coffee crawl", summary: "", stops: [{ place_id: meeple, event_id: null, arrive: "10:00", leave: "11:00", travel_minutes: 0, why: "You saved it" }] })] },
    ]);
    const events: { type: string }[] = [];
    const plan = await planTrip(repo, maya, request, (e) => events.push(e), client);
    expect(plan?.stops.map((s) => s.id)).toEqual([meeple]);
    expect(events.filter((e) => e.type === "status")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "plan" });
    // Both tool results went back together, in one user message.
    const second = calls[1].messages as { role: string; content: { type: string }[] }[];
    expect(second.at(-1)).toMatchObject({ role: "user" });
    expect(second.at(-1)!.content.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(calls[0]).toMatchObject({ model: TRIP_MODEL, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(TRIP_MODEL).toBe("claude-opus-5-5");
    expect((calls[0].system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    expect(calls[0].tool_choice).toBeUndefined(); // forced tool use is refused by this model
  });

  it("gives up after the round cap, on a refusal, on an error, and when every stop is invalid", async () => {
    const loop = clientFrom([{ stop_reason: "tool_use", content: [toolUse("t", "distance", { from: { lat: 1, lng: 1 }, to: { lat: 1, lng: 2 } })] }]);
    const seen: { type: string; message?: string }[] = [];
    expect(await planTrip(repo, maya, request, (e) => seen.push(e), loop.client)).toBeNull();
    expect(loop.calls).toHaveLength(MAX_TOOL_ROUNDS);
    expect(seen.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/too many steps/) });

    for (const turns of [
      [{ stop_reason: "refusal", content: [] }],
      [new Error("overloaded")],
      [{ stop_reason: "tool_use", content: [toolUse("s", "submit_plan", { title: "x", summary: "", stops: [{ place_id: stableId("place:Nope"), event_id: null, arrive: "10:00", leave: "11:00", travel_minutes: 0, why: "" }] })] }],
      [{ stop_reason: "end_turn", content: [{ type: "text", text: "Sure!" }] }],
    ]) {
      const out: { type: string }[] = [];
      expect(await planTrip(repo, maya, request, (e) => out.push(e), clientFrom(turns).client)).toBeNull();
      expect(out.at(-1)).toMatchObject({ type: "error" });
    }
  });
});

describe("daily plan limit", () => {
  it("allows ten plans a day per person in demo mode, then says how long to wait", async () => {
    for (let i = 0; i < 10; i++) await repo.limits.consume(maya, "trip_plans");
    await expect(repo.limits.consume(maya, "trip_plans")).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Too many trip plans/) });
    await repo.limits.consume(jules, "trip_plans");
  });

  it("is the same limit in the database", async () => {
    const db = await createSeededDb();
    for (let i = 0; i < 10; i++) await queryAs(db, maya, "select public.check_rate_limit('trip_plans')");
    await expect(queryAs(db, maya, "select public.check_rate_limit('trip_plans')")).rejects.toThrow(/rate_limited:trip_plans/);
  });
});

describe("the route", () => {
  it("does not exist unless the flag and the API key are both set", async () => {
    vi.doMock("@/lib/auth/server", () => ({ getViewer: async () => ({ id: maya }) }));
    const { POST } = await import("../src/app/api/trip-plan/route");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "tripPlanning");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect((await POST(new Request("http://x/api/trip-plan", { method: "POST", body: "{}" }))).status).toBe(404);
    vi.unstubAllEnvs();
  });
});
