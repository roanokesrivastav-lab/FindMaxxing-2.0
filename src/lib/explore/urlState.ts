/**
 * Explore's restorable state in the URL (roadmap 2.2): camera, filters, selection and map/list view,
 * so opening a detail page and coming back (or sharing the link) returns to the same map. Parsing is
 * strict: anything unknown or out of range is dropped, never guessed.
 */
import { CATEGORY_MAP, INTEREST_MAP } from "@/lib/data/taxonomy";
import type { GeoBounds } from "@/lib/data/types";
import { MAP_INTEREST_LIMIT } from "@/lib/onboarding/interests";

export interface ExploreCamera {
  lat: number;
  lng: number;
  zoom: number;
}

export interface ExploreUrlState {
  camera: ExploreCamera | null;
  q: string;
  category: string | null;
  tags: string[];
  kind: "all" | "places" | "events";
  sel: { kind: "place" | "event"; id: string } | null;
  view: "map" | "list";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

type Params = Record<string, string | string[] | undefined> | URLSearchParams;
const read = (sp: Params, key: string): string | undefined => {
  const v = sp instanceof URLSearchParams ? (sp.get(key) ?? undefined) : sp[key];
  return typeof v === "string" ? v : undefined;
};

export function parseExploreState(sp: Params): ExploreUrlState {
  const at = read(sp, "at")?.split(",").map(Number);
  const camera =
    at && at.length === 3 && at.every(Number.isFinite) && Math.abs(at[0]) <= 85 && Math.abs(at[1]) <= 180 && at[2] >= MIN_ZOOM && at[2] <= MAX_ZOOM
      ? { lat: at[0], lng: at[1], zoom: at[2] }
      : null;
  const category = read(sp, "category");
  const kind = read(sp, "kind");
  const sel = read(sp, "sel")?.split(":");
  const tags = Array.from(new Set((read(sp, "tags") ?? "").split(",").filter((t) => t in INTEREST_MAP))).slice(0, MAP_INTEREST_LIMIT);
  return {
    camera,
    q: (read(sp, "q") ?? "").trim().slice(0, 80),
    category: category && category in CATEGORY_MAP ? category : null,
    tags,
    kind: kind === "places" || kind === "events" ? kind : "all",
    sel: sel && sel.length === 2 && (sel[0] === "place" || sel[0] === "event") && UUID.test(sel[1]) ? { kind: sel[0], id: sel[1].toLowerCase() } : null,
    view: read(sp, "view") === "list" ? "list" : "map",
  };
}

/** The query string for a state; defaults are left out so the plain map stays at "/". */
export function serializeExploreState(s: ExploreUrlState): string {
  const q = new URLSearchParams();
  if (s.camera) q.set("at", `${s.camera.lat.toFixed(5)},${s.camera.lng.toFixed(5)},${s.camera.zoom.toFixed(2)}`);
  if (s.q.trim()) q.set("q", s.q.trim());
  if (s.category) q.set("category", s.category);
  if (s.tags.length) q.set("tags", s.tags.join(","));
  if (s.kind !== "all") q.set("kind", s.kind);
  if (s.sel) q.set("sel", `${s.sel.kind}:${s.sel.id}`);
  if (s.view === "list") q.set("view", "list");
  return q.toString();
}

/**
 * About the area a camera shows on a phone, for the server's first paint only; the client re-queries
 * with the real bounds once the map loads. Matches the default request's span at the default zoom.
 */
export function approximateBounds(c: ExploreCamera, defaultZoom: number): GeoBounds {
  const scale = 2 ** (defaultZoom - c.zoom);
  const lat = Math.min(0.07 * scale, 80);
  const lng = Math.min(0.12 * scale, 179);
  return { north: Math.min(85, c.lat + lat), south: Math.max(-85, c.lat - lat), east: Math.min(180, c.lng + lng), west: Math.max(-180, c.lng - lng) };
}
