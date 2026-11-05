import { safeAuthNext } from "./redirect";

/**
 * Token-hash email links (confirm sign-up, reset password, change email).
 *
 * Unlike the PKCE `?code=` flow, these work on any device or browser: the
 * token hash alone proves the email was received, with no verifier cookie from
 * the browser that started the flow. Supabase's email templates build them as
 * `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=<type>`.
 */
export type EmailLinkType = "email" | "recovery" | "email_change";
export type EmailLink = { tokenHash: string; type: EmailLinkType; next: string };

export const EMAIL_LINK_INVALID = "This link has expired or was already used. Sign in, or request a new link.";

const TOKEN_HASH = /^[A-Za-z0-9_-]{16,256}$/;

export function parseEmailLink(input: { tokenHash: unknown; type: unknown; next: unknown }): EmailLink | null {
  const { tokenHash, next } = input;
  if (typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return null;
  // "signup" is Supabase's legacy name for the same email confirmation.
  const type = input.type === "signup" ? "email" : input.type;
  if (type !== "email" && type !== "recovery" && type !== "email_change") return null;
  return {
    tokenHash,
    type,
    // A recovery link only ever leads to choosing a new password.
    next: type === "recovery" ? "/auth/reset" : safeAuthNext(next, type === "email" ? "/welcome" : "/"),
  };
}
