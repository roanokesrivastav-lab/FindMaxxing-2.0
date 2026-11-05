import { ABUSE_LIMITS, type AbuseKey } from "@/lib/abuseLimits";
import type { StoreHandle } from "./store";

/**
 * Demo-only twin of consume_server_abuse (0040). Same caps, windows and wait seconds (ABUSE_LIMITS);
 * check every budget before reserving any. Production always uses Postgres.
 */
export function consumeDemoAbuse(handle: StoreHandle, keys: AbuseKey[], now = Date.now()): number {
  const { state } = handle;
  state.abuseCounters = state.abuseCounters.filter((c) => c.expires > now);
  const budgets = [...new Map(keys.map((k) => [`${k.action}:${k.key}`, k])).values()].map((k) => {
    const rule = ABUSE_LIMITS[k.action];
    // As in SQL: a stale-stamped request counts against the newest stored window, never an older one.
    const latest = Math.max(-Infinity, ...state.abuseCounters.filter((c) => c.action === k.action && c.key === k.key).map((c) => c.start));
    const start = Math.max(Math.floor(now / (rule.seconds * 1000)) * rule.seconds * 1000, latest);
    const row = state.abuseCounters.find((c) => c.action === k.action && c.key === k.key && c.start === start);
    return { k, rule, start, row, expires: start + rule.seconds * 1000 };
  });
  const wait = Math.max(0, ...budgets.map(({ row, rule, expires }) => (row?.count ?? 0) >= rule.max ? Math.max(1, Math.ceil((expires - now) / 1000)) : 0));
  if (wait) return wait;
  for (const { k, start, row, expires } of budgets) {
    if (row) row.count++;
    else state.abuseCounters.push({ ...k, start, expires, count: 1 });
  }
  handle.persist();
  return 0;
}
/** Twin of claim_geocode_provider: at most one Nominatim call per 1.1 s, no queue. */
export function claimDemoGeocode(handle: StoreHandle, now = Date.now()): boolean {
  const row = handle.state.abuseCounters.find((c) => c.action === "nominatim");
  if (row && row.expires > now) return false;
  handle.state.abuseCounters = handle.state.abuseCounters.filter((c) => c.action !== "nominatim");
  handle.state.abuseCounters.push({ action: "nominatim", key: "provider", start: now, expires: now + 1100, count: 1 });
  handle.persist();
  return true;
}
/** Twin of purge_server_abuse: drops expired counters (SQL: expires_at < now). Returns rows removed. */
export function purgeDemoAbuse(handle: StoreHandle, now = Date.now()): number {
  const before = handle.state.abuseCounters.length;
  handle.state.abuseCounters = handle.state.abuseCounters.filter((c) => c.expires >= now);
  const removed = before - handle.state.abuseCounters.length;
  if (removed) handle.persist();
  return removed;
}
