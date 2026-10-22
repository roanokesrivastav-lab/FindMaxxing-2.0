/**
 * Write rate limits. The database enforces them in Supabase mode
 * (rate_limit_rules in 0011_rate_limits.sql) and the demo repository enforces
 * the same numbers; tests/rate-limits.test.ts keeps this table equal to the SQL.
 */
import { DataError } from "@/lib/data/types";

export type RateLimitAction = "places" | "events" | "ratings" | "lists" | "reports" | "photos" | "photo_objects" | "avatars" | "analytics" | "trip_plans" | "messages" | "trip_plans_plus" | "tickets" | "ad_campaigns" | "interactions";

export interface RateLimitRule {
  max: number;
  windowSeconds: number;
  /** Plural noun for "Too many …" messages. */
  label: string;
}

const HOUR = 3600;
const DAY = 86400;

export const RATE_LIMITS: Record<RateLimitAction, RateLimitRule> = {
  places: { max: 20, windowSeconds: DAY, label: "places" },
  events: { max: 50, windowSeconds: DAY, label: "events" },
  ratings: { max: 100, windowSeconds: DAY, label: "ratings" },
  lists: { max: 30, windowSeconds: DAY, label: "lists" },
  reports: { max: 30, windowSeconds: DAY, label: "reports" },
  photos: { max: 60, windowSeconds: HOUR, label: "photo uploads" },
  photo_objects: { max: 180, windowSeconds: HOUR, label: "photo objects" },
  avatars: { max: 20, windowSeconds: HOUR, label: "avatar uploads" },
  analytics: { max: 600, windowSeconds: HOUR, label: "analytics events" },
  trip_plans: { max: 10, windowSeconds: DAY, label: "trip plans" },
  messages: { max: 60, windowSeconds: HOUR, label: "messages" },
  trip_plans_plus: { max: 30, windowSeconds: DAY, label: "trip plans" },
  tickets: { max: 20, windowSeconds: HOUR, label: "ticket checkouts" },
  ad_campaigns: { max: 10, windowSeconds: DAY, label: "ad campaigns" },
  interactions: { max: 600, windowSeconds: HOUR, label: "interaction batches" },
};

/** Start of the fixed window containing `now`, the same rounding as check_rate_limit(). */
export function windowStart(action: RateLimitAction, now: number): number {
  const size = RATE_LIMITS[action].windowSeconds * 1000;
  return Math.floor(now / size) * size;
}

/** "about 3 hours", "12 minutes", "a few seconds". */
export function waitPhrase(seconds: number): string {
  if (seconds < 60) return "a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function rateLimitError(action: RateLimitAction, retryAfterSeconds: number): DataError {
  const rule = RATE_LIMITS[action];
  return new DataError(`Too many ${rule.label} for now. Try again in ${waitPhrase(retryAfterSeconds)}.`, "rate_limited");
}

/** Parses the database's "rate_limited:<action>:<seconds>" message (SQLSTATE FM429). */
export function parseRateLimitMessage(message: string): DataError | null {
  const m = /rate_limited:([a-z_]+):(\d+)/.exec(message);
  if (!m || !(m[1] in RATE_LIMITS)) return null;
  return rateLimitError(m[1] as RateLimitAction, Number(m[2]));
}

// ----------------------------------------------------------------------------
// In-memory limiter for things the database cannot see: sign-ups and password
// reset requests, keyed by client IP (and email). It is per process: a deploy
// with several instances needs a shared store (Redis, Upstash, or a Postgres
// table) to make these limits global. The database limits above are global.
// ----------------------------------------------------------------------------
export interface MemoryLimit {
  max: number;
  windowSeconds: number;
}

export const SIGN_UP_LIMIT: MemoryLimit = { max: 5, windowSeconds: HOUR };
export const PASSWORD_RESET_LIMIT: MemoryLimit = { max: 5, windowSeconds: HOUR };
/** Sponsored cards served per IP, so nobody burns an advertiser's budget by reloading. */
export const AD_SERVE_LIMIT: MemoryLimit = { max: 120, windowSeconds: HOUR };

/** At most this many keys are tracked; the oldest are dropped first. */
const MAX_KEYS = 10_000;

export function createMemoryLimiter(limit: MemoryLimit, clock: () => number = Date.now) {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return {
    /** Records one attempt; returns the seconds to wait when over the limit, else null. */
    consume(key: string): number | null {
      const now = clock();
      const size = limit.windowSeconds * 1000;
      const start = Math.floor(now / size) * size;
      const entry = hits.get(key);
      if (!entry || entry.windowStart !== start) {
        hits.delete(key);
        if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value as string);
        hits.set(key, { windowStart: start, count: 1 });
        return null;
      }
      entry.count += 1;
      return entry.count > limit.max ? Math.max(1, Math.ceil((start + size - now) / 1000)) : null;
    },
    reset() {
      hits.clear();
    },
  };
}
