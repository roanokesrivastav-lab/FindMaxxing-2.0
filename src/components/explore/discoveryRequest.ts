/**
 * The explore screen's discovery request, shared by the server page (first
 * paint) and the client hook, so both ask for the same thing the same way.
 */
import type { Event, EventMapRecord, GeoBounds, MapResult, Page, Place, PlaceMapRecord } from "@/lib/data/types";
import { bboxParam } from "@/lib/map/bounds";

export type DiscoveryKind = "all" | "places" | "events";

export interface DiscoveryRequest {
  /** Null searches everywhere. */
  bounds: GeoBounds | null;
  text: string;
  category: string | null;
  tags: string[];
  kind: DiscoveryKind;
}

export interface DiscoveryResults {
  placeMarkers: MapResult<PlaceMapRecord> | null;
  eventMarkers: MapResult<EventMapRecord> | null;
  places: Page<Place>;
  events: Page<Event>;
}

/** Settle time after the last map move or keystroke before querying. */
export const DISCOVERY_DEBOUNCE_MS = 250;
export const PLACE_PAGE = 30;
export const EVENT_PAGE = 20;

export function requestKey(r: DiscoveryRequest): string {
  return JSON.stringify([r.bounds ? bboxParam(r.bounds) : null, r.text.trim(), r.category, [...r.tags].sort(), r.kind]);
}

export function discoveryQuery(r: DiscoveryRequest, extra: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  if (r.bounds) q.set("bbox", bboxParam(r.bounds));
  if (r.text.trim()) q.set("q", r.text.trim());
  if (r.category) q.set("category", r.category);
  if (r.tags.length) q.set("tags", r.tags.join(","));
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined) q.set(k, String(v));
  return q.toString();
}

