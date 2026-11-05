"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { isAllowedImage, uuidSchema } from "@/lib/validation/schemas";
import { imageFailure, preparePlacePhotos } from "@/server/images";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/**
 * Roadmap 2.8: the viewer's personal photo of a place (pilotExplore). The upload goes
 * through the same image pipeline as place photos, which re-encodes it and drops
 * every metadata block (EXIF GPS, camera, timestamps) before anything is stored.
 */
export async function uploadPersonalPhotoAction(formData: FormData): Promise<ActionResult> {
  if (!featureEnabled("pilotExplore")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const placeId = formData.get("placeId");
  const file = formData.get("photo");
  if (typeof placeId !== "string" || !uuidSchema.safeParse(placeId).success) return fail("Place not found", undefined, "not_found");
  if (!(file instanceof File) || !file.size) return fail("Choose a photo", { photo: "Choose a photo" });
  const problem = isAllowedImage(file);
  if (problem) return fail(problem, { photo: problem });
  let prepared;
  try {
    [prepared] = await preparePlacePhotos([file]);
  } catch (err) {
    return imageFailure(err, "photo");
  }
  try {
    const repo = await getRepository();
    await repo.personalPhotos.upload(viewer.id, placeId, prepared);
    revalidatePath(`/places/${placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

export async function removePersonalPhotoAction(placeId: string): Promise<ActionResult> {
  if (!featureEnabled("pilotExplore")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!uuidSchema.safeParse(placeId).success) return fail("Place not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    await repo.personalPhotos.remove(viewer.id, placeId);
    revalidatePath(`/places/${placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

/** Team only (moderators and admins): choose a place's public photo, with its permission note. */
export async function setPublicPhotoAction(placeId: string, photoId: string, permissionNote: string): Promise<ActionResult> {
  if (!featureEnabled("pilotExplore")) return fail("Not available", undefined, "forbidden");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!uuidSchema.safeParse(placeId).success || !uuidSchema.safeParse(photoId).success) return fail("Photo not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    await repo.publicPhotos.set(viewer.id, placeId, photoId, permissionNote);
    revalidatePath(`/places/${placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
