/**
 * Demo twin of 0061_place_occasions.sql (roadmap 2.7). The collection is optional
 * on DemoState and created on first use (no store-version bump; see ./tips).
 */
import type { DataRepository } from "../repository";
import { DataError, type ProfileSummary } from "../types";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import { seedPlaceByName, seedUserByName } from "@/lib/seed/seed-data";
import { SEED_OCCASION_NOTES, normalizeOccasionInput, type Occasion, type OccasionNote, type Polarity } from "@/lib/places/occasions";
import { isModeratorIn, type DemoState, type PlaceRow } from "./store";

export interface OccasionNoteRow {
  id: string;
  placeId: string;
  authorId: string | null;
  polarity: Polarity;
  occasion: Occasion;
  note: string | null;
  status: OccasionNote["status"];
  createdAt: string;
  updatedAt: string;
}

export function ensureOccasions(state: DemoState): OccasionNoteRow[] {
  const s = state as DemoState & { placeOccasionNotes?: OccasionNoteRow[] };
  if (s.placeOccasionNotes) return s.placeOccasionNotes;
  const now = new Date().toISOString();
  s.placeOccasionNotes = SEED_OCCASION_NOTES.flatMap((n) => {
    const placeId = seedPlaceByName(n.place)?.id;
    const authorId = seedUserByName(n.user)?.id;
    if (!placeId || !authorId || !state.places.some((p) => p.id === placeId) || !state.profiles.some((p) => p.id === authorId)) return [];
    return [{ id: newId(), placeId, authorId, polarity: n.polarity, occasion: n.occasion, note: n.note, status: "published" as const, createdAt: now, updatedAt: now }];
  });
  return s.placeOccasionNotes;
}

export function createDemoOccasions(
  state: DemoState,
  h: {
    persist(): void;
    assertActive(userId: string): void;
    rateLimit(userId: string, action: RateLimitAction): () => void;
    canViewPlace(p: PlaceRow, viewerId: string | null): boolean;
    summary(id: string | null): ProfileSummary | null;
  },
): DataRepository["occasions"] {
  const placeOf = (id: string) => state.places.find((p) => p.id === id);
  const toNote = (r: OccasionNoteRow): OccasionNote => ({
    id: r.id, placeId: r.placeId, polarity: r.polarity, occasion: r.occasion, note: r.note, status: r.status,
    author: h.summary(r.authorId), createdAt: r.createdAt,
  });
  return {
    async list(placeId, viewerId = null) {
      const place = placeOf(placeId);
      if (!place || !h.canViewPlace(place, viewerId)) return [];
      return ensureOccasions(state)
        .filter((n) => n.placeId === placeId && n.status === "published")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(toNote);
    },
    async add(userId, placeId, input) {
      h.assertActive(userId);
      const place = placeOf(placeId);
      if (!place || !h.canViewPlace(place, userId)) throw new DataError("Place not found", "not_found");
      const clean = normalizeOccasionInput(input);
      const rows = ensureOccasions(state);
      const existing = rows.find((n) => n.placeId === placeId && n.authorId === userId && n.occasion === clean.occasion && n.polarity === clean.polarity);
      const now = new Date().toISOString();
      if (existing) {
        existing.note = clean.note;
        existing.updatedAt = now;
        h.persist();
        return toNote(existing);
      }
      const counted = h.rateLimit(userId, "occasion_notes");
      const row: OccasionNoteRow = { id: newId(), placeId, authorId: userId, ...clean, status: "published", createdAt: now, updatedAt: now };
      rows.push(row);
      counted();
      h.persist();
      return toNote(row);
    },
    async remove(userId, noteId) {
      h.assertActive(userId);
      const rows = ensureOccasions(state);
      const row = rows.find((n) => n.id === noteId);
      if (!row || row.authorId !== userId) throw new DataError("Note not found", "not_found");
      rows.splice(rows.indexOf(row), 1);
      h.persist();
    },
    async setStatus(moderatorId, noteId, status) {
      h.assertActive(moderatorId);
      if (!isModeratorIn(state, moderatorId)) throw new DataError("Moderators only", "forbidden");
      const row = ensureOccasions(state).find((n) => n.id === noteId);
      if (!row) throw new DataError("Note not found", "not_found");
      row.status = status;
      h.persist();
    },
  };
}
