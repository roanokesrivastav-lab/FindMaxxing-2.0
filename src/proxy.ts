import type { NextRequest } from "next/server";
import { refreshSupabaseSession } from "@/lib/supabase/proxy";
import { buildCsp, createNonce } from "@/lib/security/csp";

/**
 * Next.js proxy (formerly middleware). Sets a per-request Content-Security-
 * Policy and keeps the Supabase session fresh (a pass-through for the session
 * in demo mode).
 */
export async function proxy(request: NextRequest) {
  const csp = buildCsp(createNonce(), { dev: process.env.NODE_ENV === "development" });
  // On the request so Next can nonce its own scripts; on the response so the browser enforces it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  const response = await refreshSupabaseSession(request, requestHeaders);
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Skip static assets and image optimization; run on everything else.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
