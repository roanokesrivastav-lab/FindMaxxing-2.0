import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Authenticate before constructing a service client or doing any cron work. */
export function requireCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.get("authorization");
  if (!secret || !authorization) return false;
  // Fixed-length digests avoid length exceptions and prefix-dependent comparison.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
