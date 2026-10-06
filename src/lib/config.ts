/**
 * Runtime configuration derived from environment variables.
 * Only NEXT_PUBLIC_* values are safe to read in client components.
 */

export type DataMode = "supabase" | "demo";

export function getSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && anonKey) return { url, anonKey };
  return null;
}

export function getDataMode(): DataMode {
  return getSupabaseEnv() ? "supabase" : "demo";
}

/**
 * Demo mode is one JSON file rewritten on a debounce: not safe across
 * processes, and never meant for real users. A production server refuses to
 * start in demo mode unless FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION=1 says this
 * is a deliberate public demo. Returns the reason to refuse, or null.
 */
export function demoModeRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  if (env.FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION === "1") return null;
  return (
    "FindMaxxing will not run in demo mode in production. Set NEXT_PUBLIC_SUPABASE_URL and " +
    "NEXT_PUBLIC_SUPABASE_ANON_KEY, or set FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION=1 for a deliberate public demo " +
    "(demo mode stores everything in one local file and is not safe for real users)."
  );
}

export function getMapboxToken(): string | null {
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN || null;
}

export function getMapboxStyle(): string {
  return process.env.NEXT_PUBLIC_MAPBOX_STYLE || "mapbox://styles/mapbox/streets-v12";
}

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
}

/** Default map center: Columbus, Ohio (where the demo data lives). */
export const DEFAULT_CENTER = { lat: 39.9686, lng: -83.0037 } as const;
export const DEFAULT_ZOOM = 12.4;
