import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { DataRepository } from "@/lib/data/repository";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { discoveryDistance } from "@/lib/data/discovery";

/**
 * The trip planner's tools. All read-only, and every one runs as the signed-in
 * viewer: the viewer id comes from the server session, never from the model,
 * and each read goes through the repository, so RLS (or the demo store's
 * mirror of it) decides what the model can see. Nobody else's saves, lists or
 * private places can reach it.
 */
const point = { type: "object", properties: { lat: { type: "number" }, lng: { type: "number" } }, required: ["lat", "lng"], additionalProperties: false } as const;
const nullablePoint = { anyOf: [point, { type: "null" }] } as const;

export const TRIP_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_places",
    description: "Search FindMaxxing places the person can see. Matches names, descriptions, local tips, neighborhoods, categories and interests. Returns up to 10, nearest first when `near` is given.",
    input_schema: { type: "object", properties: { query: { type: "string" }, near: nullablePoint }, required: ["query", "near"], additionalProperties: false },
    strict: true,
  },
  {
    name: "get_place",
    description: "Details of one place by id: description, local tip, address, tags, rating, and its upcoming events.",
    input_schema: { type: "object", properties: { place_id: { type: "string" } }, required: ["place_id"], additionalProperties: false },
    strict: true,
  },
  {
    name: "upcoming_events",
    description: "Events the person can see that start inside a time window (ISO 8601 timestamps), optionally matching text. Up to 15, soonest first.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, query: { type: ["string", "null"] } }, required: ["from", "to", "query"], additionalProperties: false },
    strict: true,
  },
  {
    name: "my_saved",
    description: "The person's own saved places and the names of their lists. Prefer these when they fit.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "distance",
    description: "Distance between two points in metres, with rough walking and driving minutes.",
    input_schema: { type: "object", properties: { from: point, to: point }, required: ["from", "to"], additionalProperties: false },
    strict: true,
  },
  {
    name: "submit_plan",
    description: "Submit the finished itinerary. Call exactly once, at the end. Every stop must be a place_id or event_id returned by the other tools.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        stops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              place_id: { type: ["string", "null"] },
              event_id: { type: ["string", "null"] },
              arrive: { type: "string", description: "Local time, HH:MM" },
              leave: { type: "string", description: "Local time, HH:MM" },
              travel_minutes: { type: "integer", description: "From the previous stop (0 for the first)" },
              why: { type: "string" },
            },
            required: ["place_id", "event_id", "arrive", "leave", "travel_minutes", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "summary", "stops"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const inputs = {
  search_places: z.object({ query: z.string().max(80), near: latLng.nullable() }),
  get_place: z.object({ place_id: z.string().uuid() }),
  upcoming_events: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), query: z.string().max(80).nullable() }),
  my_saved: z.object({}),
  distance: z.object({ from: latLng, to: latLng }),
};
export type ReadToolName = keyof typeof inputs;

/** Runs one read-only tool as the viewer. Bad input comes back as an error result, never a throw. */
export async function runTripTool(repo: DataRepository, viewerId: string, name: string, raw: unknown): Promise<{ content: string; isError: boolean }> {
  if (!(name in inputs)) return { content: `Unknown tool ${name}`, isError: true };
  const parsed = inputs[name as ReadToolName].safeParse(raw);
  if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues[0]?.message ?? "bad input"}`, isError: true };
  const input = parsed.data as never;
  const json = (value: unknown) => ({ content: JSON.stringify(value), isError: false });
  try {
    switch (name as ReadToolName) {
      case "search_places": {
        const { query, near } = input as z.infer<typeof inputs.search_places>;
        const page = await repo.places.search({ text: query, near, limit: 10, viewerId });
        return json(page.items.map((p) => ({
          id: p.id, name: p.name, category: getCategory(p.categorySlug).label, neighborhood: p.neighborhood,
          lat: p.lat, lng: p.lng, rating: p.ratingCount ? p.ratingAvg : null, localTip: p.localTip,
          ...(near ? { metres: Math.round(discoveryDistance(p, near)) } : {}),
        })));
      }
      case "get_place": {
        const { place_id } = input as z.infer<typeof inputs.get_place>;
        const p = await repo.places.get(place_id, viewerId);
        if (!p) return { content: "No such place (or not visible to this person)", isError: true };
        // The place is visible, so its events are too (they inherit its visibility).
        const events = (await repo.events.listForPlace(p.id)).slice(0, 5);
        return json({
          id: p.id, name: p.name, description: p.description, localTip: p.localTip, address: p.address, neighborhood: p.neighborhood,
          lat: p.lat, lng: p.lng, category: getCategory(p.categorySlug).label, tags: p.tags.map((t) => getInterest(t).label),
          rating: p.ratingCount ? { average: p.ratingAvg, count: p.ratingCount } : null,
          upcomingEvents: events.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt })),
        });
      }
      case "upcoming_events": {
        const { from, to, query } = input as z.infer<typeof inputs.upcoming_events>;
        const page = await repo.events.search({ text: query, startsBefore: to, limit: 50, viewerId });
        const fromMs = new Date(from).getTime();
        return json(page.items.filter((e) => new Date(e.startsAt).getTime() >= fromMs).slice(0, 15).map((e) => ({
          id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, location: e.locationName, placeId: e.placeId,
          lat: e.lat, lng: e.lng, category: getCategory(e.categorySlug).label, going: e.attendeeCount, capacity: e.capacity,
        })));
      }
      case "my_saved": {
        const [saved, lists] = await Promise.all([repo.places.listSaved(viewerId), repo.savedLists.list(viewerId)]);
        return json({
          saved: saved.slice(0, 50).map((p) => ({ id: p.id, name: p.name, category: getCategory(p.categorySlug).label, neighborhood: p.neighborhood, lat: p.lat, lng: p.lng })),
          lists: lists.map((l) => l.name),
        });
      }
      case "distance": {
        const { from, to } = input as z.infer<typeof inputs.distance>;
        const metres = discoveryDistance(to, from);
        // Rough: 80 m/min walking, 400 m/min driving in town, both with a small fixed overhead.
        return json({ metres: Math.round(metres), walkingMinutes: Math.round(metres / 80) + 1, drivingMinutes: Math.round(metres / 400) + 3 });
      }
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : "Tool failed", isError: true };
  }
  return { content: "Unknown tool", isError: true };
}
