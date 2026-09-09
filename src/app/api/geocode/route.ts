import { NextResponse } from "next/server";
import { getMapboxToken, getSiteUrl } from "@/lib/config";
import { mapMapbox, mapNominatim, MIN_GEOCODE_QUERY, type GeocodeResult } from "@/lib/map/geocode";

/**
 * Address lookup proxy.
 *
 * Runs server-side for three reasons: the provider choice stays off the client,
 * Nominatim's usage policy requires an identifying User-Agent and roughly one
 * request per second, and results can be cached across users. Callers debounce
 * on top of this.
 */

const MAX_RESULTS = 5;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
/** Nominatim asks for no more than 1 request/second across a whole application. */
const MIN_PROVIDER_INTERVAL_MS = 1100;

interface CacheEntry {
  at: number;
  results: GeocodeResult[];
}

// Module scope so the cache and throttle survive between requests in a warm
// server process. Deliberately in-memory: this is a cache, not a source of truth.
const cache = new Map<string, CacheEntry>();
let lastProviderCallAt = 0;
let providerChain: Promise<unknown> = Promise.resolve();

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

/** Serializes provider calls and spaces them out, per Nominatim's policy. */
function scheduleProviderCall<T>(run: () => Promise<T>): Promise<T> {
  const next = providerChain.then(async () => {
    const wait = MIN_PROVIDER_INTERVAL_MS - (Date.now() - lastProviderCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastProviderCallAt = Date.now();
    return run();
  });
  // Keep the chain alive even if one call rejects.
  providerChain = next.catch(() => undefined);
  return next;
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

  const key = q.toLowerCase();
  const cached = readCache(key);
  if (cached) {
    return NextResponse.json({ results: cached }, { headers: { "X-Geocode-Cache": "hit" } });
  }

  const token = getMapboxToken();
  try {
    const results = token
      ? await lookupMapbox(q, token)
      : await scheduleProviderCall(() => lookupNominatim(q));
    writeCache(key, results);
    return NextResponse.json({ results }, { headers: { "X-Geocode-Cache": "miss" } });
  } catch (err) {
    console.warn("[geocode]", err instanceof Error ? err.message : err);
    // A lookup failure is not an app failure: the user can still drop a pin.
    return NextResponse.json({ results: [] as GeocodeResult[], unavailable: true }, { status: 200 });
  }
}
