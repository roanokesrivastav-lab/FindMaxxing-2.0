/** Keyless fallback style (OpenFreeMap, OpenMapTiles schema). */
export const MAPLIBRE_FALLBACK_STYLE = "https://tiles.openfreemap.org/styles/positron";

export function mapProvider(): "mapbox" | "maplibre" {
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN ? "mapbox" : "maplibre";
}
