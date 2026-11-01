import "server-only";
import { headers } from "next/headers";
import { isIP } from "node:net";

/** Trust only a configured ingress that overwrites the header with ONE address. */
export function trustedClientIp(h: Pick<Headers, "get">): string {
  const header = process.env.TRUSTED_PROXY_HEADER;
  if (header !== "x-forwarded-for" && header !== "x-real-ip") return "unknown";
  const value = h.get(header)?.trim() ?? "";
  const family = isIP(value);
  if (!family) return "unknown"; // chains, ports and malformed addresses fail closed
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
