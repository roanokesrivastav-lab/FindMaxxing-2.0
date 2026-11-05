/**
 * Richer saves (roadmap 3.1, migration 0062). Why you saved a place: a private
 * note, personal tags, a source URL, who recommended it, and want-to-go /
 * visited. Owner-only, always. What the place *is* (category, hours, tips) stays
 * community information and is never mixed into these fields.
 */
import { DataError } from "@/lib/data/types";
import { getInterest } from "@/lib/data/taxonomy";

export const SAVE_STATUSES = ["want_to_go", "visited"] as const;
export type SaveStatus = (typeof SAVE_STATUSES)[number];
export const SAVE_STATUS_LABEL: Record<SaveStatus, string> = { want_to_go: "Want to go", visited: "Visited" };

export const SAVE_NOTE_MAX = 500;
export const SAVE_TAG_MAX = 24;
export const SAVE_TAGS_MAX = 10;
export const SAVE_URL_MAX = 500;
export const SAVE_RECOMMENDED_MAX = 80;
export const TAG_SUGGESTIONS = 6;

export interface SaveDetails {
  placeId: string;
  note: string | null;
  tags: string[];
  sourceUrl: string | null;
  recommendedBy: string | null;
  status: SaveStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SaveDetailsInput {
  note?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  recommendedBy?: string | null;
  status?: SaveStatus;
}

export const normalizeTag = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** Validates a partial update; only the fields present are returned. Mirrors 0062's checks and trigger. */
export function normalizeSaveInput(input: SaveDetailsInput): SaveDetailsInput {
  const out: SaveDetailsInput = {};
  if ("note" in input) {
    const note = (input.note ?? "").trim();
    if (note.length > SAVE_NOTE_MAX) throw new DataError(`Keep the note under ${SAVE_NOTE_MAX} characters`, "invalid");
    out.note = note || null;
  }
  if ("tags" in input) {
    const tags: string[] = [];
    for (const raw of input.tags ?? []) {
      const t = normalizeTag(raw);
      if (!t) continue;
      if (t.length > SAVE_TAG_MAX) throw new DataError(`Tags can be at most ${SAVE_TAG_MAX} characters`, "invalid");
      if (!tags.includes(t)) tags.push(t);
    }
    if (tags.length > SAVE_TAGS_MAX) throw new DataError(`At most ${SAVE_TAGS_MAX} tags`, "invalid");
    out.tags = tags;
  }
  if ("sourceUrl" in input) {
    const url = (input.sourceUrl ?? "").trim();
    if (url && (url.length > SAVE_URL_MAX || !/^https?:\/\/\S+$/i.test(url))) throw new DataError("The source must be a web link (http or https)", "invalid");
    out.sourceUrl = url || null;
  }
  if ("recommendedBy" in input) {
    const who = (input.recommendedBy ?? "").replace(/\s+/g, " ").trim();
    if (who.length > SAVE_RECOMMENDED_MAX) throw new DataError(`Keep it under ${SAVE_RECOMMENDED_MAX} characters`, "invalid");
    out.recommendedBy = who || null;
  }
  if ("status" in input) {
    if (!(SAVE_STATUSES as readonly string[]).includes(input.status as string)) throw new DataError("Unknown status", "invalid");
    out.status = input.status;
  }
  return out;
}

/**
 * Tag suggestions (3.1's recorded source): first the viewer's own most-used tags, then
 * the place's community interest tags (contributor-chosen, shown as their labels).
 * Nothing is generated; tags already on the save are skipped. Suggestions are never
 * required, and dismissing one changes nothing stored.
 */
export function suggestTags(myTags: { tag: string; count: number }[], placeInterestSlugs: string[], current: string[]): string[] {
  const have = new Set(current.map(normalizeTag));
  const out: string[] = [];
  const push = (t: string) => {
    const n = normalizeTag(t);
    if (n && n.length <= SAVE_TAG_MAX && !have.has(n) && !out.includes(n)) out.push(n);
  };
  [...myTags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).forEach((t) => push(t.tag));
  placeInterestSlugs.forEach((slug) => push(getInterest(slug).label));
  return out.slice(0, TAG_SUGGESTIONS);
}

/** Counts each tag across the owner's saves, most used first. */
export function countTags(saves: { tags: string[] }[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of saves) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
