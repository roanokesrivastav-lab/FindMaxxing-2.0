/**
 * "Pick somewhere from my saves" (roadmap 3.6). Recorded pick method: a uniformly
 * random choice among the owner's saves matching the 3.2 filters, never repeating a
 * place already shown this round until every match has been shown. Random is honest
 * (no claim that the app knows best) and works with no location or hours data.
 * Nothing about the place is generated.
 */
import { filterLibrary, hasFilters, type LibraryFilters, type LibraryItem } from "./library";
import { getCategory } from "@/lib/data/taxonomy";
import { SAVE_STATUS_LABEL } from "./saves";

export interface Widening {
  label: string;
  filters: LibraryFilters;
  count: number;
}

export type PickResult =
  | { kind: "picked"; item: LibraryItem; matches: number; round: string[] }
  | { kind: "none"; widening: Widening | null }
  | { kind: "empty" };

/** One specific widening when nothing matches: drop a single filter, most specific first. */
export function widenOnce(items: LibraryItem[], f: LibraryFilters): Widening | null {
  const options: { label: string; filters: LibraryFilters }[] = [];
  if (f.tag) options.push({ label: `without the tag “${f.tag}”`, filters: { ...f, tag: null } });
  if (f.q) options.push({ label: `without the search “${f.q}”`, filters: { ...f, q: "" } });
  if (f.category) options.push({ label: `in any category, not just ${getCategory(f.category).label}`, filters: { ...f, category: null } });
  if (f.status) options.push({ label: `including ${f.status === "visited" ? SAVE_STATUS_LABEL.want_to_go : SAVE_STATUS_LABEL.visited} places`, filters: { ...f, status: null } });
  for (const o of options) {
    const count = filterLibrary(items, o.filters).length;
    if (count) return { ...o, count };
  }
  return null;
}

export function pickOne(items: LibraryItem[], f: LibraryFilters, shown: string[], random: () => number = Math.random): PickResult {
  if (!items.length) return { kind: "empty" };
  const matches = filterLibrary(items, f);
  if (!matches.length) return { kind: "none", widening: hasFilters(f) ? widenOnce(items, f) : null };
  const seen = new Set(shown);
  let pool = matches.filter((i) => !seen.has(i.place.id));
  let round = shown.filter((id) => matches.some((m) => m.place.id === id));
  if (!pool.length) {
    // Everything has been shown: start a new round, but not with the place just shown.
    const last = shown[shown.length - 1];
    pool = matches.length > 1 ? matches.filter((i) => i.place.id !== last) : matches;
    round = [];
  }
  const item = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return { kind: "picked", item, matches: matches.length, round: [...round, item.place.id] };
}
