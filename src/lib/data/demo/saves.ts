/**
 * Demo twin of 0062_save_details.sql (roadmap 3.1). Details are optional fields on
 * the existing savedPlaces rows, so they go with the save exactly as the columns do
 * (unsave removes them). Rows from before 3.1 read as "want to go", no details.
 */
import type { DataRepository } from "../repository";
import { DataError } from "../types";
import { countTags, normalizeSaveInput, type SaveDetails, type SaveStatus } from "@/lib/places/saves";
import type { DemoState } from "./store";

export type SaveRow = DemoState["savedPlaces"][number] & {
  note?: string | null;
  tags?: string[];
  sourceUrl?: string | null;
  recommendedBy?: string | null;
  status?: SaveStatus;
  updatedAt?: string;
};

export const toSaveDetails = (r: SaveRow): SaveDetails => ({
  placeId: r.placeId,
  note: r.note ?? null,
  tags: r.tags ?? [],
  sourceUrl: r.sourceUrl ?? null,
  recommendedBy: r.recommendedBy ?? null,
  status: r.status ?? "want_to_go",
  createdAt: r.createdAt,
  updatedAt: r.updatedAt ?? r.createdAt,
});

export function createDemoSaves(state: DemoState, h: { persist(): void; assertActive(userId: string): void }): DataRepository["saves"] {
  const rows = () => state.savedPlaces as SaveRow[];
  return {
    async get(ownerId, placeId) {
      const row = rows().find((s) => s.userId === ownerId && s.placeId === placeId);
      return row ? toSaveDetails(row) : null;
    },
    async update(ownerId, placeId, input) {
      h.assertActive(ownerId);
      const clean = normalizeSaveInput(input);
      const row = rows().find((s) => s.userId === ownerId && s.placeId === placeId);
      if (!row) throw new DataError("Save it first", "not_found");
      Object.assign(row, clean, { updatedAt: new Date().toISOString() });
      h.persist();
      return toSaveDetails(row);
    },
    async tags(ownerId) {
      return countTags(rows().filter((s) => s.userId === ownerId).map(toSaveDetails));
    },
  };
}
