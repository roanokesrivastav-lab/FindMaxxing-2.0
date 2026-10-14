import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { safeAuthNext } from "@/lib/auth/redirect";

/**
 * Supabase Auth redirect target (email confirmation / magic links).
 * Exchanges the `code` for a session cookie, then continues to `next`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeAuthNext(url.searchParams.get("next"));

  if (getDataMode() === "supabase" && code) {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL("/auth/sign-in?error=callback", url.origin));
}
