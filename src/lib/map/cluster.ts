/**
 * Map clustering (roadmap 2.1), pure and deterministic, the same for Mapbox and MapLibre because it
 * works on the markers the app already renders. At wide zooms, pins whose screen positions fall in the
 * same grid cell merge into a cluster; records at exactly the same coordinates always form a stack,
 * which opens the selected-pin preview with "1 of N" instead of zooming forever.
 */
import type { MapMarker } from "./types";

/** At this zoom and closer, nothing clusters (only exact co-locations stack). */
export const CLUSTER_MAX_ZOOM = 15;
/** Grid cell size in screen pixels at the current (whole) zoom. */
export const CLUSTER_CELL_PX = 64;

export interface MarkerBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type ClusterItem =
  | { type: "marker"; marker: MapMarker }
  | { type: "stack"; id: string; lat: number; lng: number; markers: MapMarker[] }
  | { type: "cluster"; id: string; lat: number; lng: number; markers: MapMarker[]; bounds: MarkerBounds };

/** Same spot: coordinates equal to about 1 cm. */
const spotKey = (m: { lat: number; lng: number }) => `${m.lat.toFixed(7)},${m.lng.toFixed(7)}`;
const byKindThenId = (a: MapMarker, b: MapMarker) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind === "place" ? -1 : 1);

/** Web Mercator world pixel coordinates at a zoom. */
function project(lat: number, lng: number, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom;
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return [((lng + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
}

/** Records at exactly the same coordinates, in a stable order (places first, then by id). */
export function stacksOf(markers: readonly MapMarker[]): MapMarker[][] {
  const groups = new Map<string, MapMarker[]>();
  for (const m of markers) {
    const k = spotKey(m);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  return [...groups.values()].map((g) => g.sort(byKindThenId));
}

function boundsOf(markers: readonly MapMarker[]): MarkerBounds {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const m of markers) {
    west = Math.min(west, m.lng);
    east = Math.max(east, m.lng);
    south = Math.min(south, m.lat);
    north = Math.max(north, m.lat);
  }
  return { west, south, east, north };
}

function stackItem(group: MapMarker[]): ClusterItem {
  if (group.length === 1) return { type: "marker", marker: group[0] };
  return { type: "stack", id: `stack:${spotKey(group[0])}`, lat: group[0].lat, lng: group[0].lng, markers: group };
}

/**
 * Groups markers for drawing at `zoom`. Every input marker appears in exactly one output item.
 * `keepSeparate` (the selected pin, and the keyboard-focused one) is never merged into a cluster, so the selection stays visible and
 * distinct; if it shares its spot with others, its whole stack stays out with it.
 */
export function clusterMarkers(markers: readonly MapMarker[], zoom: number, keepSeparate: string | readonly (string | null | undefined)[] | null = null): ClusterItem[] {
  const keep = new Set((Array.isArray(keepSeparate) ? keepSeparate : [keepSeparate]).filter((k): k is string => !!k));
  const all = stacksOf(markers);
  const isKept = (g: MapMarker[]) => g.some((m) => keep.has(m.id));
  const stacks = all.filter((g) => !isKept(g));
  const out: ClusterItem[] = all.filter(isKept).map(stackItem);
  if (zoom >= CLUSTER_MAX_ZOOM) {
    out.push(...stacks.map(stackItem));
    return sortItems(out);
  }
  const z = Math.floor(zoom);
  const cells = new Map<string, MapMarker[][]>();
  for (const group of stacks) {
    const [x, y] = project(group[0].lat, group[0].lng, z);
    const k = `${Math.floor(x / CLUSTER_CELL_PX)}:${Math.floor(y / CLUSTER_CELL_PX)}`;
    const cell = cells.get(k);
    if (cell) cell.push(group);
    else cells.set(k, [group]);
  }
  for (const [k, groups] of cells) {
    if (groups.length === 1) {
      out.push(stackItem(groups[0]));
      continue;
    }
    const members = groups.flat().sort(byKindThenId);
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lng = members.reduce((s, m) => s + m.lng, 0) / members.length;
    out.push({ type: "cluster", id: `cluster:${z}:${k}`, lat, lng, markers: members, bounds: boundsOf(members) });
  }
  return sortItems(out);
}

const itemKey = (i: ClusterItem) => (i.type === "marker" ? `${i.marker.kind}-${i.marker.id}` : i.id);
function sortItems(items: ClusterItem[]): ClusterItem[] {
  return items.sort((a, b) => (itemKey(a) < itemKey(b) ? -1 : itemKey(a) > itemKey(b) ? 1 : 0));
}

/** What a cluster or stack says: its count, marked partial when the map query was capped. */
export function clusterLabel(item: Extract<ClusterItem, { type: "cluster" | "stack" }>, partial: boolean): { count: string; label: string } {
  const n = item.markers.length;
  const places = item.markers.filter((m) => m.kind === "place").length;
  const events = n - places;
  const parts = [places ? `${places} place${places === 1 ? "" : "s"}` : null, events ? `${events} event${events === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
  const count = `${n}${partial ? "+" : ""}`;
  // The name starts with the visible count, so speech and sight agree (WCAG 2.5.3).
  if (item.type === "stack") return { count, label: `${count} at this spot${partial ? " (partial count)" : ""}: ${parts}. Open one at a time` };
  return { count, label: `${count} in this area${partial ? " (partial count: zoom in for all)" : ""}: ${parts}. Zoom in` };
}
