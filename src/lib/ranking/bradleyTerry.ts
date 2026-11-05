/**
 * Per-category place scores from head-to-head "which did you prefer" answers
 * (docs/recommendations-plan-claude.md, stage 1b). Bradley-Terry with a
 * Gaussian prior centred on the star rating: a place rated s stars starts at
 * strength s - 3, and comparisons move it from there. Fitted by a fixed number
 * of synchronous gradient steps, so the result does not depend on the order of
 * the comparisons.
 *
 * SQL twin: fit_user_category_scores() in 0037_place_comparisons.sql. Keep the
 * constants and arithmetic identical; tests/place-comparisons.test.ts checks
 * the two agree.
 */
export const BT_ITERATIONS = 100;
export const BT_STEP = 0.1;
/** The SQL function reads at most this many of a person's newest comparisons per category. */
export const BT_MAX_COMPARISONS = 500;

export interface RatedItem { id: string; stars: number }
export interface Comparison { winnerId: string; loserId: string }

/**
 * Strength (log-odds scale) per item id; comparisons naming an item outside
 * `items` are ignored. With no comparisons it is exactly stars - 3, the flat
 * rating weight rules-v2 taste used before comparisons existed.
 */
export function fitStrengths(items: RatedItem[], comparisons: Comparison[]): Map<string, number> {
  const index = new Map(items.map((item, i) => [item.id, i]));
  const mu = items.map((item) => item.stars - 3);
  const pairs: [number, number][] = [];
  for (const c of comparisons) {
    const w = index.get(c.winnerId);
    const l = index.get(c.loserId);
    if (w !== undefined && l !== undefined && w !== l) pairs.push([w, l]);
  }
  let theta = mu.slice();
  for (let step = 0; step < BT_ITERATIONS; step++) {
    const grad = theta.map((t, i) => mu[i] - t);
    for (const [w, l] of pairs) {
      const lost = 1 / (1 + Math.exp(theta[l] - theta[w]));
      grad[w] += 1 - lost;
      grad[l] -= 1 - lost;
    }
    theta = theta.map((t, i) => t + BT_STEP * grad[i]);
  }
  return new Map(items.map((item, i) => [item.id, theta[i]]));
}

/** Score on a 0-10 scale per item id: the strengths through a logistic curve. */
export function fitScores(items: RatedItem[], comparisons: Comparison[]): Map<string, number> {
  return new Map([...fitStrengths(items, comparisons)].map(([id, theta]) => [id, 10 / (1 + Math.exp(-theta))]));
}
