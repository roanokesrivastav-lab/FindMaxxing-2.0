"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDataMode, getSiteUrl } from "@/lib/config";
import { fieldErrors, signInSchema, signUpSchema } from "@/lib/validation/schemas";
import { DataError } from "@/lib/data/types";
import { fail, str, toFailure, type ActionResult } from "./result";

function safeNext(next: string): string {
  // Only allow same-origin relative paths to prevent open redirects.
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const DEMO_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = signInSchema.safeParse({ email: str(formData, "email"), password: str(formData, "password") });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const next = safeNext(str(formData, "next") || "/");

  try {
    if (getDataMode() === "supabase") {
      const { createSupabaseServerClient } = await import("@/lib/supabase/server");
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) return fail(error.message === "Invalid login credentials" ? "Incorrect email or password" : error.message);
    } else {
      const { demoSignIn, DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
      const session = demoSignIn(parsed.data.email, parsed.data.password);
      (await cookies()).set(DEMO_SESSION_COOKIE, session.userId, DEMO_COOKIE_OPTS);
    }
  } catch (err) {
    return toFailure(err);
  }
  redirect(next);
}

export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse({
    email: str(formData, "email"),
    password: str(formData, "password"),
    username: str(formData, "username"),
    displayName: str(formData, "displayName"),
  });
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const next = safeNext(str(formData, "next") || "/profile/edit?welcome=1");

  try {
    if (getDataMode() === "supabase") {
      const { createSupabaseServerClient } = await import("@/lib/supabase/server");
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.auth.signUp({
        email: parsed.data.email,
        password: parsed.data.password,
        options: {
          emailRedirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
          data: { username: parsed.data.username, display_name: parsed.data.displayName },
        },
      });
      if (error) return fail(error.message);
      // If email confirmation is enabled, there's no session yet.
      if (!data.session) {
        return { ok: true, data: undefined } as ActionResult;
      }
    } else {
      const { demoSignUp, DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
      const session = demoSignUp(parsed.data);
      (await cookies()).set(DEMO_SESSION_COOKIE, session.userId, DEMO_COOKIE_OPTS);
    }
  } catch (err) {
    if (err instanceof DataError) {
      const field = /username/i.test(err.message) ? "username" : /email/i.test(err.message) ? "email" : "_form";
      return fail(err.message, { [field]: err.message });
    }
    return toFailure(err);
  }
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  if (getDataMode() === "supabase") {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } else {
    const { DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
    (await cookies()).delete(DEMO_SESSION_COOKIE);
  }
  redirect("/");
}

/** Demo mode only: one-tap sign in as a seeded persona. */
export async function demoQuickSignInAction(formData: FormData): Promise<void> {
  if (getDataMode() !== "demo") redirect("/auth/sign-in");
  const { demoSignIn, DEMO_SESSION_COOKIE } = await import("@/lib/data/demo/auth");
  const { DEMO_PASSWORD } = await import("@/lib/seed/seed-data");
  const email = str(formData, "email");
  const next = safeNext(str(formData, "next") || "/");
  try {
    const session = demoSignIn(email, DEMO_PASSWORD);
    (await cookies()).set(DEMO_SESSION_COOKIE, session.userId, DEMO_COOKIE_OPTS);
  } catch {
    redirect("/auth/sign-in?error=demo");
  }
  redirect(next);
}
