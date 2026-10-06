import type { Event, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import type { MapMarker } from "./types";

const WHEN = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What a screen reader announces for a place pin: name, category, rating. */
export function placePinLabel(p: { name: string; categorySlug: string; ratingAvg?: number; ratingCount?: number }): string {
  const category = getCategory(p.categorySlug).label;
  const rating = p.ratingCount
    ? `rated ${(p.ratingAvg ?? 0).toFixed(1)} from ${p.ratingCount} rating${p.ratingCount === 1 ? "" : "s"}`
    : "not rated yet";
  return `${p.name}, ${category}, ${rating}`;
}

/** What a screen reader announces for an event pin: title, category, when. */
export function eventPinLabel(e: { title: string; categorySlug: string; startsAt?: string }): string {
  const category = getCategory(e.categorySlug).label;
  return e.startsAt ? `${e.title}, ${category} event, ${WHEN.format(new Date(e.startsAt))}` : `${e.title}, ${category} event`;
}

/** Accepts a full place or a compact map record. */
export function placeMarker(p: Pick<Place, "id" | "lat" | "lng" | "categorySlug" | "name"> & Partial<Pick<Place, "ratingAvg" | "ratingCount">>): MapMarker {
  const c = getCategory(p.categorySlug);
  return { id: p.id, kind: "place", lat: p.lat, lng: p.lng, color: c.color, emoji: c.emoji, label: placePinLabel(p) };
}

/** Accepts a full event or a compact map record. */
export function eventMarker(e: Pick<Event, "id" | "lat" | "lng" | "categorySlug" | "title"> & Partial<Pick<Event, "startsAt">>): MapMarker {
  const c = getCategory(e.categorySlug);
  return { id: e.id, kind: "event", lat: e.lat, lng: e.lng, color: "#6b4cff", emoji: c.emoji, label: eventPinLabel(e) };
}
