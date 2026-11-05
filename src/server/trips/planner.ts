import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { DataRepository } from "@/lib/data/repository";
import { getInterest } from "@/lib/data/taxonomy";
import { reportError } from "@/lib/observability";
import { TRIP_TOOLS, runTripTool } from "./tools";

/**
 * "Plan my day": a server-side Claude agent that builds an itinerary from
 * places and events the person can see, preferring what they saved. It only
 * reads (see ./tools), is capped in tool calls and wall-clock time, and every
 * stop it proposes is re-checked against the repository before it is shown:
 * a made-up or invisible id is dropped, never displayed.
 */
export const TRIP_MODEL = process.env.TRIP_PLANNER_MODEL || "claude-opus-5-5";
export const MAX_TOOL_ROUNDS = 10;
export const PLAN_TIMEOUT_MS = 90_000;

export interface TripRequest {
  /** ISO timestamps for the window. */
  start: string;
  end: string;
  /** Free text: "chill, outdoorsy, good coffee". */
  vibe: string;
  interests: string[];
  budget: "free" | "low" | "medium" | "high";
  startPoint: { lat: number; lng: number; label: string };
}

export interface PlanStop {
  kind: "place" | "event";
  id: string;
  name: string;
  lat: number;
  lng: number;
  arrive: string;
  leave: string;
  travelMinutes: number;
  why: string;
}

export interface TripPlan {
  title: string;
  summary: string;
  stops: PlanStop[];
  /** Stops Claude proposed that did not check out (unknown, invisible, or repeated). */
  dropped: number;
}

export type PlanEvent =
  | { type: "status"; text: string }
  | { type: "plan"; plan: TripPlan }
  | { type: "error"; message: string };

const SYSTEM = `You plan outings in FindMaxxing, a map of places and events that locals add for each other.
Build a realistic itinerary for the person's time window from places and events you find with the tools.
Prefer places they saved, then genuine local finds; do not pad the plan. Order stops so travel is short, leave travel time between them, respect event start times and the budget, and fit everything inside the window.
Use only ids returned by the tools; never invent a place. When the plan is ready, call submit_plan exactly once. Each "why" is one short sentence to the person.`;

const STATUS: Record<string, string> = {
  search_places: "Searching places",
  get_place: "Checking a place",
  upcoming_events: "Looking at events",
  my_saved: "Looking at your saved places",
  distance: "Working out travel times",
};

type StreamingClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "stream"> } };

export async function planTrip(
  repo: DataRepository,
  viewerId: string,
  request: TripRequest,
  onEvent: (e: PlanEvent) => void,
  client: StreamingClient = new Anthropic({ maxRetries: 1 }),
): Promise<TripPlan | null> {
  const deadline = AbortSignal.timeout(PLAN_TIMEOUT_MS);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: JSON.stringify({
        window: { start: request.start, end: request.end, timeZone: "America/New_York" },
        vibe: request.vibe.slice(0, 300),
        interests: request.interests.map((i) => getInterest(i).label),
        budget: request.budget,
        startingPoint: request.startPoint,
      }),
    },
  ];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = client.beta.messages.stream(
        {
          model: TRIP_MODEL,
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools: TRIP_TOOLS,
          output_config: { effort: "medium" },
          // Refusal fallback: a policy decline is re-run server-side on Anthropic's recommended model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages,
        } as Anthropic.Beta.MessageCreateParamsStreaming,
        { signal: deadline },
      );
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        onEvent({ type: "error", message: "We couldn't plan that one. Try describing it differently." });
        return null;
      }
      messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      const uses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const submit = uses.find((u) => u.name === "submit_plan");
      if (submit) {
        const plan = await validatePlan(repo, viewerId, submit.input);
        if (!plan.stops.length) {
          onEvent({ type: "error", message: "The plan didn't hold up: none of its stops checked out. Try again." });
          return null;
        }
        onEvent({ type: "plan", plan });
        return plan;
      }
      if (!uses.length) {
        onEvent({ type: "error", message: "No plan came back. Try a different time or vibe." });
        return null;
      }
      // All results for this turn go back in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        onEvent({ type: "status", text: STATUS[use.name] ?? "Thinking" });
        const r = await runTripTool(repo, viewerId, use.name, use.input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: r.content, is_error: r.isError });
      }
      messages.push({ role: "user", content: results });
    }
    onEvent({ type: "error", message: "Planning took too many steps. Try a shorter window." });
    return null;
  } catch (err) {
    reportError(err, { where: "trip-planner" });
    onEvent({ type: "error", message: deadline.aborted ? "Planning took too long. Try again." : "Planning failed. Try again in a moment." });
    return null;
  }
}

/**
 * Turns submit_plan's input into stops that exist and that this person can
 * see: each id is looked up through the repository as the viewer. Unknown,
 * invisible, malformed and repeated stops are dropped and counted.
 */
export async function validatePlan(repo: DataRepository, viewerId: string, raw: unknown): Promise<TripPlan> {
  const input = (raw ?? {}) as { title?: unknown; summary?: unknown; stops?: unknown };
  const stopsIn = Array.isArray(input.stops) ? input.stops.slice(0, 12) : [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const stops: PlanStop[] = [];
  const seen = new Set<string>();
  let dropped = Array.isArray(input.stops) ? Math.max(0, input.stops.length - 12) : 0;
  for (const s of stopsIn as Record<string, unknown>[]) {
    const placeId = typeof s?.place_id === "string" && uuid.test(s.place_id) ? s.place_id : null;
    const eventId = typeof s?.event_id === "string" && uuid.test(s.event_id) ? s.event_id : null;
    const id = eventId ?? placeId;
    const times = typeof s?.arrive === "string" && hhmm.test(s.arrive) && typeof s?.leave === "string" && hhmm.test(s.leave);
    if (!id || seen.has(id) || !times) {
      dropped += 1;
      continue;
    }
    const why = typeof s.why === "string" ? s.why.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const travel = Number.isInteger(s.travel_minutes) ? Math.min(Math.max(s.travel_minutes as number, 0), 240) : 0;
    if (eventId) {
      const e = await repo.events.get(eventId, viewerId);
      if (!e || e.status !== "published") { dropped += 1; continue; }
      stops.push({ kind: "event", id: e.id, name: e.title, lat: e.lat, lng: e.lng, arrive: s.arrive as string, leave: s.leave as string, travelMinutes: travel, why });
    } else {
      const p = await repo.places.get(placeId!, viewerId);
      if (!p || p.status !== "published") { dropped += 1; continue; }
      stops.push({ kind: "place", id: p.id, name: p.name, lat: p.lat, lng: p.lng, arrive: s.arrive as string, leave: s.leave as string, travelMinutes: travel, why });
    }
    seen.add(id);
  }
  const text = (v: unknown, max: number, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback);
  return { title: text(input.title, 80, "Your plan"), summary: text(input.summary, 400, ""), stops, dropped };
}
