import type { Event, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import type { MapMarker } from "./types";
import { formatInZone, timeZoneLabel } from "@/lib/utils/format";

const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** What a screen reader announces for a place pin: name, category, rating. */
export function placePinLabel(p: { name: string; categorySlug: string; ratingAvg?: number; ratingCount?: number }): string {
  const category = getCategory(p.categorySlug).label;
  const rating = p.ratingCount
    ? `rated ${(p.ratingAvg ?? 0).toFixed(1)} from ${p.ratingCount} rating${p.ratingCount === 1 ? "" : "s"}`
    : "not rated yet";
  return `${p.name}, ${category}, ${rating}`;
}

/** What a screen reader announces for an event pin: title, category, when. */
export function eventPinLabel(e: { title: string; categorySlug: string; startsAt?: string }, timeZone: string): string {
  const category = getCategory(e.categorySlug).label;
  return e.startsAt ? `${e.title}, ${category} event, ${formatInZone(e.startsAt, { timeZone }, WHEN)} ${timeZoneLabel(e.startsAt, { timeZone })}` : `${e.title}, ${category} event`;
}

/** Accepts a full place or a compact map record. */
export function placeMarker(p: Pick<Place, "id" | "lat" | "lng" | "categorySlug" | "name"> & Partial<Pick<Place, "ratingAvg" | "ratingCount">>): MapMarker {
  const c = getCategory(p.categorySlug);
  return { id: p.id, kind: "place", lat: p.lat, lng: p.lng, color: c.color, categorySlug: p.categorySlug, label: placePinLabel(p) };
}

/** Accepts a full event or a compact map record; times are labelled in `timeZone`. */
export function eventMarker(e: Pick<Event, "id" | "lat" | "lng" | "categorySlug" | "title"> & Partial<Pick<Event, "startsAt">>, timeZone: string): MapMarker {
  return { id: e.id, kind: "event", lat: e.lat, lng: e.lng, color: "#6b4cff", categorySlug: e.categorySlug, label: eventPinLabel(e, timeZone) };
}
