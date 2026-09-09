"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { fieldErrors, isAllowedImage, profileSchema, uuidSchema } from "@/lib/validation/schemas";
import { DataError } from "@/lib/data/types";
import { fail, str, strList, succeed, toFailure, type ActionResult } from "./result";

export async function updateProfileAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");

  const parsed = profileSchema.safeParse({
    username: str(formData, "username"),
    displayName: str(formData, "displayName"),
    bio: str(formData, "bio"),
    homeCity: str(formData, "homeCity"),
    interests: strList(formData, "interests"),
  });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));

  const avatar = formData.get("avatar");
  try {
    const repo = await getRepository();
    let avatarUrl: string | undefined;
    if (avatar instanceof File && avatar.size > 0) {
      const problem = isAllowedImage(avatar);
      if (problem) return fail(problem, { avatar: problem });
      avatarUrl = (await repo.storage.uploadImage(avatar, "avatars", viewer.id)).url;
    }
    await repo.profiles.update(viewer.id, { ...parsed.data, avatarUrl });
  } catch (err) {
    if (err instanceof DataError && err.code === "conflict") return fail(err.message, { username: err.message });
    return toFailure(err);
  }
  revalidatePath("/profile");
  revalidatePath("/", "layout");
  redirect("/profile");
}

export async function toggleFollowAction(userId: string, follow: boolean): Promise<ActionResult<{ following: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to follow people", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(userId);
  if (!id.success) return fail("Invalid user");
  if (id.data === viewer.id) return fail("You can't follow yourself");
  try {
    const repo = await getRepository();
    if (follow) await repo.profiles.follow(viewer.id, id.data);
    else await repo.profiles.unfollow(viewer.id, id.data);
    revalidatePath("/people");
    revalidatePath("/profile");
    return succeed({ following: follow });
  } catch (err) {
    return toFailure(err);
  }
}
