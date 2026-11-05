/**
 * The personal library (roadmap 3.2): search, filters, bulk edit with undo, and
 * export, over the owner's own saves only. One pure filter is shared by both
 * repositories, so demo and Supabase agree by construction.
 */
import type { Place } from "@/lib/data/types";
import { DataError } from "@/lib/data/types";
import { getCategory, searchTerms } from "@/lib/data/taxonomy";
import { SAVE_STATUSES, normalizeTag, type SaveDetails, type SaveDetailsInput, type SaveStatus } from "./saves";

/** What the place is (community) and why you saved it (yours), kept as two halves. */
export interface LibraryItem {
  place: Place;
  save: SaveDetails;
  listIds: string[];
}

export interface LibraryFilters {
  q: string;
  tag: string | null;
  status: SaveStatus | null;
  category: string | null;
}

export const LIBRARY_PAGE = 50;
export const BULK_MAX = 500;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function parseLibraryFilters(sp: Params): LibraryFilters {
  const status = one(sp.status);
  const category = one(sp.category).trim();
  const tag = normalizeTag(one(sp.tag));
  return {
    q: one(sp.q).trim().slice(0, 100),
    tag: tag || null,
    status: (SAVE_STATUSES as readonly string[]).includes(status) ? (status as SaveStatus) : null,
    category: category ? getCategory(category).slug : null,
  };
}

export const hasFilters = (f: LibraryFilters) => !!(f.q || f.tag || f.status || f.category);

/** Matches text against the place's community fields and the owner's own note, tags and recommender. */
export function filterLibrary(items: LibraryItem[], f: LibraryFilters): LibraryItem[] {
  const q = f.q.toLowerCase();
  return items.filter(({ place, save }) => {
    if (f.status && save.status !== f.status) return false;
    if (f.tag && !save.tags.includes(f.tag)) return false;
    if (f.category && place.categorySlug !== f.category) return false;
    if (!q) return true;
    return [place.name, place.neighborhood, place.city, save.note, save.recommendedBy, ...save.tags, ...searchTerms(place.categorySlug, place.tags)]
      .some((field) => field && field.toLowerCase().includes(q));
  });
}

/** Newest save first, then place id: the order both repositories page in. */
export const libraryOrder = (a: LibraryItem, b: LibraryItem) =>
  b.save.createdAt.localeCompare(a.save.createdAt) || (a.place.id < b.place.id ? -1 : 1);

export type BulkOp =
  | { kind: "addTag"; tag: string }
  | { kind: "removeTag"; tag: string }
  | { kind: "status"; status: SaveStatus }
  | { kind: "moveToList"; listId: string }
  | { kind: "remove" };

/** The state of one save before a bulk action, so the action can be undone exactly. */
export interface SaveSnapshot {
  placeId: string;
  saved: boolean;
  details: Required<Pick<SaveDetailsInput, "note" | "tags" | "sourceUrl" | "recommendedBy" | "status">> | null;
  listIds: string[];
}

export function checkBulk(placeIds: string[], op: BulkOp): { placeIds: string[]; op: BulkOp } {
  const ids = [...new Set(placeIds)];
  if (!ids.length) throw new DataError("Select at least one place", "invalid");
  if (ids.length > BULK_MAX) throw new DataError(`At most ${BULK_MAX} places at once`, "invalid");
  if (op.kind === "addTag" || op.kind === "removeTag") {
    const tag = normalizeTag(op.tag);
    if (!tag || tag.length > 24) throw new DataError("Tags are 1–24 characters", "invalid");
    return { placeIds: ids, op: { kind: op.kind, tag } };
  }
  if (op.kind === "status" && !(SAVE_STATUSES as readonly string[]).includes(op.status)) throw new DataError("Unknown status", "invalid");
  if (!["addTag", "removeTag", "status", "moveToList", "remove"].includes(op.kind)) throw new DataError("Unknown action", "invalid");
  return { placeIds: ids, op };
}

/** The new details for one save under a bulk op (null for remove / list-only ops). */
export function applyBulk(save: SaveDetails, op: BulkOp): SaveDetailsInput | null {
  switch (op.kind) {
    case "addTag":
      return save.tags.includes(op.tag) ? null : { tags: [...save.tags, op.tag].slice(0, 10) };
    case "removeTag":
      return save.tags.includes(op.tag) ? { tags: save.tags.filter((t) => t !== op.tag) } : null;
    case "status":
      return save.status === op.status ? null : { status: op.status };
    default:
      return null;
  }
}

export const snapshotOf = (item: { save: SaveDetails; listIds: string[] } | null, placeId: string): SaveSnapshot =>
  item
    ? {
        placeId,
        saved: true,
        details: { note: item.save.note, tags: item.save.tags, sourceUrl: item.save.sourceUrl, recommendedBy: item.save.recommendedBy, status: item.save.status },
        listIds: item.listIds,
      }
    : { placeId, saved: false, details: null, listIds: [] };

export function bulkSummary(op: BulkOp, n: number): string {
  const places = `${n} place${n === 1 ? "" : "s"}`;
  switch (op.kind) {
    case "addTag":
      return `Tagged ${places} “${op.tag}”`;
    case "removeTag":
      return `Removed “${op.tag}” from ${places}`;
    case "status":
      return `Marked ${places} as ${op.status === "visited" ? "visited" : "want to go"}`;
    case "moveToList":
      return `Moved ${places} to the list`;
    case "remove":
      return `Removed ${places} from your saves`;
  }
}

// ----------------------------------------------------------------------------
// Export (owner only): CSV and JSON
// ----------------------------------------------------------------------------
export interface ExportRow {
  name: string;
  category: string;
  neighborhood: string | null;
  city: string;
  address: string | null;
  lat: number;
  lng: number;
  link: string;
  status: SaveStatus;
  tags: string[];
  note: string | null;
  recommended_by: string | null;
  source_url: string | null;
  lists: string[];
  saved_at: string;
}

export function exportRows(items: LibraryItem[], listNames: Map<string, string>, siteUrl: string): ExportRow[] {
  return [...items].sort(libraryOrder).map(({ place, save, listIds }) => ({
    name: place.name,
    category: getCategory(place.categorySlug).label,
    neighborhood: place.neighborhood,
    city: place.city,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    link: `${siteUrl.replace(/\/$/, "")}/places/${place.id}`,
    status: save.status,
    tags: save.tags,
    note: save.note,
    recommended_by: save.recommendedBy,
    source_url: save.sourceUrl,
    lists: listIds.map((id) => listNames.get(id)).filter((n): n is string => !!n),
    saved_at: save.createdAt,
  }));
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula are prefixed with a quote. */
export function toCsv(rows: ExportRow[]): string {
  const headers = ["name", "category", "neighborhood", "city", "address", "lat", "lng", "link", "status", "tags", "note", "recommended_by", "source_url", "lists", "saved_at"] as const;
  const cell = (v: unknown) => {
    if (typeof v === "number") return String(v);
    let s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))].join("\r\n") + "\r\n";
}
