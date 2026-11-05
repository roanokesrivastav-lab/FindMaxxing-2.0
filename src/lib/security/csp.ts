/**
 * Content-Security-Policy. Set per request by src/proxy.ts with a fresh nonce;
 * Next reads the nonce from the request's CSP header and puts it on its own
 * inline scripts, and 'strict-dynamic' lets those load the rest of the bundle.
 *
 * Allowed origins, and why:
 *   Supabase (*.supabase.co/.in) — avatar images, and (Session 15) realtime
 *   OpenFreeMap — MapLibre's keyless style, tiles, glyphs and sprites
 *   Mapbox (*.mapbox.com)        — style, tiles and telemetry when a token is set
 *   blob:                        — map web workers, and photo previews before upload
 * Styles allow 'unsafe-inline': the map libraries set inline styles on the
 * elements they create, which nonces cannot cover.
 */
export function buildCsp(nonce: string, { dev = false }: { dev?: boolean } = {}): string {
  const supabase = ["https://*.supabase.co", "https://*.supabase.in"];
  const maps = ["https://tiles.openfreemap.org", "https://*.mapbox.com"];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...supabase, "https://images.unsplash.com", ...maps],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...supabase, "wss://*.supabase.co", ...maps, "https://events.mapbox.com", ...(dev ? ["ws:"] : [])],
    "worker-src": ["'self'", "blob:"],
    "child-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!dev) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/** 128 random bits, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
