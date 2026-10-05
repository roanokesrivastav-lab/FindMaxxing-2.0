"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { fieldErrors, localStatusSchema, moderationSchema } from "@/lib/validation/schemas";
import { DataError, type ModerationAction, type ReportTargetType } from "@/lib/data/types";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** Pages whose content a moderation decision can change. */
function revalidateTarget(targetType: ReportTargetType, targetId: string) {
  revalidatePath("/moderation", "layout");
  if (targetType === "place") revalidatePath(`/places/${targetId}`);
  if (targetType === "event") revalidatePath(`/events/${targetId}`);
  revalidatePath("/", "layout");
}

/** A missing or bad reason belongs on the reason field. */
function reasonFailure(err: unknown): ActionResult<never> {
  if (err instanceof DataError && err.code === "invalid" && /reason/i.test(err.message)) return fail(err.message, { reason: err.message });
  return toFailure(err);
}

/**
 * Resolves every open report on a target at once. The repository (and, in
 * Supabase mode, the database) refuses anyone who is not a moderator.
 */
export async function resolveReportsAction(input: {
  targetType: ReportTargetType;
  targetId: string;
  action: ModerationAction;
  reason?: string | null;
}): Promise<ActionResult<{ statusAfter: string | null; resolvedReports: number }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = moderationSchema.safeParse(input);
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    const result = await repo.moderation.resolve(viewer.id, parsed.data);
    revalidateTarget(parsed.data.targetType, parsed.data.targetId);
    return succeed(result);
  } catch (err) {
    return reasonFailure(err);
  }
}

export async function setLocalStatusAction(input: { userId: string; revoked: boolean; reason: string }): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = localStatusSchema.safeParse(input);
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    await repo.moderation.setLocalStatus(viewer.id, parsed.data.userId, parsed.data.revoked, parsed.data.reason);
    revalidateTarget("profile", parsed.data.userId);
    return succeed(undefined);
  } catch (err) {
    return reasonFailure(err);
  }
}
