/**
 * Discovery query rules shared by the Supabase and demo repositories, so the
 * two cannot drift: limits, cursor encoding, filter validation, and how search
 * text expands into taxonomy matches.
 */
import { neighborhoodKey } from "@/lib/utils/neighborhoods";
import { CATEGORIES, INTERESTS } from "./taxonomy";
import { DataError, type DiscoveryFilters, type GeoBounds, type Page } from "./types";

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_MAP_MARKERS = 300;
export const MAX_MAP_MARKERS = 1000;
/** Events stay discoverable for this long after they end (or start, with no end). */
export const UPCOMING_GRACE_MS = 60 * 60_000;
export const MAX_SEARCH_TEXT = 80;

export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

// ----------------------------------------------------------------------------
// Cursors: opaque base64url of [sortKey, id]. The sort key is kept as the exact
// string the store returned; Postgres timestamps carry microseconds that a JS
// Date would round away, which would skip or repeat rows at page boundaries.
// ----------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2})(?::?(\d{2}))?)$/;

/**
 * True for a real instant in the accepted format. The pattern alone admits
 * 2026-99-99 or February 30th, which Postgres rejects as a timestamptz
 * argument; that must surface as an invalid cursor, not a server error.
 */
export function isValidTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const [offsetHours, offsetMinutes] = [Number(m[9] ?? 0), Number(m[10] ?? 0)];
  if (year < 1 || hour > 23 || minute > 59 || second > 59 || offsetHours > 15 || offsetMinutes > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export interface Cursor {
  key: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(token: string | null | undefined): Cursor | null {
  if (!token) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) && parsed.length === 2 &&
      typeof parsed[0] === "string" && isValidTimestamp(parsed[0]) &&
      typeof parsed[1] === "string" && UUID.test(parsed[1])
    ) {
      return { key: parsed[0], id: parsed[1].toLowerCase() };
    }
  } catch {
    // fall through
  }
  throw new DataError("Invalid page cursor", "invalid");
}

/** Orders two cursor keys by instant, independent of their string format. */
export function compareTimestamps(a: string, b: string): number {
  // Milliseconds from Date, plus the sub-millisecond digits Date drops.
  const parts = (v: string): [number, number] => {
    const frac = /\.(\d{1,6})/.exec(v)?.[1] ?? "";
    return [new Date(v).getTime(), Number(frac.padEnd(6, "0").slice(3))];
  };
  const [ams, aus] = parts(a);
  const [bms, bus] = parts(b);
  return Math.sign(ams - bms || aus - bus);
}

/**
 * Builds a page from rows fetched with limit + 1: the extra row only signals
 * that another page exists, and the cursor points at the last row returned.
 */
export function toPage<R, T>(rows: R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => Cursor): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(map), nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null };
}

// ----------------------------------------------------------------------------
// Filters
// ----------------------------------------------------------------------------
export function validateBounds(bounds: GeoBounds | null | undefined): GeoBounds | null {
  if (!bounds) return null;
  const { north, south, east, west } = bounds;
  const lat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
  const lng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;
  if (!lat(north) || !lat(south) || !lng(east) || !lng(west) || south > north) {
    throw new DataError("Invalid map bounds", "invalid");
  }
  return { north, south, east, west };
}

export function inBounds(point: { lat: number; lng: number }, b: GeoBounds | null): boolean {
  if (!b) return true;
  if (point.lat < b.south || point.lat > b.north) return false;
  return b.west <= b.east ? point.lng >= b.west && point.lng <= b.east : point.lng >= b.west || point.lng <= b.east;
}

export interface SearchText {
  /** Trimmed literal substring, or null for no text filter. */
  text: string | null;
  /** Categories whose label, hint or keywords contain the text. */
  categories: string[];
  /** Interests whose label or keywords contain the text. */
  tags: string[];
}

/**
 * Mirrors what the explore screen has always searched: a record matches when
 * its own text contains the query, or its category or tags do by taxonomy
 * label, hint or keyword.
 */
export function expandSearchText(raw: string | null | undefined): SearchText {
  const text = (raw ?? "").trim().slice(0, MAX_SEARCH_TEXT);
  if (!text) return { text: null, categories: [], tags: [] };
  const q = text.toLowerCase();
  const has = (values: (string | undefined)[]) => values.some((v) => v?.toLowerCase().includes(q));
  return {
    text,
    categories: CATEGORIES.filter((c) => has([c.label, c.hint, ...c.keywords])).map((c) => c.slug),
    tags: INTERESTS.filter((i) => has([i.label, ...(i.keywords ?? [])])).map((i) => i.slug),
  };
}

export interface NormalizedFilters {
  bounds: GeoBounds | null;
  search: SearchText;
  category: string | null;
  tags: string[];
  /** Comparison key (see neighborhoodKey), or null for no filter. */
  neighborhood: string | null;
  createdAfter: string | null;
}

/** Null for no value; throws DataError("invalid") for anything Postgres would refuse as a timestamptz. */
export function normalizeTimestamp(value: string | null | undefined, label: string): string | null {
  if (!value) return null;
  if (!isValidTimestamp(value)) throw new DataError(`Invalid ${label}`, "invalid");
  return value;
}

export function normalizeFilters(filters: DiscoveryFilters): NormalizedFilters {
  return {
    bounds: validateBounds(filters.bounds),
    search: expandSearchText(filters.text),
    category: filters.category || null,
    tags: Array.from(new Set(filters.tags ?? [])),
    neighborhood: neighborhoodKey(filters.neighborhood ?? "") || null,
    createdAfter: normalizeTimestamp(filters.createdAfter, "createdAfter"),
  };
}

/** Case-insensitive literal substring test, the demo twin of the SQL ILIKE. */
export function textMatches(values: (string | null | undefined)[], text: string | null): boolean {
  if (!text) return true;
  const q = text.toLowerCase();
  return values.some((v) => !!v && v.toLowerCase().includes(q));
}
