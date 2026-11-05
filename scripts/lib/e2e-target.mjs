/** The browser suite creates accounts/content and deletes its test account. */
export function e2eTargetError(env) {
  if (!env.E2E_BASE_URL) return null; // isolated local demo server
  if (env.E2E_ALLOW_STAGING_WRITES !== "1" || env.E2E_STAGING_BASE_URL !== env.E2E_BASE_URL)
    return "External e2e requires E2E_ALLOW_STAGING_WRITES=1 and an exact E2E_STAGING_BASE_URL acknowledgment";
  try {
    const target = new URL(env.E2E_BASE_URL);
    if (target.protocol !== "https:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash)
      return "External e2e must target an explicitly selected HTTPS staging origin";
  } catch { return "Invalid external e2e target"; }
  return null;
}
