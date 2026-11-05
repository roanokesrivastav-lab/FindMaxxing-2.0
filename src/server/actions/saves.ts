"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { uuidSchema } from "@/lib/validation/schemas";
import type { SaveDetails, SaveDetailsInput } from "@/lib/places/saves";
import { bulkSummary, type BulkOp, type SaveSnapshot } from "@/lib/places/library";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** Roadmap 3.1: edit why you saved a place (pilotLibrary). Owner-only by construction: the viewer's own save. */
export async function updateSaveDetailsAction(placeId: string, input: SaveDetailsInput): Promise<ActionResult<SaveDetails>> {
  if (!featureEnabled("pilotLibrary")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!uuidSchema.safeParse(placeId).success) return fail("Place not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    const saved = await repo.saves.update(viewer.id, placeId, input);
    revalidatePath(`/places/${placeId}`);
    revalidatePath("/saved");
    return succeed(saved);
  } catch (err) {
    return toFailure(err);
  }
}

/** Roadmap 3.2: one bulk action over the viewer's own saves; returns what undo needs. */
export async function bulkSavesAction(placeIds: string[], op: BulkOp): Promise<ActionResult<{ snapshots: SaveSnapshot[]; summary: string }>> {
  if (!featureEnabled("pilotLibrary")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!Array.isArray(placeIds) || !placeIds.every((id) => uuidSchema.safeParse(id).success)) return fail("Select places from your saves", undefined, "invalid");
  if (op?.kind === "moveToList" && !uuidSchema.safeParse(op.listId).success) return fail("List not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    const snapshots = await repo.saves.bulk(viewer.id, placeIds, op);
    revalidatePath("/saved");
    return succeed({ snapshots, summary: bulkSummary(op, snapshots.length) });
  } catch (err) {
    return toFailure(err);
  }
}

/** Undoes a bulk action by restoring the snapshots it returned (the viewer's own saves only). */
export async function undoBulkSavesAction(snapshots: SaveSnapshot[]): Promise<ActionResult> {
  if (!featureEnabled("pilotLibrary")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!Array.isArray(snapshots) || !snapshots.every((s) => s && uuidSchema.safeParse(s.placeId).success && (s.listIds ?? []).every((id) => uuidSchema.safeParse(id).success))) {
    return fail("Nothing to undo", undefined, "invalid");
  }
  try {
    const repo = await getRepository();
    await repo.saves.restore(viewer.id, snapshots);
    revalidatePath("/saved");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
