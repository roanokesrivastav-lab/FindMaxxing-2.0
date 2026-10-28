"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DataError } from "@/lib/data/types";
import { fieldErrors } from "@/lib/validation/schemas";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const reason = z.string().trim().min(1, "Give a reason").max(500, "Keep the reason under 500 characters");

const adminActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suspend"), userId: z.string().uuid(), on: z.boolean(), reason }),
  z.object({ kind: z.literal("moderator"), userId: z.string().uuid(), on: z.boolean(), reason }),
  z.object({ kind: z.literal("retire"), taxonomy: z.enum(["category", "interest"]), slug: z.string().max(40), on: z.boolean(), reason }),
]);

export type AdminActionInput = z.input<typeof adminActionSchema>;

/** Suspend / unsuspend, grant / revoke moderator, retire / restore a taxonomy entry. Admins only (checked in the repository and the database). */
export async function adminAction(input: AdminActionInput): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = adminActionSchema.safeParse(input);
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const a = parsed.data;
  try {
    const repo = await getRepository();
    if (a.kind === "suspend") await repo.admin.setSuspended(viewer.id, a.userId, a.on, a.reason);
    else if (a.kind === "moderator") await repo.admin.setModerator(viewer.id, a.userId, a.on, a.reason);
    else await repo.admin.setTaxonomyRetired(viewer.id, a.taxonomy, a.slug, a.on, a.reason);
  } catch (err) {
    if (err instanceof DataError && err.code === "invalid" && /reason/i.test(err.message)) return fail(err.message, { reason: err.message });
    return toFailure(err);
  }
  revalidatePath("/admin", "layout");
  return succeed(undefined);
}

const taxonomySchema = z.object({
  kind: z.enum(["category", "interest"]),
  slug: z.string().trim().toLowerCase(),
  label: z.string().trim(),
  emoji: z.string().trim(),
  sortOrder: z.coerce.number().int().min(0).max(999),
  color: z.string().trim().optional(),
  scope: z.enum(["place", "event", "both"]).optional(),
  reason,
});

export async function upsertTaxonomyAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = taxonomySchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const { reason: why, ...entry } = parsed.data;
  try {
    const repo = await getRepository();
    await repo.admin.upsertTaxonomy(viewer.id, entry, why);
  } catch (err) {
    if (err instanceof DataError && err.code === "invalid") return fail(err.message, { [/slug/i.test(err.message) ? "slug" : /reason/i.test(err.message) ? "reason" : "label"]: err.message });
    return toFailure(err);
  }
  revalidatePath("/admin/taxonomy");
  return succeed(undefined);
}
