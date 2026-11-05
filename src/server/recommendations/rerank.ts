import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Place, Recommendation } from "@/lib/data/types";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { reportError } from "@/lib/observability";

/**
 * Optional AI rerank of the rule-based "For you" shortlist. With
 * ANTHROPIC_API_KEY and the aiRerank flag, Claude reorders the candidates
 * and rewrites the "why" lines; on any failure (no key, timeout, API error,
 * malformed or out-of-set answer) the rule-based order stands.
 *
 * What it sends: the viewer's own interests and the names of places they
 * saved (their data), and each candidate's public fields. Nothing about
 * anyone else: no usernames, no other people's saves or ratings.
 */
export const RERANK_MODEL = process.env.RECOMMENDATIONS_MODEL || "claude-sonnet-5";
export const RERANK_TIMEOUT_MS = 4000;
const MAX_CANDIDATES = 20;

// Static, so it caches across requests (the volatile part goes in the user turn).
const SYSTEM = `You rank local places for one person using FindMaxxing, a map of places that locals add for each other.
You get their interests, places they already saved, and candidate places with public details and the rule-based reason each was suggested.
Order the candidates from best to worst fit for this person and write one short reason for each (at most 90 characters, plain words, second person, no emoji).
Prefer genuine local knowledge and lesser-known places over the most popular ones. Use only the ids you are given; include every id exactly once.`;

const RerankSchema = z.object({
  order: z.array(z.object({ id: z.string(), why: z.string() })),
});

export interface RerankViewer {
  interests: string[];
  savedPlaceNames: string[];
}

/** The candidate fields Claude sees: public listing details only. */
export function candidatePayload(recs: Recommendation<Place>[]) {
  return recs.slice(0, MAX_CANDIDATES).map((r) => ({
    id: r.item.id,
    name: r.item.name,
    category: getCategory(r.item.categorySlug).label,
    neighborhood: r.item.neighborhood,
    tags: r.item.tags.map((t) => getInterest(t).label),
    localTip: r.item.localTip,
    rating: r.item.ratingCount ? { average: r.item.ratingAvg, count: r.item.ratingCount } : null,
    suggestedBecause: r.reason.kind,
  }));
}

type MessagesClient = Pick<Anthropic, "messages">;

export async function rerankPlaces(
  recs: Recommendation<Place>[],
  viewer: RerankViewer,
  client: MessagesClient = new Anthropic({ maxRetries: 0, timeout: RERANK_TIMEOUT_MS }),
): Promise<Recommendation<Place>[]> {
  if (recs.length < 2) return recs;
  const candidates = candidatePayload(recs);
  try {
    const response = await client.messages.parse(
      {
        model: RERANK_MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        output_config: { effort: "low", format: zodOutputFormat(RerankSchema) },
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              interests: viewer.interests.map((i) => getInterest(i).label),
              alreadySaved: viewer.savedPlaceNames.slice(0, 20),
              candidates,
            }),
          },
        ],
      },
      { timeout: RERANK_TIMEOUT_MS },
    );
    if (response.stop_reason === "refusal" || !response.parsed_output) return recs;
    return applyOrder(recs, response.parsed_output.order);
  } catch (err) {
    reportError(err, { where: "recommendations:rerank" });
    return recs;
  }
}

/**
 * Applies Claude's order, trusting nothing: unknown and repeated ids are
 * dropped, anything it left out keeps its rule-based place after the rest,
 * and reasons are trimmed and capped. Only places already in the shortlist
 * (all checked for visibility) can come back.
 */
export function applyOrder(recs: Recommendation<Place>[], order: { id: string; why: string }[]): Recommendation<Place>[] {
  const byId = new Map(recs.map((r) => [r.item.id, r]));
  const seen = new Set<string>();
  const out: Recommendation<Place>[] = [];
  for (const { id, why } of order) {
    const rec = byId.get(id);
    if (!rec || seen.has(id)) continue;
    seen.add(id);
    const text = why.replace(/\s+/g, " ").trim().slice(0, 120);
    out.push({ ...rec, reason: { ...rec.reason, kind: "ai", text: text || rec.reason.text } });
  }
  for (const rec of recs) if (!seen.has(rec.item.id)) out.push(rec);
  return out;
}
