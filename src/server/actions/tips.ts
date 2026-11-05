"use server";

import { revalidatePath } from "next/cache";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { uuidSchema } from "@/lib/validation/schemas";
import type { TipKind } from "@/lib/places/tips";
import { fail, succeed, toFailure, type ActionResult } from "./result";

/** Roadmap 2.6: tip actions (pilotExplore). The repository and RLS do the authorization. */
async function viewerFor(action: string): Promise<{ viewer: { id: string }; error?: undefined } | { viewer?: undefined; error: ActionResult<never> }> {
  if (!featureEnabled("pilotExplore")) return { error: fail("Not available", undefined, "forbidden") };
  const viewer = await getViewer();
  if (!viewer) return { error: fail(`Sign in to ${action}`, undefined, "unauthenticated") };
  return { viewer };
}

const ids = (...values: string[]) => values.every((v) => uuidSchema.safeParse(v).success);

export async function addTipAction(input: { placeId: string; body: string; kind: TipKind; expiresAt?: string | null }): Promise<ActionResult> {
  const v = await viewerFor("add a tip");
  if (v.error) return v.error;
  if (!ids(input.placeId)) return fail("Place not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    await repo.tips.add(v.viewer.id, input.placeId, { body: input.body, kind: input.kind, expiresAt: input.expiresAt ?? null });
    revalidatePath(`/places/${input.placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

export async function confirmTipAction(placeId: string, tipId: string): Promise<ActionResult> {
  const v = await viewerFor("confirm a tip");
  if (v.error) return v.error;
  if (!ids(placeId, tipId)) return fail("Tip not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    await repo.tips.confirm(v.viewer.id, tipId);
    revalidatePath(`/places/${placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

export async function suggestTipCorrectionAction(placeId: string, tipId: string, body: string): Promise<ActionResult> {
  const v = await viewerFor("suggest a correction");
  if (v.error) return v.error;
  if (!ids(placeId, tipId)) return fail("Tip not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    await repo.tips.suggestCorrection(v.viewer.id, tipId, body);
    revalidatePath(`/places/${placeId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
