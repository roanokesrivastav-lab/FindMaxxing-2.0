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
