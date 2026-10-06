import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "@/lib/config";

/**
 * Service-role client. It bypasses Row Level Security, so it is used only by
 * the few server-side operations that must act beyond the signed-in user's
 * own rows (account deletion). Never import this from a page or component.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const env = getSupabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env || !serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set: account deletion needs it in Supabase mode");
  }
  return createClient(env.url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A one-off anon client with no cookie session, for re-checking a password without touching the user's session. */
export function createSupabaseStatelessClient(): SupabaseClient {
  const env = getSupabaseEnv();
  if (!env) throw new Error("Supabase is not configured");
  return createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
