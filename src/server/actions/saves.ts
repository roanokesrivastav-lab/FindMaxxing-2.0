"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { uuidSchema } from "@/lib/validation/schemas";
import type { SaveDetails, SaveDetailsInput } from "@/lib/places/saves";
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
