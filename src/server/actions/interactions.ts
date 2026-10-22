"use server";

import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { INTERACTION_SURFACES, MAX_INTERACTION_BATCH } from "@/lib/data/types";
import { uuidSchema } from "@/lib/validation/schemas";
import { track } from "@/server/analytics";
import { recordInteractions } from "@/server/interactions";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const itemType = z.enum(["place", "event"]);
const impressionsSchema = z.array(z.object({
  itemType,
  itemId: uuidSchema,
  surface: z.enum(INTERACTION_SURFACES),
  position: z.number().int().min(0).max(999).nullable(),
})).min(1).max(MAX_INTERACTION_BATCH);

/** A batch of cards the viewer saw (sent by the browser's impression queue). Fire and forget. */
export async function logImpressionsAction(rows: unknown): Promise<void> {
  const parsed = impressionsSchema.safeParse(rows);
  if (!parsed.success) return;
  await recordInteractions(parsed.data.map((r) => ({ ...r, action: "impression" as const })));
}

/** The viewer opened a detail page, shared it or asked for directions. Fire and forget. */
export async function logItemAction(type: string, id: string, action: string): Promise<void> {
  const kind = itemType.safeParse(type);
  const item = uuidSchema.safeParse(id);
  const what = z.enum(["view", "share", "directions"]).safeParse(action);
  if (!kind.success || !item.success || !what.success) return;
  if (what.data === "view" && kind.data === "place") await track("view_place", { placeId: item.data });
  await recordInteractions([{ itemType: kind.data, itemId: item.data, action: what.data, surface: "detail" }]);
}

/**
 * "Not interested" on a recommendation: the item stops being recommended.
 * Recorded even for people who opted out of analytics, because it is their
 * own visible choice, and undone by undoNotInterestedAction. No revalidation:
 * the card stays to offer the undo, and the rails are rendered per request.
 */
export async function notInterestedAction(type: string, id: string, position: number | null = null): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const kind = itemType.safeParse(type);
  const item = uuidSchema.safeParse(id);
  const at = z.number().int().min(0).max(999).nullable().safeParse(position);
  if (!kind.success || !item.success || !at.success) return fail("Invalid item");
  try {
    const repo = await getRepository();
    await repo.interactions.log(viewer.id, [{ itemType: kind.data, itemId: item.data, action: "hide", surface: "for_you", position: at.data }]);
  } catch (err) {
    return toFailure(err);
  }
  return succeed(undefined);
}

export async function undoNotInterestedAction(type: string, id: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const kind = itemType.safeParse(type);
  const item = uuidSchema.safeParse(id);
  if (!kind.success || !item.success) return fail("Invalid item");
  try {
    const repo = await getRepository();
    await repo.interactions.unhide(viewer.id, { itemType: kind.data, itemId: item.data });
  } catch (err) {
    return toFailure(err);
  }
  return succeed(undefined);
}
