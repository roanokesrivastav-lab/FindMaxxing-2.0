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

// ----------------------------------------------------------------------------
// Feature flags (Part B)
//
// Every post-beta feature is off until switched on, so the beta can ship
// without them and each can be enabled on its own:
//   NEXT_PUBLIC_FEATURES=analytics,reputation,messaging   (or "all")
// NEXT_PUBLIC_ so client components can hide their UI; Next inlines it at build
// time, so changing it needs a rebuild. Features that call an outside service
// also need its key (see requiredKeys) and stay off without it.
// ----------------------------------------------------------------------------
export const FEATURES = [
  "analytics",
  "reputation",
  "admin",
  "recommendations",
  "aiRerank",
  "tripPlanning",
  "messaging",
  "notifications",
  "push",
  "payments",
  "ads",
  "pwa",
] as const;
export type Feature = (typeof FEATURES)[number];

/** Server-side env vars a feature cannot work without. */
const requiredKeys: Partial<Record<Feature, string[]>> = {
  aiRerank: ["ANTHROPIC_API_KEY"],
  tripPlanning: ["ANTHROPIC_API_KEY"],
  payments: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
};

function listedFeatures(env: Record<string, string | undefined>): Set<string> {
  return new Set((env.NEXT_PUBLIC_FEATURES ?? "").split(",").map((f) => f.trim()).filter(Boolean));
}

/**
 * Whether a feature is switched on. On the server this also checks the keys
 * it needs; client components get the answer as a prop from a server
 * component rather than calling this (secret keys are not visible there).
 */
export function featureEnabled(feature: Feature, env: Record<string, string | undefined> = process.env): boolean {
  const listed = listedFeatures(env);
  if (!listed.has("all") && !listed.has(feature)) return false;
  return (requiredKeys[feature] ?? []).every((key) => !!env[key]);
}

/** Push is a global opt-in; browser credentials do not gate Expo devices. */
export function pushTransportReady(kind: "web" | "expo", env: Record<string, string | undefined> = process.env): boolean {
  return featureEnabled("push", env) && (kind === "expo" || (!!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY));
}

/**
 * How payments run. "stripe": the payments flag and the Stripe keys, with
 * Supabase. "demo": the flag in demo mode, where a clearly labeled fake
 * checkout stands in and no money moves. null: payments are off.
 */
export function paymentsMode(env: Record<string, string | undefined> = process.env): "stripe" | "demo" | null {
  const listed = listedFeatures(env);
  if (!listed.has("all") && !listed.has("payments")) return null;
  if (getDataMode() === "demo") return "demo";
  return featureEnabled("payments", env) ? "stripe" : null;
}

/** Default map center: Columbus, Ohio (where the demo data lives). */
export const DEFAULT_CENTER = { lat: 39.9686, lng: -83.0037 } as const;
export const DEFAULT_ZOOM = 12.4;
