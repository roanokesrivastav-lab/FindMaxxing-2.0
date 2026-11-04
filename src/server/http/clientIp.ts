import "server-only";
import { headers } from "next/headers";
import { isIP } from "node:net";
import { TRUSTED_PROXY_HEADERS } from "@/lib/config";

/** Every request without a trusted, valid client address maps to this one value. */
export const UNKNOWN_CLIENT = "unknown";

/**
 * Trust only a configured ingress that overwrites the header with ONE address.
 *
 * Unknown-client policy (owner decision D1):
 * - Production refuses to start unless TRUSTED_PROXY_HEADER names one of TRUSTED_PROXY_HEADERS
 *   (trustedProxyRefusal in src/lib/config.ts, checked in src/instrumentation.ts).
 * - A request whose header is absent, a chain ("a, b"), has a port, or is malformed returns
 *   UNKNOWN_CLIENT. Callers then apply only the email key for sign-in/reset/deletion, the generous
 *   shared signup_unknown / geocode_unknown buckets for sign-up and geocode, and the normal ads cap on
 *   the shared key (over the cap the ad slot is simply empty; no money moves). See src/server/limiters.ts.
 * - client-errors keeps its per-process memory limiter: unknown clients share one 30/min bucket there,
 *   which can only drop browser error reports, never block a user action.
 */
export function trustedClientIp(h: Pick<Headers, "get">): string {
  const header = process.env.TRUSTED_PROXY_HEADER;
  if (!header || !(TRUSTED_PROXY_HEADERS as readonly string[]).includes(header)) return UNKNOWN_CLIENT;
  const value = h.get(header)?.trim() ?? "";
  const family = isIP(value);
  if (!family) return UNKNOWN_CLIENT; // chains, ports and malformed addresses fail closed
  if (family === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const n = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
export async function clientIp(h?: Pick<Headers, "get">): Promise<string> {
  return trustedClientIp(h ?? await headers());
}
