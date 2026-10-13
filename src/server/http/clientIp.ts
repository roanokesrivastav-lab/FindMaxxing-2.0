import "server-only";
import { headers } from "next/headers";

/**
 * The client's address as the platform reports it, for per-IP limits. Vercel
 * (and most proxies) put the client first in x-forwarded-for. Falls back to a
 * shared key, so a missing header limits everyone together rather than no one.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}
