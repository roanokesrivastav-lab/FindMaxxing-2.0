/** Keyless fallback style (OpenFreeMap, OpenMapTiles schema). */
export const MAPLIBRE_FALLBACK_STYLE = "https://tiles.openfreemap.org/styles/positron";

/**
 * Mapbox only with something that looks like a public token: a secret (sk.)
 * token must never reach the browser, and anything else would just fail to
 * load. Everything else uses MapLibre, which needs no key. A pk. token that
 * Mapbox rejects at runtime falls back too (see MapView).
 */
export function mapProvider(token: string | undefined = process.env.NEXT_PUBLIC_MAPBOX_TOKEN): "mapbox" | "maplibre" {
  return token && /^pk\.[A-Za-z0-9._-]{20,}$/.test(token) ? "mapbox" : "maplibre";
}
