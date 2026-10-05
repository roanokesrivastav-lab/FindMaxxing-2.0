import { ImageRejectedError, processAvatar, processPlacePhoto } from "@/lib/images/pipeline";
import type { ImageUpload } from "@/lib/data/types";
import { fail, toFailure, type ActionResult } from "./actions/result";

/**
 * Runs uploaded files through the image pipeline. All of them are decoded and
 * checked before any is stored, so one bad file never leaves the others behind
 * in Storage. One at a time: a form's photos share the process-wide image
 * slots with every other upload (see withImageSlot).
 */
export async function preparePlacePhotos(files: File[]): Promise<ImageUpload[]> {
  const prepared: ImageUpload[] = [];
  for (const file of files) {
    const photo = await processPlacePhoto(new Uint8Array(await file.arrayBuffer()));
    prepared.push({ main: photo.main, variants: photo.variants });
  }
  return prepared;
}

export async function prepareAvatar(file: File): Promise<ImageUpload> {
  return processAvatar(new Uint8Array(await file.arrayBuffer()));
}

/** A rejected image becomes a field error; anything else is a generic failure. */
export function imageFailure(err: unknown, field: string): ActionResult<never> {
  if (err instanceof ImageRejectedError) return fail(err.message, { [field]: err.message });
  return toFailure(err);
}
