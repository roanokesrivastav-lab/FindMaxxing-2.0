/** Must match consume_server_abuse in 0040; independent of user write quotas. */
export const ABUSE_LIMITS = {
  signin_ip: { max: 20, seconds: 900 }, signin_email: { max: 5, seconds: 900 },
  signup_ip: { max: 5, seconds: 3600 }, signup_email: { max: 5, seconds: 3600 },
  reset_ip: { max: 5, seconds: 3600 }, reset_email: { max: 5, seconds: 3600 },
  ads: { max: 120, seconds: 3600 }, beacon: { max: 240, seconds: 3600 },
  geocode: { max: 30, seconds: 60 },
} as const;
export type AbuseAction = keyof typeof ABUSE_LIMITS;
export type AbuseKey = { action: AbuseAction; key: string };
