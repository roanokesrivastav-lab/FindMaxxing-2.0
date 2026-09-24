import type { Event, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import type { MapMarker } from "./types";

/** Accepts a full place or a compact map record. */
export function placeMarker(p: Pick<Place, "id" | "lat" | "lng" | "categorySlug" | "name">): MapMarker {
  const c = getCategory(p.categorySlug);
  return { id: p.id, kind: "place", lat: p.lat, lng: p.lng, color: c.color, emoji: c.emoji, label: p.name };
}

/** Accepts a full event or a compact map record. */
export function eventMarker(e: Pick<Event, "id" | "lat" | "lng" | "categorySlug" | "title">): MapMarker {
  const c = getCategory(e.categorySlug);
  return { id: e.id, kind: "event", lat: e.lat, lng: e.lng, color: "#6b4cff", emoji: c.emoji, label: e.title };
}
