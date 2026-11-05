/**
 * Local tips with provenance (roadmap 2.6, migration 0060). Shared by both
 * repositories and the UI. A tip has an author, a kind and, when temporary, an
 * expiry. Confirmations ("Still true?") by anyone but the author move
 * lastConfirmed; an edit never does. Corrections are attributed suggestions.
 */
import type { ProfileSummary } from "@/lib/data/types";
import { DataError } from "@/lib/data/types";

export const TIP_KINDS = ["story", "practical", "temporary"] as const;
export type TipKind = (typeof TIP_KINDS)[number];
export const TIP_KIND_LABEL: Record<TipKind, string> = {
  story: "Lasting story",
  practical: "Practical tip",
  temporary: "Temporary condition",
};
export const TIP_MAX = 280;
/** A temporary condition may run for at most this long. */
export const TIP_MAX_EXPIRY_DAYS = 90;
/** "Recent" for the place page's observation: confirmed within this many days. */
export const OBSERVATION_WINDOW_DAYS = 180;

export type TipStatus = "published" | "hidden" | "removed";

export interface PlaceTip {
  id: string;
  placeId: string;
  body: string;
  kind: TipKind;
  expiresAt: string | null;
  status: TipStatus;
  author: ProfileSummary | null;
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string | null;
  lastConfirmedBy: ProfileSummary | null;
}

export interface TipConfirmation {
  user: ProfileSummary | null;
  createdAt: string;
}
export interface TipCorrection {
  id: string;
  body: string;
  author: ProfileSummary | null;
  createdAt: string;
}
/** What a tip's claim is based on: the tip, every confirmation, every correction. */
export interface TipEvidence {
  tip: PlaceTip;
  confirmations: TipConfirmation[];
  corrections: TipCorrection[];
}

export interface TipInput {
  body: string;
  kind: TipKind;
  expiresAt?: string | null;
}

/** Validates and normalizes a tip; throws DataError("invalid") with a readable message. */
export function normalizeTipInput(input: TipInput, now = Date.now()): { body: string; kind: TipKind; expiresAt: string | null } {
  const body = (input.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) throw new DataError("Write the tip first", "invalid");
  if (body.length > TIP_MAX) throw new DataError(`Keep it under ${TIP_MAX} characters`, "invalid");
  if (!(TIP_KINDS as readonly string[]).includes(input.kind)) throw new DataError("Choose what kind of tip it is", "invalid");
  if (input.kind !== "temporary") return { body, kind: input.kind, expiresAt: null };
  const t = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
  if (!Number.isFinite(t)) throw new DataError("A temporary condition needs an end date", "invalid");
  if (t <= now) throw new DataError("The end date must be in the future", "invalid");
  if (t > now + TIP_MAX_EXPIRY_DAYS * 86_400_000) throw new DataError(`A temporary condition can run at most ${TIP_MAX_EXPIRY_DAYS} days`, "invalid");
  return { body, kind: "temporary", expiresAt: new Date(t).toISOString() };
}

export function normalizeCorrection(body: string): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new DataError("Write the correction first", "invalid");
  if (text.length > TIP_MAX) throw new DataError(`Keep it under ${TIP_MAX} characters`, "invalid");
  return text;
}

/** Current = published and not expired. The only tips discovery and the place page show. */
export function isCurrentTip(tip: Pick<PlaceTip, "status" | "expiresAt">, now = Date.now()): boolean {
  return tip.status === "published" && (!tip.expiresAt || Date.parse(tip.expiresAt) > now);
}

/**
 * The place page's "most relevant recent observation": a current tip confirmed by
 * someone other than its author within OBSERVATION_WINDOW_DAYS, most recently
 * confirmed first. Null when there is none: an unconfirmed tip is not an observation.
 */
export function recentObservation(tips: PlaceTip[], now = Date.now()): PlaceTip | null {
  const cutoff = now - OBSERVATION_WINDOW_DAYS * 86_400_000;
  return (
    tips
      .filter((t) => isCurrentTip(t, now) && t.lastConfirmedAt && Date.parse(t.lastConfirmedAt) >= cutoff)
      .sort((a, b) => b.lastConfirmedAt!.localeCompare(a.lastConfirmedAt!) || (a.id < b.id ? -1 : 1))[0] ?? null
  );
}

/** Current tips in display order: most recently confirmed first, then newest. */
export function orderTips(tips: PlaceTip[]): PlaceTip[] {
  return [...tips].sort(
    (a, b) =>
      (b.lastConfirmedAt ?? "").localeCompare(a.lastConfirmedAt ?? "") ||
      b.createdAt.localeCompare(a.createdAt) ||
      (a.id < b.id ? -1 : 1),
  );
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "4 months ago", "a year ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? "a week ago" : `${w} weeks ago`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m === 1 ? "a month ago" : `${m} months ago`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? "a year ago" : `${y} years ago`;
}

/** The request's clock, read once by the server page (kept out of render for the purity lint). */
export function requestNow(): number {
  return Date.now();
}
