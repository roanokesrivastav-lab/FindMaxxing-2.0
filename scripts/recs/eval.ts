/**
 * Offline evaluation of the "For you" recommender
 * (docs/recommendations-plan-claude.md §7, docs/recommendations-metrics.md).
 *
 * A time split per person: the last 20% of their saves (places) and joins
 * (events) are held out; everything they did from the first held-out moment
 * on is removed; then the recommender is replayed as of that moment, over
 * only the places and events that existed by then, and scored on whether it
 * would have shown what they went on to save or join. Metrics are recall@k
 * and NDCG@k, averaged over people, plus recall per category and for people
 * with fewer than five earlier actions.
 *
 * Policies: `rules-v1`, the rules alone (the SQL before 0035), and
 * `rules-v2`, the rules with the viewer's taste followed by the diversity
 * pass, which is what the app serves (src/server/recommendations). Both use
 * the demo twins, which the parity tests keep identical to the SQL.
 * Other people's activity is not rewound, so their later saves leak a little
 * popularity into the replay; with a few dozen people that is noise, not
 * signal, and it is the same for every policy compared.
 *
 *   npx tsx scripts/recs/eval.ts                 # the demo dataset
 *   npx tsx scripts/recs/eval.ts --state x.json  # a demo-store JSON (data/demo-store.json)
 *   npx tsx scripts/recs/eval.ts --k 20 --json --policy rules-v2
 *
 * Staging/production need a service-role export in the demo-store shape;
 * that exporter does not exist yet.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createIsolatedStore, migrateDemoState, type DemoState } from "../../src/lib/data/demo/store";
import { canViewEvent, canViewPlace } from "../../src/lib/data/demo/repository";
import { demoTaste, recommendDemoEvents, recommendDemoPlaces } from "../../src/lib/data/demo/recommend";
import { diversify, type DiversifyOptions } from "../../src/server/recommendations/diversify";

export const POLICIES = ["rules-v1", "rules-v2"] as const;
export type Policy = (typeof POLICIES)[number];
/** What rules-v2 diversifies from, as the app does. */
const POOL = 50;
/** Fewer earlier actions than this counts as a sparse (cold-ish) profile. */
export const SPARSE_ACTIONS = 5;

export interface Metrics {
  /** People with at least one held-out item. */
  people: number;
  heldOut: number;
  hits: number;
  recall: number;
  ndcg: number;
}

export interface EvalReport {
  policy: Policy;
  k: number;
  holdout: number;
  places: Metrics & { byCategory: Record<string, { heldOut: number; hits: number; recall: number }>; sparse: Metrics };
  events: Metrics & { sparse: Metrics };
}

type Kind = "place" | "event";
interface Case { userId: string; splitAt: number; heldOut: string[]; ranked: string[]; earlierActions: number }

/** The fraction of each person's positives held out, rounded up, never all of them. */
export function holdoutCount(n: number, fraction: number): number {
  if (n < 2) return 0;
  return Math.min(n - 1, Math.max(1, Math.ceil(n * fraction)));
}

/** NDCG@k for binary relevance: hits discounted by rank, over the best possible order. */
export function ndcgAt(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => { if (relevant.has(id)) dcg += 1 / Math.log2(i + 2); });
  let ideal = 0;
  for (let i = 0; i < Math.min(relevant.size, k); i++) ideal += 1 / Math.log2(i + 2);
  return ideal ? dcg / ideal : 0;
}

/**
 * The state as the person had left it just before `splitAt`: their saves,
 * ratings, joins, follows and logged interactions from then on are gone.
 */
export function rewindPerson(state: DemoState, userId: string, splitAt: number): DemoState {
  const before = (iso: string) => Date.parse(iso) < splitAt;
  const mine = <T extends { userId: string }>(rows: T[], at: (r: T) => string) => rows.filter((r) => r.userId !== userId || before(at(r)));
  return {
    ...state,
    savedPlaces: mine(state.savedPlaces, (r) => r.createdAt),
    placeRatings: mine(state.placeRatings, (r) => r.updatedAt),
    eventAttendees: mine(state.eventAttendees, (r) => r.createdAt),
    userInteractions: mine(state.userInteractions, (r) => r.createdAt),
    follows: state.follows.filter((f) => f.followerId !== userId || before(f.createdAt)),
  };
}

function earlierActions(state: DemoState, userId: string): number {
  return state.savedPlaces.filter((s) => s.userId === userId).length
    + state.placeRatings.filter((r) => r.userId === userId).length
    + state.eventAttendees.filter((a) => a.userId === userId).length;
}

function rank(past: DemoState, userId: string, kind: Kind, k: number, splitAt: number, policy: Policy, diversity: DiversifyOptions): string[] {
  const existed = (iso: string) => Date.parse(iso) <= splitAt;
  const placeOk = (p: DemoState["places"][number]) => existed(p.createdAt) && canViewPlace(past, p, userId);
  const eventOk = (e: DemoState["events"][number]) => existed(e.createdAt) && canViewEvent(past, e, userId);
  if (policy === "rules-v1") {
    return kind === "place"
      ? recommendDemoPlaces(past, userId, placeOk, null, k, splitAt).map((r) => r.place.id)
      : recommendDemoEvents(past, userId, eventOk, null, k, splitAt).map((r) => r.event.id);
  }
  const tagsOf = (rows: { interestSlug: string }[]) => rows.map((t) => t.interestSlug);
  if (kind === "place") {
    const taste = demoTaste(past, userId, placeOk, eventOk, splitAt);
    const pool = recommendDemoPlaces(past, userId, placeOk, null, POOL, splitAt, taste);
    return diversify(pool, (r) => ({ category: r.place.categorySlug, tags: tagsOf(past.placeTags.filter((t) => t.placeId === r.place.id)), creatorId: r.place.creatorId, score: r.score }), { ...diversity, k })
      .map((r) => r.place.id);
  }
  const pool = recommendDemoEvents(past, userId, eventOk, null, POOL, splitAt);
  return diversify(pool, (r) => ({ category: r.event.categorySlug, tags: tagsOf(past.eventTags.filter((t) => t.eventId === r.event.id)), creatorId: r.event.creatorId, score: r.score }), { ...diversity, k })
    .map((r) => r.event.id);
}

function cases(state: DemoState, kind: Kind, k: number, holdout: number, policy: Policy, diversity: DiversifyOptions): Case[] {
  const positives = kind === "place"
    ? state.savedPlaces.map((s) => ({ userId: s.userId, itemId: s.placeId, at: s.createdAt }))
    // Hosts are attendees of their own events; that is not a choice to go.
    : state.eventAttendees.filter((a) => state.events.find((e) => e.id === a.eventId)?.creatorId !== a.userId)
        .map((a) => ({ userId: a.userId, itemId: a.eventId, at: a.createdAt }));
  const out: Case[] = [];
  for (const profile of state.profiles) {
    const mine = positives.filter((p) => p.userId === profile.id).sort((a, b) => a.at.localeCompare(b.at) || a.itemId.localeCompare(b.itemId));
    const n = holdoutCount(mine.length, holdout);
    if (!n) continue;
    const held = mine.slice(mine.length - n);
    const splitAt = Date.parse(held[0].at);
    const past = rewindPerson(state, profile.id, splitAt);
    const ranked = rank(past, profile.id, kind, k, splitAt, policy, diversity);
    out.push({ userId: profile.id, splitAt, heldOut: held.map((h) => h.itemId), ranked, earlierActions: earlierActions(past, profile.id) });
  }
  return out;
}

function summarize(list: Case[], k: number): Metrics {
  let heldOut = 0, hits = 0, recall = 0, ndcg = 0;
  for (const c of list) {
    const relevant = new Set(c.heldOut);
    const found = c.ranked.slice(0, k).filter((id) => relevant.has(id)).length;
    heldOut += relevant.size;
    hits += found;
    recall += found / relevant.size;
    ndcg += ndcgAt(c.ranked, relevant, k);
  }
  const people = list.length;
  return { people, heldOut, hits, recall: people ? recall / people : 0, ndcg: people ? ndcg / people : 0 };
}

/** `diversity` overrides the rules-v2 diversity pass, for tuning it. */
export function evaluate(state: DemoState, opts: { k?: number; holdout?: number; policy?: Policy; diversity?: DiversifyOptions } = {}): EvalReport {
  const k = opts.k ?? 12;
  const holdout = opts.holdout ?? 0.2;
  const policy = opts.policy ?? "rules-v2";
  const diversity = opts.diversity ?? {};
  const placeCases = cases(state, "place", k, holdout, policy, diversity);
  const eventCases = cases(state, "event", k, holdout, policy, diversity);
  const byCategory: EvalReport["places"]["byCategory"] = {};
  for (const c of placeCases) {
    const top = new Set(c.ranked.slice(0, k));
    for (const id of c.heldOut) {
      const cat = state.places.find((p) => p.id === id)?.categorySlug ?? "unknown";
      const row = (byCategory[cat] ??= { heldOut: 0, hits: 0, recall: 0 });
      row.heldOut++;
      if (top.has(id)) row.hits++;
    }
  }
  for (const row of Object.values(byCategory)) row.recall = row.hits / row.heldOut;
  const sparse = (list: Case[]) => summarize(list.filter((c) => c.earlierActions < SPARSE_ACTIONS), k);
  return {
    policy,
    k,
    holdout,
    places: { ...summarize(placeCases, k), byCategory, sparse: sparse(placeCases) },
    events: { ...summarize(eventCases, k), sparse: sparse(eventCases) },
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function formatReport(r: EvalReport): string {
  const line = (label: string, m: Metrics) =>
    `  ${label.padEnd(14)} people ${String(m.people).padStart(3)}  held out ${String(m.heldOut).padStart(3)}  hits ${String(m.hits).padStart(3)}  recall@${r.k} ${pct(m.recall).padStart(6)}  NDCG@${r.k} ${m.ndcg.toFixed(3)}`;
  const out = [
    `Policy ${r.policy}, time split holding out the last ${pct(r.holdout)} per person`,
    "Places (saves)",
    line("all", r.places),
    line(`< ${SPARSE_ACTIONS} actions`, r.places.sparse),
    ...Object.entries(r.places.byCategory).sort(([a], [b]) => a.localeCompare(b))
      .map(([cat, m]) => `    ${cat.padEnd(16)} held out ${String(m.heldOut).padStart(3)}  hits ${String(m.hits).padStart(3)}  recall ${pct(m.recall)}`),
    "Events (joins)",
    line("all", r.events),
    line(`< ${SPARSE_ACTIONS} actions`, r.events.sparse),
  ];
  return out.join("\n");
}

function loadState(file: string | null): DemoState {
  if (!file) return createIsolatedStore().state;
  const result = migrateDemoState(JSON.parse(readFileSync(file, "utf8")));
  if (!result.ok) throw new Error(`Not a usable demo-store file (${result.reason}): ${file}`);
  return result.state;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };
  const k = Number(value("--k") ?? 12);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error("--k must be an integer from 1 to 50");
  const asked = value("--policy");
  if (asked !== null && !(POLICIES as readonly string[]).includes(asked)) throw new Error(`--policy must be one of ${POLICIES.join(", ")}`);
  const state = loadState(value("--state"));
  const reports = (asked ? [asked as Policy] : [...POLICIES]).map((policy) => evaluate(state, { k, policy }));
  console.log(args.includes("--json") ? JSON.stringify(reports, null, 2) : reports.map(formatReport).join("\n\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
