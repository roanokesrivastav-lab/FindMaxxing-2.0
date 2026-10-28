/**
 * Diversity for the "For you" rails (docs/recommendations-plan-claude.md §6):
 * maximal marginal relevance over the scored list, so twelve cards are not
 * twelve versions of one place, with hard caps per category and per creator.
 *
 * Each pick maximizes  λ·relevance − (1 − λ)·(similarity to the closest card
 * already picked), where relevance is the score over the best score and
 * similarity is 1 for the same category plus half the tags' Jaccard overlap.
 * A card over a cap is skipped, not moved down, so a rail can come back
 * shorter than asked when the candidates are that narrow.
 *
 * Served defaults: at most 3 per category, and no similarity penalty or
 * creator cap yet (λ = 1, perCreator = Infinity). On the demo dataset the
 * category cap alone beat rules-v1 (places recall@12 3/7, NDCG 0.178 vs
 * 0.174), while λ = 0.7 or two per creator dropped a held-out save (2/7,
 * 0.152 / 0.138): that person's next save was the fourth place by one
 * creator in one category. Seven held-out saves is too little to settle it;
 * re-run `npx tsx scripts/recs/eval.ts` on real data before switching them on.
 *
 * Pure and framework-free: the offline evaluation (scripts/recs/eval.ts)
 * runs the same code.
 */
export interface DiversityView {
  category: string;
  tags: string[];
  creatorId: string | null;
  score: number;
}

export interface DiversifyOptions {
  k?: number;
  lambda?: number;
  perCategory?: number;
  perCreator?: number;
}

export const DIVERSITY_DEFAULTS: Required<DiversifyOptions> = { k: 12, lambda: 1, perCategory: 3, perCreator: Infinity };
/** The plan's full setting (§6), for evaluation until real data supports it. */
export const DIVERSITY_PLANNED: Required<DiversifyOptions> = { k: 12, lambda: 0.7, perCategory: 3, perCreator: 2 };

export function similarity(a: DiversityView, b: DiversityView): number {
  const tagsA = new Set(a.tags);
  const shared = b.tags.filter((t) => tagsA.has(t)).length;
  const union = new Set([...a.tags, ...b.tags]).size;
  return (a.category === b.category ? 1 : 0) + 0.5 * (union ? shared / union : 0);
}

export function diversify<T>(items: T[], view: (item: T) => DiversityView, opts: DiversifyOptions = {}): T[] {
  const { k, lambda, perCategory, perCreator } = { ...DIVERSITY_DEFAULTS, ...opts };
  const views = items.map(view);
  const best = Math.max(0, ...views.map((v) => v.score));
  const relevance = views.map((v) => (best > 0 ? v.score / best : 0));
  const picked: number[] = [];
  const categories = new Map<string, number>();
  const creators = new Map<string, number>();
  const left = new Set(items.map((_, i) => i));
  while (picked.length < k && left.size) {
    let choice = -1;
    let value = -Infinity;
    for (const i of left) {
      const v = views[i];
      if ((categories.get(v.category) ?? 0) >= perCategory) continue;
      if (v.creatorId && (creators.get(v.creatorId) ?? 0) >= perCreator) continue;
      const closest = picked.reduce((max, j) => Math.max(max, similarity(v, views[j])), 0);
      const mmr = lambda * relevance[i] - (1 - lambda) * closest;
      // Ties keep the incoming (score) order.
      if (mmr > value) {
        value = mmr;
        choice = i;
      }
    }
    if (choice < 0) break;
    picked.push(choice);
    left.delete(choice);
    const v = views[choice];
    categories.set(v.category, (categories.get(v.category) ?? 0) + 1);
    if (v.creatorId) creators.set(v.creatorId, (creators.get(v.creatorId) ?? 0) + 1);
  }
  return picked.map((i) => items[i]);
}
