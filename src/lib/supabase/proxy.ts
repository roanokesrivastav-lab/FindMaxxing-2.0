import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/config";

/**
 * Refreshes the Supabase session cookie on every request so Server Components
 * always see a valid session. Invoked from src/proxy.ts.
 */
export async function refreshSupabaseSession(request: NextRequest): Promise<NextResponse> {
  const env = getSupabaseEnv();
  let response = NextResponse.next({ request });
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() validates the JWT with Supabase Auth and refreshes if needed.
  await supabase.auth.getUser();
  return response;
}
