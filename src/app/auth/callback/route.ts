import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { safeAuthNext } from "@/lib/auth/redirect";

/**
 * Supabase Auth redirect target (email confirmation / magic links).
 * Exchanges a PKCE `code` for a session cookie, then continues to `next`. That
 * only works in the browser that started the flow (it holds the verifier
 * cookie); token-hash links go to /auth/confirm and work anywhere.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Token-hash email links work on any device. Hand them to the confirm page
  // rather than verifying on GET, so link-scanning mail filters can't spend them.
  if (url.searchParams.has("token_hash")) {
    const confirm = new URL("/auth/confirm", url.origin);
    for (const key of ["token_hash", "type", "next"]) {
      const value = url.searchParams.get(key);
      if (value) confirm.searchParams.set(key, value);
    }
    return NextResponse.redirect(confirm);
  }
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
