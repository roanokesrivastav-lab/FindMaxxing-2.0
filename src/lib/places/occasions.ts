/**
 * Best for / less suited for (roadmap 2.7, migration 0061). Contributor-written,
 * attributed occasion notes. Nothing here generates or aggregates an opinion:
 * the page shows individual notes, a few at a time, with "see all".
 */
import type { ProfileSummary } from "@/lib/data/types";
import { DataError } from "@/lib/data/types";

/** Mirrors the check constraint in 0061_place_occasions.sql. */
export const OCCASIONS = ["date", "big-group", "conversation", "solo-work", "kids", "quick-bite", "late-night", "first-visit"] as const;
export type Occasion = (typeof OCCASIONS)[number];
export const OCCASION_LABEL: Record<Occasion, string> = {
  date: "A relaxed date",
  "big-group": "A big group",
  conversation: "Talking over a drink",
  "solo-work": "Working solo",
  kids: "Bringing kids",
  "quick-bite": "A quick bite",
  "late-night": "Late night",
  "first-visit": "A first visit to the area",
};
export type Polarity = "best" | "less";
export const OCCASION_NOTE_MAX = 140;
/** How many notes per side show before "See all". */
export const OCCASIONS_SHOWN = 2;

export interface OccasionNote {
  id: string;
  placeId: string;
  polarity: Polarity;
  occasion: Occasion;
  note: string | null;
  status: "published" | "hidden" | "removed";
  author: ProfileSummary | null;
  createdAt: string;
}

export interface OccasionInput {
  polarity: Polarity;
  occasion: Occasion;
  note?: string | null;
}

export function normalizeOccasionInput(input: OccasionInput): { polarity: Polarity; occasion: Occasion; note: string | null } {
  if (input.polarity !== "best" && input.polarity !== "less") throw new DataError("Choose best for or less suited", "invalid");
  if (!(OCCASIONS as readonly string[]).includes(input.occasion)) throw new DataError("Choose an occasion from the list", "invalid");
  const note = (input.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length > OCCASION_NOTE_MAX) throw new DataError(`Keep the note under ${OCCASION_NOTE_MAX} characters`, "invalid");
  return { polarity: input.polarity, occasion: input.occasion, note: note || null };
}

/** People the viewer follows first (their own notes, unsummarized), then newest. */
export function orderOccasionNotes(notes: OccasionNote[], followingIds: Iterable<string> = []): OccasionNote[] {
  const following = new Set(followingIds);
  const rank = (n: OccasionNote) => (n.author && following.has(n.author.id) ? 0 : 1);
  return [...notes].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : 1));
}

/** "Good for a relaxed date" / "Less suited for a big group". */
export function occasionSentence(n: Pick<OccasionNote, "polarity" | "occasion">): string {
  const label = OCCASION_LABEL[n.occasion];
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return n.polarity === "best" ? `Good for ${lower}` : `Less suited for ${lower}`;
}

/** Seeded notes, applied by the SQL seed and the demo store alike, so demo mode shows the block. */
export const SEED_OCCASION_NOTES: { place: string; user: string; polarity: Polarity; occasion: Occasion; note: string | null }[] = [
  { place: "Cannon & Crown", user: "marcus", polarity: "best", occasion: "big-group", note: "Long tables, and they take groups on game days." },
  { place: "Cannon & Crown", user: "jules", polarity: "less", occasion: "conversation", note: "Too loud to talk once a game starts." },
  { place: "Meeple Cellar", user: "maya_r", polarity: "best", occasion: "date", note: "Pick a two-player game and stay for hours." },
];
