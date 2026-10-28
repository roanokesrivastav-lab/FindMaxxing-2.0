"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DataError, type SavedList } from "@/lib/data/types";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const saveSchema = z.object({ title: z.string().trim().min(1).max(54), placeIds: z.array(z.string().uuid()).min(1).max(12) });

/**
 * Saves a plan's places as a new list (and so as saved places). Goes through
 * the ordinary list rules: the cap, the rate limit, and visibility on every place.
 */
export async function savePlanAsListAction(input: { title: string; placeIds: string[] }): Promise<ActionResult<{ list: SavedList; added: number }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return fail("Nothing to save");
  try {
    const repo = await getRepository();
    let list: SavedList | null = null;
    // A name already taken gets a number, rather than failing the save.
    for (let n = 1; !list && n <= 5; n++) {
      try {
        list = await repo.savedLists.create(viewer.id, n === 1 ? parsed.data.title : `${parsed.data.title} (${n})`);
      } catch (err) {
        if (!(err instanceof DataError && err.code === "conflict")) throw err;
      }
    }
    if (!list) return fail("You already have lists with that name");
    let added = 0;
    for (const id of parsed.data.placeIds) {
      try {
        await repo.savedLists.addPlace(viewer.id, list.id, id);
        added += 1;
      } catch (err) {
        if (!(err instanceof DataError && err.code === "not_found")) throw err;
      }
    }
    revalidatePath("/saved", "layout");
    return succeed({ list: { ...list, placeCount: added }, added });
  } catch (err) {
    return toFailure(err);
  }
}
