export type StagingEnv = Record<string, string | undefined>;
export const STAGING_REQUIRED = ["STAGING_PROJECT_REF", "STAGING_DATABASE_URL", "STAGING_SUPABASE_URL", "STAGING_SUPABASE_ANON_KEY", "STAGING_SUPABASE_SERVICE_ROLE_KEY"] as const;

/** Validate before constructing clients or running commands. Never echo URLs/keys. */
export function stagingPreflight(env: StagingEnv, args: Set<string>): string | null {
  const missing = STAGING_REQUIRED.filter((key) => !env[key]);
  if (missing.length) return `Missing ${missing.join(", ")}`;
  if (!args.has("--allow-staging-writes")) return "Explicit --allow-staging-writes acknowledgment required for disposable staging";
  if ([...args].some((arg) => !["--allow-staging-writes", "--skip-migrations", "--skip-e2e"].includes(arg))) return "Unknown staging-check argument";
  const ref = env.STAGING_PROJECT_REF!;
  if (!/^[a-z0-9-]{6,64}$/.test(ref)) return "Invalid STAGING_PROJECT_REF";
  try {
    const api = new URL(env.STAGING_SUPABASE_URL!);
    if (api.protocol !== "https:" || api.hostname !== `${ref}.supabase.co` || api.port || api.username || api.password
      || api.pathname !== "/" || api.search || api.hash) return "Supabase URL does not match the acknowledged staging project";
    const db = new URL(env.STAGING_DATABASE_URL!);
    const direct = db.hostname === `db.${ref}.supabase.co` && decodeURIComponent(db.username) === "postgres";
    const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) && decodeURIComponent(db.username) === `postgres.${ref}`;
    if (!["postgres:", "postgresql:"].includes(db.protocol) || (!direct && !pooler) || db.pathname !== "/postgres") return "Database URL does not match the acknowledged staging project";
    if (!args.has("--skip-e2e") && !env.STAGING_APP_URL) return "Missing STAGING_APP_URL (skipping e2e cannot produce a complete gate)";
    if (env.STAGING_APP_URL) {
      const app = new URL(env.STAGING_APP_URL);
      if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash) return "STAGING_APP_URL must be an explicitly selected HTTPS staging deployment";
    }
  } catch { return "Invalid staging URL configuration"; }
  return null;
}

interface CleanupAdmin {
  storage: { from(bucket: string): { remove(paths: string[]): Promise<{ error: unknown }> } };
  auth: { admin: { deleteUser(id: string): Promise<{ error: unknown }> } };
}
/** Only exact scratch paths and IDs recorded by this invocation are eligible. */
export async function cleanupStaging(admin: CleanupAdmin, users: string[], paths: string[]): Promise<{ storageClean: boolean; removed: number }> {
  let storageClean = true;
  if (paths.some((path) => !users.some((id) => path.startsWith(`${id}/`)))) return { storageClean: false, removed: 0 };
  if (paths.length) {
    try { storageClean = !(await admin.storage.from("place-photos").remove(paths)).error; }
    catch { storageClean = false; }
  }
  let removed = 0;
  if (storageClean) for (const id of users) {
    try { if (!(await admin.auth.admin.deleteUser(id)).error) removed += 1; }
    catch { /* Preserve accurate counts; callers fail the gate on leftovers. */ }
  }
  return { storageClean, removed };
}
