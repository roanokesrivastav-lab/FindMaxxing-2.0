/**
 * Must match server_abuse_budgets in 0040_durable_abuse_limits.sql (tests/abuse-limits.test.ts
 * compares them); independent of user write quotas. The demo twin (src/lib/data/demo/abuse.ts) reads
 * this table, so demo and SQL share caps, windows and wait seconds.
 *
 * *_unknown: deliberately generous shared buckets for requests with no trusted client IP (owner
 * decision D1). Sign-in and reset have none: without an IP they are limited by email only, so one
 * shared bucket can never lock every sign-in.
 */
export const ABUSE_LIMITS = {
  signin_ip: { max: 20, seconds: 900 }, signin_email: { max: 5, seconds: 900 },
  signup_ip: { max: 5, seconds: 3600 }, signup_email: { max: 5, seconds: 3600 }, signup_unknown: { max: 50, seconds: 3600 },
  reset_ip: { max: 5, seconds: 3600 }, reset_email: { max: 5, seconds: 3600 },
  ads: { max: 120, seconds: 3600 },
  geocode: { max: 30, seconds: 60 }, geocode_unknown: { max: 300, seconds: 60 },
} as const;
export type AbuseAction = keyof typeof ABUSE_LIMITS;
export type AbuseKey = { action: AbuseAction; key: string };
