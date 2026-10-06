"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { DataError } from "@/lib/data/types";
import { profileSchema } from "@/lib/validation/schemas";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/**
 * One onboarding step: saves interests or home city on top of the current
 * profile. The home city goes through the same 30-day rule as the profile
 * form; a refusal comes back on the homeCity field.
 */
export async function saveOnboardingStepAction(input: { interests?: string[]; homeCity?: string | null }): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const p = viewer.profile;
  const parsed = profileSchema.safeParse({
    username: p.username,
    displayName: p.displayName,
    bio: p.bio ?? "",
    homeCity: input.homeCity === undefined ? (p.homeCity ?? "") : (input.homeCity ?? ""),
    interests: input.interests ?? p.interests,
  });
  if (!parsed.success) return fail("Check that step", { [parsed.error.issues[0]?.path[0]?.toString() ?? "_form"]: parsed.error.issues[0]?.message ?? "Invalid" });
  try {
    const repo = await getRepository();
    await repo.profiles.update(viewer.id, parsed.data);
  } catch (err) {
    if (err instanceof DataError && err.code === "rate_limited") return fail(err.message, { homeCity: err.message });
    return toFailure(err);
  }
  revalidatePath("/profile");
  return succeed(undefined);
}

/** Finishing or skipping both mark onboarding done, so it never shows again. */
export async function finishOnboardingAction(): Promise<ActionResult<{ interests: string[] }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  try {
    const repo = await getRepository();
    await repo.profiles.completeOnboarding(viewer.id);
    const profile = await repo.profiles.getById(viewer.id);
    revalidatePath("/", "layout");
    return succeed({ interests: profile?.interests ?? [] });
  } catch (err) {
    return toFailure(err);
  }
}
