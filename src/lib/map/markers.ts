import type { Event, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import type { MapMarker } from "./types";

export function placeMarker(p: Place): MapMarker {
  const c = getCategory(p.categorySlug);
  return { id: p.id, kind: "place", lat: p.lat, lng: p.lng, color: c.color, emoji: c.emoji, label: p.name };
}

export function eventMarker(e: Event): MapMarker {
  const c = getCategory(e.categorySlug);
  return { id: e.id, kind: "event", lat: e.lat, lng: e.lng, color: "#6b4cff", emoji: c.emoji, label: e.title };
}
