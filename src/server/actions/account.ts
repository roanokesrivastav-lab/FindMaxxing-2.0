"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDataMode } from "@/lib/config";
import { getViewer } from "@/lib/auth/server";
import { DataError } from "@/lib/data/types";
import { deleteAccountSchema, fieldErrors, newPasswordSchema, passwordResetRequestSchema } from "@/lib/validation/schemas";
import { waitPhrase } from "@/lib/rateLimits";
import { clientIp } from "@/server/http/clientIp";
import { limiters } from "@/server/limiters";
import { completePasswordReset, requestPasswordReset } from "@/server/passwordReset";
import { WRONG_PASSWORD, deleteAccount } from "@/server/accountDeletion";
import { fail, str, succeed, toFailure, type ActionResult } from "./result";

const DEMO_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

/**
 * The same answer whether or not the email has an account. Limited per
 * network and per email address, so it cannot be used to flood an inbox.
 */
export async function requestPasswordResetAction(_prev: ActionResult<{ demoLink: string | null }> | null, formData: FormData): Promise<ActionResult<{ demoLink: string | null }>> {
  const parsed = passwordResetRequestSchema.safeParse({ email: str(formData, "email") });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const { passwordReset } = limiters();
  const wait = passwordReset.consume(`ip:${await clientIp()}`) ?? passwordReset.consume(`email:${parsed.data.email}`);
  if (wait !== null) return fail(`Too many reset requests. Try again in ${waitPhrase(wait)}.`, undefined, "rate_limited");
  try {
    return succeed(await requestPasswordReset(parsed.data.email));
  } catch (err) {
    return toFailure(err);
  }
}

export async function resetPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = newPasswordSchema.safeParse({ password: str(formData, "password"), confirm: str(formData, "confirm") });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const { userId } = await completePasswordReset(parsed.data.password, str(formData, "token") || null);
    if (getDataMode() === "demo") {
      const { DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
      (await cookies()).set(DEMO_SESSION_COOKIE, userId, DEMO_COOKIE_OPTS);
    }
  } catch (err) {
    return toFailure(err);
  }
  redirect("/profile?reset=1");
}

/** Deletes the signed-in account after re-entering the password. */
export async function deleteAccountAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const parsed = deleteAccountSchema.safeParse({ password: str(formData, "password") });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    await deleteAccount(viewer.id, viewer.email ?? "", parsed.data.password);
  } catch (err) {
    if (err instanceof DataError && err.message === WRONG_PASSWORD) return fail(err.message, { password: err.message });
    return toFailure(err);
  }
  if (getDataMode() === "supabase") {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    await (await createSupabaseServerClient()).auth.signOut().catch(() => undefined);
  } else {
    const { DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
    (await cookies()).delete(DEMO_SESSION_COOKIE);
  }
  redirect("/?deleted=1");
}
