"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import {
  fieldErrors,
  isAllowedImage,
  placeSchema,
  placeStatusSchema,
  placeVisibilitySchema,
  ratingSchema,
  reportSchema,
  uuidSchema,
} from "@/lib/validation/schemas";
import type { DataRepository } from "@/lib/data/repository";
import { MAX_PLACE_PHOTOS, type ImageUpload, type StoredImage } from "@/lib/data/types";
import { imageFailure, preparePlacePhotos } from "@/server/images";
import { fail, str, strList, succeed, toFailure, type ActionResult } from "./result";

export async function createPlaceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to add a place", undefined, "unauthenticated");

  const parsed = placeSchema.safeParse({
    name: str(formData, "name"),
    description: str(formData, "description"),
    localTip: str(formData, "localTip"),
    categorySlug: str(formData, "categorySlug"),
    lat: str(formData, "lat"),
    lng: str(formData, "lng"),
    address: str(formData, "address"),
    neighborhood: str(formData, "neighborhood"),
    city: str(formData, "city"),
    tags: strList(formData, "tags"),
    visibility: str(formData, "visibility"),
  });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));

  const files = collectImages(formData, "photos");
  if (files.length > MAX_PLACE_PHOTOS) {
    return fail(`Up to ${MAX_PLACE_PHOTOS} photos`, { photos: `Up to ${MAX_PLACE_PHOTOS} photos` });
  }
  for (const file of files) {
    const problem = isAllowedImage(file);
    if (problem) return fail(problem, { photos: problem });
  }
  let prepared: ImageUpload[];
  try {
    prepared = await preparePlacePhotos(files);
  } catch (err) {
    return imageFailure(err, "photos");
  }
  const repo = await getRepository();
  let photos: StoredImage[] = [];
  let placeId: string;
  try {
    photos = await uploadPlaceImages(repo, prepared, viewer.id);
    placeId = (await repo.places.create({ ...parsed.data, photos }, viewer.id)).id;
  } catch (err) {
    await cleanupPlaceImages(repo, photos);
    return toFailure(err);
  }
  revalidatePath("/");
  revalidatePath("/profile");
  redirect(`/places/${placeId}?new=1`);
}

export async function updatePlaceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to edit places", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(str(formData, "placeId"));
  if (!id.success) return fail("Invalid place");
  const parsed = placeSchema.safeParse({
    name: str(formData, "name"), description: str(formData, "description"), localTip: str(formData, "localTip"),
    categorySlug: str(formData, "categorySlug"), lat: str(formData, "lat"), lng: str(formData, "lng"),
    address: str(formData, "address"), neighborhood: str(formData, "neighborhood"), city: str(formData, "city"), tags: strList(formData, "tags"),
  });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    // Visibility is owned by the controls on the place page, not the edit form,
    // so an edit never silently moves a place between trust tiers.
    const { visibility: _ignored, ...patch } = parsed.data;
    void _ignored;
    const place = await repo.places.update(id.data, patch, viewer.id);
    revalidatePath(`/places/${id.data}`); revalidatePath(`/places/${id.data}/edit`); revalidatePath("/"); revalidatePath("/profile");
    redirect(`/places/${place.id}`);
  } catch (err) { return toFailure(err); }
}

export async function deletePlaceAction(placeId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to delete places", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(placeId);
  if (!id.success) return fail("Invalid place");
  try {
    const repo = await getRepository();
    await repo.places.delete(id.data, viewer.id);
    revalidatePath(`/places/${id.data}`); revalidatePath("/"); revalidatePath("/saved"); revalidatePath("/profile"); revalidatePath("/events");
    redirect("/");
  } catch (err) { return toFailure(err); }
}

export async function removePlacePhotoAction(placeId: string, photoId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to remove photos", undefined, "unauthenticated");
  const place = uuidSchema.safeParse(placeId); const photo = uuidSchema.safeParse(photoId);
  if (!place.success || !photo.success) return fail("Invalid photo");
  try {
    const repo = await getRepository();
    const removed = await repo.places.removePhoto(place.data, photo.data, viewer.id);
    if (removed.storagePath) await repo.storage.removeImage("places", removed.storagePath);
    revalidatePath(`/places/${place.data}`); revalidatePath("/");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

export async function removeRatingAction(placeId: string): Promise<ActionResult<{ ratingAvg: number; ratingCount: number }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to remove your rating", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(placeId);
  if (!id.success) return fail("Invalid place");
  try {
    const repo = await getRepository();
    const aggregate = await repo.places.removeRating(viewer.id, id.data);
    revalidatePath(`/places/${id.data}`); revalidatePath("/");
    return succeed(aggregate);
  } catch (err) { return toFailure(err); }
}

export async function toggleSaveAction(placeId: string, save: boolean): Promise<ActionResult<{ saved: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to save places", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(placeId);
  if (!id.success) return fail("Invalid place");
  try {
    const repo = await getRepository();
    if (save) await repo.places.save(viewer.id, id.data);
    else await repo.places.unsave(viewer.id, id.data);
    revalidatePath(`/places/${id.data}`);
    // Unsaving also takes the place out of every list page under /saved.
    revalidatePath("/saved", "layout");
    return succeed({ saved: save });
  } catch (err) {
    return toFailure(err);
  }
}

export async function ratePlaceAction(
  input: { placeId: string; score: number; note?: string | null },
): Promise<ActionResult<{ ratingAvg: number; ratingCount: number; score: number }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to rate places", undefined, "unauthenticated");
  const parsed = ratingSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid rating", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    const agg = await repo.places.rate(viewer.id, parsed.data.placeId, parsed.data.score, parsed.data.note);
    revalidatePath(`/places/${parsed.data.placeId}`);
    revalidatePath("/");
    return succeed({ ...agg, score: parsed.data.score });
  } catch (err) {
    return toFailure(err);
  }
}

export async function reportAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to report", undefined, "unauthenticated");
  const parsed = reportSchema.safeParse({
    targetType: str(formData, "targetType"),
    targetId: str(formData, "targetId"),
    reason: str(formData, "reason"),
    details: str(formData, "details"),
  });
  if (!parsed.success) return fail("Pick a reason", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    await repo.reports.create(parsed.data, viewer.id);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}


/** Collects every non-empty File under one form field name. */
function collectImages(formData: FormData, field: string): File[] {
  return formData.getAll(field).filter((v): v is File => v instanceof File && v.size > 0);
}

/** Adds photos to an existing place. Any signed-in user may contribute. */
export async function addPlacePhotosAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to add photos", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(str(formData, "placeId"));
  if (!id.success) return fail("Invalid place");

  const files = collectImages(formData, "photos");
  if (!files.length) return fail("Choose at least one photo", { photos: "Choose at least one photo" });
  if (files.length > MAX_PLACE_PHOTOS) {
    return fail(`Up to ${MAX_PLACE_PHOTOS} photos`, { photos: `Up to ${MAX_PLACE_PHOTOS} photos` });
  }
  for (const file of files) {
    const problem = isAllowedImage(file);
    if (problem) return fail(problem, { photos: problem });
  }

  let prepared: ImageUpload[];
  try {
    prepared = await preparePlacePhotos(files);
  } catch (err) {
    return imageFailure(err, "photos");
  }
  const repo = await getRepository();
  let images: StoredImage[] = [];
  try {
    images = await uploadPlaceImages(repo, prepared, viewer.id);
    await repo.places.addPhotos(id.data, images, viewer.id);
    revalidatePath(`/places/${id.data}`);
    return succeed(undefined);
  } catch (err) {
    await cleanupPlaceImages(repo, images);
    return toFailure(err);
  }
}

async function uploadPlaceImages(repo: DataRepository, images: ImageUpload[], ownerId: string): Promise<StoredImage[]> {
  const results = await Promise.allSettled(images.map((image) => repo.storage.uploadImage(image, "places", ownerId)));
  const uploaded = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    await cleanupPlaceImages(repo, uploaded);
    throw failure.reason;
  }
  return uploaded;
}

async function cleanupPlaceImages(repo: DataRepository, images: StoredImage[]): Promise<void> {
  await Promise.allSettled(
    images.flatMap((image) => image.storagePath ? [repo.storage.removeImage("places", image.storagePath)] : []),
  );
}

/** Owner-only: hide a listing from discovery, or publish it again. */
export async function setPlaceStatusAction(placeId: string, status: string): Promise<ActionResult<{ status: string }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(placeId);
  if (!id.success) return fail("Invalid place");
  const parsed = placeStatusSchema.safeParse(status);
  if (!parsed.success) return fail("You can hide or publish a place, nothing else");
  try {
    const repo = await getRepository();
    await repo.places.setStatus(id.data, parsed.data, viewer.id);
    revalidatePath(`/places/${id.data}`);
    revalidatePath("/");
    revalidatePath("/profile");
    return succeed({ status: parsed.data });
  } catch (err) {
    return toFailure(err);
  }
}

/** Owner-only: move a place between the public and locals-only trust tiers. */
export async function setPlaceVisibilityAction(placeId: string, visibility: string): Promise<ActionResult<{ visibility: string }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(placeId);
  if (!id.success) return fail("Invalid place");
  const parsed = placeVisibilitySchema.safeParse(visibility);
  if (!parsed.success) return fail("Invalid visibility");
  try {
    const repo = await getRepository();
    await repo.places.setVisibility(id.data, parsed.data, viewer.id);
    revalidatePath(`/places/${id.data}`);
    revalidatePath("/");
    return succeed({ visibility: parsed.data });
  } catch (err) {
    return toFailure(err);
  }
}
