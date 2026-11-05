import "server-only";
import { createHmac } from "node:crypto";
import { getDataMode } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { DataError } from "@/lib/data/types";
import type { AbuseKey } from "@/lib/abuseLimits";
import { waitPhrase } from "@/lib/rateLimits";
import { UNKNOWN_CLIENT, clientIp } from "./http/clientIp";

/**
 * Durable, shared abuse limits (0040_durable_abuse_limits.sql). State lives only in Postgres (or the
 * demo store in demo mode); there is deliberately no process-memory fallback. Every failure to reach
 * the limiter becomes DataError("unavailable"), and each caller fails closed with a controlled answer.
 */
const UNAVAILABLE = "Request protection is unavailable. Try again later.";

export function abuseSecret(): string {
  const secret = process.env.ABUSE_HMAC_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (getDataMode() === "demo") return "findmaxxing-local-demo-abuse-secret-only";
  throw new DataError(UNAVAILABLE, "unavailable");
}
/** Keyed hash: the tables only ever hold this 64-hex digest, never a raw IP or email. */
export function abuseHash(kind: "ip" | "email", value: string): string {
  return createHmac("sha256", abuseSecret()).update(`${kind}:${value}`).digest("hex");
}
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type AbuseRpc = (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
/** Separate instances around independent clients share one budget: state lives only in the DB. */
export function createDurableLimiter(rpc: AbuseRpc) {
  return async (keys: AbuseKey[]): Promise<number> => {
    let result: { data: unknown; error: unknown };
    try {
      result = await rpc("consume_server_abuse", { p_keys: keys });
    } catch {
      throw new DataError(UNAVAILABLE, "unavailable");
    }
    const { data, error } = result;
    if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) {
      throw new DataError(UNAVAILABLE, "unavailable");
    }
    return data;
  };
}

function serviceRpc(): AbuseRpc {
  try {
    const client = createSupabaseAdminClient();
    return (name, args) => client.rpc(name, args);
  } catch {
    // e.g. SUPABASE_SERVICE_ROLE_KEY missing: deny, never fall back to memory.
    throw new DataError(UNAVAILABLE, "unavailable");
  }
}

/** Returns 0 when admitted, else seconds to wait. Throws DataError("unavailable") on any limiter failure. */
export async function consumeAbuse(keys: AbuseKey[]): Promise<number> {
  if (getDataMode() === "demo") {
    const [{ getDemoStore }, { consumeDemoAbuse }] = await Promise.all([import("@/lib/data/demo/store"), import("@/lib/data/demo/abuse")]);
    return consumeDemoAbuse(getDemoStore(), keys);
  }
  return createDurableLimiter(serviceRpc())(keys);
}

/**
 * Sign-in, sign-up, password reset and the account-deletion password check. Capacity is reserved
 * BEFORE the provider call and every attempt counts, successful or not.
 *
 * Unknown-client policy (D1): production refuses to start without TRUSTED_PROXY_HEADER
 * (trustedProxyRefusal in src/lib/config.ts). If a request still has no valid trusted address,
 * sign-in and reset apply ONLY the email key, and sign-up adds the generous shared signup_unknown
 * bucket instead of a per-IP one. A shared "unknown" IP bucket never gates all sign-ins.
 */
export async function limitAuth(kind: "signin" | "signup" | "reset", email: string, ip?: string): Promise<void> {
  const client = ip ?? await clientIp();
  const keys: AbuseKey[] = [{ action: `${kind}_email`, key: abuseHash("email", normalizeEmail(email)) }];
  if (client !== UNKNOWN_CLIENT) keys.push({ action: `${kind}_ip`, key: abuseHash("ip", client) });
  else if (kind === "signup") keys.push({ action: "signup_unknown", key: abuseHash("ip", UNKNOWN_CLIENT) });
  const wait = await consumeAbuse(keys);
  if (wait) {
    const label = kind === "signup" ? "sign-ups from this network" : kind === "reset" ? "reset requests" : "sign-in attempts";
    throw new DataError(`Too many ${label}. Try again in ${waitPhrase(wait)}.`, "rate_limited");
  }
}

/** 30 lookups per IP per minute; requests with no trusted IP share the generous geocode_unknown bucket. */
export async function limitGeocode(ip: string): Promise<number> {
  return consumeAbuse([ip === UNKNOWN_CLIENT
    ? { action: "geocode_unknown", key: abuseHash("ip", UNKNOWN_CLIENT) }
    : { action: "geocode", key: abuseHash("ip", ip) }]);
}

/** Atomically claims the application-wide Nominatim slot (one call per 1.1 s). No waiting queue. */
export async function claimGeocodeProvider(): Promise<boolean> {
  if (getDataMode() === "demo") {
    const [{ getDemoStore }, { claimDemoGeocode }] = await Promise.all([import("@/lib/data/demo/store"), import("@/lib/data/demo/abuse")]);
    return claimDemoGeocode(getDemoStore());
  }
  const rpc = serviceRpc();
  let result: { data: unknown; error: unknown };
  try {
    result = await rpc("claim_geocode_provider");
  } catch {
    throw new DataError("Geocoding is unavailable.", "unavailable");
  }
  if (result.error || typeof result.data !== "boolean") throw new DataError("Geocoding is unavailable.", "unavailable");
  return result.data;
}
