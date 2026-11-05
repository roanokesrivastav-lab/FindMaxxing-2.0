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

/** Forwarding headers an ingress can be trusted to overwrite with exactly one client address. */
export const TRUSTED_PROXY_HEADERS = ["x-forwarded-for", "x-real-ip"] as const;

/**
 * Abuse limits key on the client address, which is only knowable through a trusted ingress header
 * (src/server/http/clientIp.ts). A production server refuses to start unless TRUSTED_PROXY_HEADER names
 * one of TRUSTED_PROXY_HEADERS (owner decision D1). Same pattern as demoModeRefusal. Returns the reason
 * to refuse, or null.
 */
export function trustedProxyRefusal(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV !== "production") return null;
  if ((TRUSTED_PROXY_HEADERS as readonly string[]).includes(env.TRUSTED_PROXY_HEADER ?? "")) return null;
  return (
    `FindMaxxing will not run in production without TRUSTED_PROXY_HEADER. Set it to ${TRUSTED_PROXY_HEADERS.join(" or ")}, ` +
    "naming a header your ingress overwrites with exactly one client address (never a header clients can set). " +
    "Abuse limits for sign-in, sign-up, password reset, geocoding and ads depend on it."
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
export type StandardFeature = (typeof FEATURES)[number];

// ----------------------------------------------------------------------------
// Pilot flags (roadmap 0.3)
//
// Unfinished roadmap work for the pilot, one flag per milestone. Same registry and
// the same NEXT_PUBLIC_FEATURES variable, but a pilot flag is switched on ONLY by
// naming it, or by the explicit token "pilot" (all pilot flags). "all" never turns
// one on, so a deployment that uses NEXT_PUBLIC_FEATURES=all does not gain
// unfinished features when it is rebuilt.
//
// Demo and test configuration turn them on explicitly (never a code default):
// .env.development (next dev only; never loaded by next build or next start),
// scripts/lib/demo-server.mjs (scripted demo runs) and vitest.config.mts.
// ----------------------------------------------------------------------------
export const PILOT_FEATURES = [
  "pilotFoundation", // M1: design tokens/primitives, onboarding (1.1–1.5)
  "pilotExplore", // M2: explore density and place decisions (2.x, 4.7)
  "pilotLibrary", // M3: personal library and importing (3.x)
  "pilotEvents", // M4: events, sports and recurring groups (4.x)
  "pilotOutings", // M5: shared outings and group decisions (5.x)
  "pilotItinerary", // M6: dependable itinerary (6.x)
  "pilotLocal", // M7: local freshness and the return loop (7.x)
] as const;
export type PilotFeature = (typeof PILOT_FEATURES)[number];
export type Feature = StandardFeature | PilotFeature;
/** Turns on every pilot flag. Deliberately separate from "all". */
export const PILOT_ALL_TOKEN = "pilot";

export function isPilotFeature(feature: string): feature is PilotFeature {
  return (PILOT_FEATURES as readonly string[]).includes(feature);
}

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
 * Pilot flags ignore "all" (see PILOT_FEATURES).
 */
export function featureEnabled(feature: Feature, env: Record<string, string | undefined> = process.env): boolean {
  const listed = listedFeatures(env);
  const on = isPilotFeature(feature)
    ? listed.has(feature) || listed.has(PILOT_ALL_TOKEN)
    : listed.has("all") || listed.has(feature);
  if (!on) return false;
  return (requiredKeys[feature] ?? []).every((key) => !!env[key]);
}

/**
 * Resolved pilot availability, computed on the server and passed to client
 * components as a prop (they must not call featureEnabled themselves).
 */
export function pilotFlags(env: Record<string, string | undefined> = process.env): Record<PilotFeature, boolean> {
  return Object.fromEntries(PILOT_FEATURES.map((f) => [f, featureEnabled(f, env)])) as Record<PilotFeature, boolean>;
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
