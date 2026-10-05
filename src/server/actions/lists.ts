"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { DataError, type SavedList } from "@/lib/data/types";
import { uuidSchema } from "@/lib/validation/schemas";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** Every page that shows lists or a place's saved state: /saved and each /saved/[id]. */
function revalidateLists(placeId?: string) {
  revalidatePath("/saved", "layout");
  if (placeId) revalidatePath(`/places/${placeId}`);
}

/** A bad or taken name belongs on the name field; anything else is a general failure. */
function nameFailure(err: unknown): ActionResult<never> {
  if (err instanceof DataError && (err.code === "invalid" || err.code === "conflict")) return fail(err.message, { name: err.message });
  return toFailure(err);
}

/** Creates a list; with a place, also adds it (saving it first if needed). */
export async function createListAction(name: string, placeId?: string): Promise<ActionResult<{ list: SavedList }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to make lists", undefined, "unauthenticated");
  if (typeof name !== "string") return fail("Give the list a name", { name: "Give the list a name" });
  const place = placeId === undefined ? null : uuidSchema.safeParse(placeId);
  if (place && !place.success) return fail("Invalid place");

  const repo = await getRepository();
  let list: SavedList;
  try {
    list = await repo.savedLists.create(viewer.id, name);
  } catch (err) {
    return nameFailure(err);
  }
  try {
    if (place?.success) {
      await repo.savedLists.addPlace(viewer.id, list.id, place.data);
      list = { ...list, placeCount: 1 };
    }
  } catch (err) {
    // The list exists either way; report why the place is not in it.
    revalidateLists();
    return toFailure(err);
  }
  revalidateLists(place?.success ? place.data : undefined);
  return succeed({ list });
}

export async function renameListAction(listId: string, name: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(listId);
  if (!id.success) return fail("Invalid list");
  if (typeof name !== "string") return fail("Give the list a name", { name: "Give the list a name" });
  try {
    const repo = await getRepository();
    await repo.savedLists.rename(viewer.id, id.data, name);
  } catch (err) {
    return nameFailure(err);
  }
  revalidateLists();
  return succeed(undefined);
}

/** Deletes the list only: every place in it stays saved. */
export async function deleteListAction(listId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(listId);
  if (!id.success) return fail("Invalid list");
  try {
    const repo = await getRepository();
    await repo.savedLists.delete(viewer.id, id.data);
  } catch (err) {
    return toFailure(err);
  }
  revalidateLists();
  return succeed(undefined);
}

/** Puts a place in a list (saving it if needed) or takes it out (it stays saved). */
export async function setListMembershipAction(listId: string, placeId: string, inList: boolean): Promise<ActionResult<{ inList: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to organize your saves", undefined, "unauthenticated");
  const list = uuidSchema.safeParse(listId);
  const place = uuidSchema.safeParse(placeId);
  if (!list.success || !place.success) return fail("Invalid list or place");
  try {
    const repo = await getRepository();
    if (inList) await repo.savedLists.addPlace(viewer.id, list.data, place.data);
    else await repo.savedLists.removePlace(viewer.id, list.data, place.data);
  } catch (err) {
    return toFailure(err);
  }
  revalidateLists(place.data);
  return succeed({ inList });
}
