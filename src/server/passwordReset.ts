import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getDataMode, getSiteUrl } from "@/lib/config";
import { DataError } from "@/lib/data/types";

/** Reset links stay valid for an hour, and work once. */
const RESET_TTL_MS = 60 * 60_000;

/**
 * Demo-mode reset tokens, kept in memory (they do not survive a restart).
 * Only the hash is stored. A request for an unknown email gets a token too,
 * attached to nobody, so the response looks the same either way; using it
 * fails exactly like an expired link.
 */
declare global {
  var __findmaxxingResetTokens: Map<string, { userId: string | null; expiresAt: number; used: boolean }> | undefined;
}
function tokens() {
  globalThis.__findmaxxingResetTokens ??= new Map();
  return globalThis.__findmaxxingResetTokens;
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const RESET_LINK_INVALID = "This reset link has expired or was already used. Request a new one.";

/**
 * Starts a reset. Always resolves the same way whether or not the email has an
 * account. Demo mode returns the link to show on screen instead of emailing it.
 */
export async function requestPasswordReset(email: string): Promise<{ demoLink: string | null }> {
  if (getDataMode() === "supabase") {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent("/auth/reset")}`,
    });
    // Unknown emails do not error; anything that does (e.g. Auth's own email
    // rate limit) is logged, never shown, so the response stays neutral.
    if (error) console.warn("[password-reset] request failed", error.message);
    return { demoLink: null };
  }
  const { getDemoStore } = await import("@/lib/data/demo/store");
  const user = getDemoStore().state.authUsers.find((u) => u.email === email.toLowerCase());
  const token = randomBytes(32).toString("base64url");
  const store = tokens();
  for (const [key, value] of store) if (value.expiresAt < Date.now()) store.delete(key);
  store.set(hashToken(token), { userId: user?.id ?? null, expiresAt: Date.now() + RESET_TTL_MS, used: false });
  return { demoLink: `/auth/reset?token=${token}` };
}

/**
 * Sets a new password. Supabase mode uses the recovery session that
 * /auth/callback established; demo mode checks the token. Returns the user id
 * (demo mode signs them in with it).
 */
export async function completePasswordReset(newPassword: string, token: string | null): Promise<{ userId: string; email: string }> {
  if (getDataMode() === "supabase") {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server");
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) throw new DataError(RESET_LINK_INVALID, "invalid");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new DataError(error.message, "invalid");
    return { userId: userData.user.id, email: userData.user.email ?? "" };
  }
  const entry = token ? tokens().get(hashToken(token)) : undefined;
  if (!entry || entry.used || entry.expiresAt < Date.now() || !entry.userId) throw new DataError(RESET_LINK_INVALID, "invalid");
  const { getDemoStore, hashPassword } = await import("@/lib/data/demo/store");
  const { state, persist } = getDemoStore();
  const user = state.authUsers.find((u) => u.id === entry.userId);
  if (!user) throw new DataError(RESET_LINK_INVALID, "invalid");
  entry.used = true;
  user.passwordHash = hashPassword(newPassword);
  persist();
  return { userId: user.id, email: user.email };
}
