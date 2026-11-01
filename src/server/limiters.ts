import "server-only";
import { createHmac } from "node:crypto";
import { getDataMode } from "@/lib/config";
import { DataError } from "@/lib/data/types";
import type { AbuseAction, AbuseKey } from "@/lib/abuseLimits";
import { waitPhrase } from "@/lib/rateLimits";
import { clientIp } from "./http/clientIp";

export function abuseSecret(): string {
  const secret = process.env.ABUSE_HMAC_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (getDataMode() === "demo") return "findmaxxing-local-demo-abuse-secret-only";
  throw new DataError("Request protection is unavailable. Try again later.", "unavailable");
}
export function abuseHash(kind: string, value: string): string {
  return createHmac("sha256", abuseSecret()).update(`${kind}:${value}`).digest("hex");
}
export type AbuseRpc = (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
/** Separate instances around independent clients; state lives only in DB. */
export function createDurableLimiter(rpc: AbuseRpc) {
  return async (keys: AbuseKey[]): Promise<number> => {
    const { data, error } = await rpc("consume_server_abuse", { p_keys: keys });
    if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) {
      throw new DataError("Request protection is unavailable. Try again later.", "unavailable");
    }
    return data;
  };
}
export async function consumeAbuse(keys: AbuseKey[]): Promise<number> {
  if (getDataMode() === "demo") {
    const [{ getDemoStore }, { consumeDemoAbuse }] = await Promise.all([import("@/lib/data/demo/store"), import("@/lib/data/demo/abuse")]);
    return consumeDemoAbuse(getDemoStore(), keys);
  }
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const client = createSupabaseAdminClient();
  return createDurableLimiter((name, args) => client.rpc(name, args))(keys);
}
export async function limitAuth(kind: "signin" | "signup" | "reset", email: string): Promise<void> {
  const wait = await consumeAbuse([
    { action: `${kind}_ip` as AbuseAction, key: abuseHash("ip", await clientIp()) },
    { action: `${kind}_email` as AbuseAction, key: abuseHash("email", email.trim().toLowerCase()) },
  ]);
  if (wait) {
    const label = kind === "signup" ? "sign-ups from this network" : kind === "reset" ? "reset requests" : "sign-in attempts";
    throw new DataError(`Too many ${label}. Try again in ${waitPhrase(wait)}.`, "rate_limited");
  }
}
export async function claimGeocodeProvider(): Promise<boolean> {
  if (getDataMode() === "demo") {
    const [{ getDemoStore }, { claimDemoGeocode }] = await Promise.all([import("@/lib/data/demo/store"), import("@/lib/data/demo/abuse")]);
    return claimDemoGeocode(getDemoStore());
  }
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createSupabaseAdminClient().rpc("claim_geocode_provider");
  if (error || typeof data !== "boolean") throw new DataError("Geocoding is unavailable.", "unavailable");
  return data;
}
