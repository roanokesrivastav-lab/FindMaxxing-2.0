"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { uuidSchema } from "@/lib/validation/schemas";
import { track } from "@/server/analytics";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** A place page was viewed (sent once from the page in the browser). */
export async function trackPlaceViewAction(placeId: string): Promise<void> {
  const id = uuidSchema.safeParse(placeId);
  if (id.success) await track("view_place", { placeId: id.data });
}

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
