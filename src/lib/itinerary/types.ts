/**
 * Shared itinerary types (6.0 SPEC §3). Pure: no I/O, safe on server and client.
 */

export type LatLng = { lat: number; lng: number };

/** Which walking router produced the legs. Walking only (X3). */
export type RouterId = "fake" | "mapbox-walking" | "graphhopper-foot";

export type LegUnknownReason = "timeout" | "no_route" | "provider_error" | "not_configured";

/**
 * One walking leg between two consecutive points. `seconds` and `meters` are provider output when the
 * router is a real provider: they are used for one validation and never persisted (decision R-2).
 */
export type LegResult =
  | { status: "ok"; seconds: number; meters: number }
  | { status: "unknown"; reason: LegUnknownReason };
