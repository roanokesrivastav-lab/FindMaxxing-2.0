"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** The settings switch: opted-out users are never recorded, even if analytics is on. */
export async function setAnalyticsOptOutAction(optOut: boolean): Promise<ActionResult<{ optOut: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (typeof optOut !== "boolean") return fail("Invalid choice");
  try {
    const repo = await getRepository();
    await repo.analytics.setOptOut(viewer.id, optOut);
  } catch (err) {
    return toFailure(err);
  }
  revalidatePath("/profile/settings");
  return succeed({ optOut });
}
