import "server-only";

/**
 * Per-process fixed-window limiter. Only for traffic whose limit failing open across instances is
 * harmless: today that is browser error reports (src/app/api/client-errors/route.ts). Anything costly
 * or credential-bearing uses the durable limiter in src/server/limiters.ts instead.
 */
export interface MemoryLimit {
  max: number;
  windowSeconds: number;
}

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
