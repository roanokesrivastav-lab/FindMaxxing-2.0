import { NextResponse } from "next/server";
import { getMapboxToken, getSiteUrl } from "@/lib/config";
import { mapMapbox, mapNominatim, MIN_GEOCODE_QUERY, type GeocodeResult } from "@/lib/map/geocode";
import { clientIp } from "@/server/http/clientIp";
import { claimGeocodeProvider, limitGeocode } from "@/server/limiters";

/**
 * Address lookup proxy.
 *
 * Runs server-side for three reasons: the provider choice stays off the client,
 * Nominatim's usage policy requires an identifying User-Agent and roughly one
 * request per second, and results can be cached across users. Callers debounce
 * on top of this.
 *
 * Abuse limits are durable and shared by every server instance (0040):
 * - 30 lookups per client IP per minute (ABUSE_LIMITS.geocode), checked before
 *   the cache or any provider; over the cap → 429 with Retry-After. Requests
 *   with no trusted IP share the generous geocode_unknown bucket (D1).
 * - Nominatim: at most one call per 1.1 s application-wide via
 *   claim_geocode_provider. No waiting queue: a missed slot → 503 with
 *   Retry-After. The Mapbox path is not gated by it.
 * - Limiter unavailable → 503. Nothing falls back to process memory.
 * The client (geocodeAddress) treats any non-200 as "no match", so the user
 * can still drop a pin.
 */

const MAX_RESULTS = 5;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  at: number;
  results: GeocodeResult[];
}

// Module scope so the cache survives between requests in a warm server
// process. Deliberately in-memory: this is a cache, not a source of truth or a limit.
const cache = new Map<string, CacheEntry>();

function readCache(key: string): GeocodeResult[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so the cheap eviction below keeps useful entries.
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function writeCache(key: string, results: GeocodeResult[]) {
  cache.set(key, { at: Date.now(), results });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function lookupMapbox(query: string, token: string): Promise<GeocodeResult[]> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?access_token=${encodeURIComponent(token)}&limit=${MAX_RESULTS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Mapbox geocoding failed: ${res.status}`);
  return mapMapbox(await res.json());
}

async function lookupNominatim(query: string): Promise<GeocodeResult[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&limit=${MAX_RESULTS}&addressdetails=0`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: {
      // Nominatim requires a User-Agent that identifies the application.
      "User-Agent": `FindMaxxing/0.1 (${getSiteUrl()})`,
      "Accept-Language": "en",
    },
  });
  if (!res.ok) throw new Error(`Nominatim failed: ${res.status}`);
  return mapNominatim(await res.json());
}

export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < MIN_GEOCODE_QUERY) {
    return NextResponse.json({ results: [] as GeocodeResult[] });
  }

  let wait: number;
  try {
    wait = await limitGeocode(await clientIp());
  } catch {
    return unavailable(5);
  }
  if (wait) {
    return NextResponse.json({ results: [] as GeocodeResult[], error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(wait) } });
  }

  const key = q.toLowerCase();
  const cached = readCache(key);
  if (cached) {
    return NextResponse.json({ results: cached }, { headers: { "X-Geocode-Cache": "hit" } });
  }

  const token = getMapboxToken();
  if (!token) {
    let claimed: boolean;
    try {
      claimed = await claimGeocodeProvider();
    } catch {
      return unavailable(5);
    }
    if (!claimed) return unavailable(2);
  }
  try {
    const results = token ? await lookupMapbox(q, token) : await lookupNominatim(q);
    writeCache(key, results);
    return NextResponse.json({ results }, { headers: { "X-Geocode-Cache": "miss" } });
  } catch (err) {
    console.warn("[geocode]", err instanceof Error ? err.message : err);
    // A lookup failure is not an app failure: the user can still drop a pin.
    return NextResponse.json({ results: [] as GeocodeResult[], unavailable: true }, { status: 200 });
  }
}

function unavailable(retryAfterSeconds: number) {
  return NextResponse.json(
    { results: [] as GeocodeResult[], unavailable: true },
    { status: 503, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
