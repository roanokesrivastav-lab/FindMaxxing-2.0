/**
 * Bulk edit and undo for the personal library (roadmap 3.2), written once against
 * the repository contract so the demo and Supabase repositories behave the same.
 * Every write goes through the owner's own save, list and bookmark methods (RLS in
 * Supabase), so a crafted snapshot can only touch what the owner could already change.
 */
import type { DataRepository } from "./repository";
import { DataError } from "./types";
import { applyBulk, checkBulk, snapshotOf, type BulkOp, type SaveSnapshot } from "@/lib/places/library";
import { normalizeSaveInput } from "@/lib/places/saves";

const BATCH = 20;
async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += BATCH) await Promise.all(items.slice(i, i + BATCH).map(fn));
}

export function libraryOps(getRepo: () => DataRepository): Pick<DataRepository["saves"], "bulk" | "restore"> {
  return {
    async bulk(ownerId, rawIds, rawOp) {
      const { placeIds, op } = checkBulk(rawIds, rawOp);
      const repo = getRepo();
      const mine = new Map((await repo.saves.library(ownerId)).map((i) => [i.place.id, i]));
      const targets = placeIds.filter((id) => mine.has(id));
      if (!targets.length) throw new DataError("None of those places are in your saves", "not_found");
      if (op.kind === "moveToList" && !(await repo.savedLists.list(ownerId)).some((l) => l.id === op.listId)) {
        throw new DataError("List not found", "not_found");
      }
      const snapshots = targets.map((id) => snapshotOf(mine.get(id)!, id));
      await inBatches(targets, async (id) => {
        const item = mine.get(id)!;
        if (op.kind === "remove") return repo.places.unsave(ownerId, id);
        if (op.kind === "moveToList") {
          for (const listId of item.listIds) if (listId !== op.listId) await repo.savedLists.removePlace(ownerId, listId, id);
          if (!item.listIds.includes(op.listId)) await repo.savedLists.addPlace(ownerId, op.listId, id);
          return;
        }
        const patch = applyBulk(item.save, op as BulkOp);
        if (patch) await repo.saves.update(ownerId, id, patch);
      });
      return snapshots;
    },
    async restore(ownerId, snapshots) {
      if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > 500) throw new DataError("Nothing to undo", "invalid");
      const repo = getRepo();
      const lists = new Set((await repo.savedLists.list(ownerId)).map((l) => l.id));
      const mine = new Map((await repo.saves.library(ownerId)).map((i) => [i.place.id, i]));
      await inBatches(snapshots, async (s) => {
        if (typeof s?.placeId !== "string") throw new DataError("Nothing to undo", "invalid");
        if (!s.saved) {
          if (mine.has(s.placeId)) await repo.places.unsave(ownerId, s.placeId);
          return;
        }
        if (!mine.has(s.placeId)) await repo.places.save(ownerId, s.placeId);
        if (s.details) await repo.saves.update(ownerId, s.placeId, normalizeSaveInput(s.details));
        const current = new Set(await repo.savedLists.memberships(ownerId, s.placeId));
        const wanted = new Set((s.listIds ?? []).filter((id) => lists.has(id)));
        for (const id of current) if (!wanted.has(id)) await repo.savedLists.removePlace(ownerId, id, s.placeId);
        for (const id of wanted) if (!current.has(id)) await repo.savedLists.addPlace(ownerId, id, s.placeId);
      });
    },
  };
}

export type { SaveSnapshot };
