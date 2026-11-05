/**
 * Sponsored-card rules shared by both repositories (0023_ads.sql raises
 * "ads:<key>"; the demo repository throws the same).
 */
import { DataError } from "./types";

/** $5 per 1,000 impressions. */
export const AD_CPM_CENTS = 500;
export const MIN_AD_BUDGET_CENTS = 2000;
export const MAX_AD_BUDGET_CENTS = 100_000;
export const MAX_AD_DAYS = 60;
/** Where the one sponsored card of a list goes: after this many organic results. */
export const AD_POSITION = { places: 4, events: 2 } as const;

export const impressionBudget = (budgetCents: number) => budgetCents * 2;

/** Impressions a day for a campaign to last its whole run. */
export function dailyCap(budgetCents: number, startsAt: string, endsAt: string): number {
  const days = Math.max(Math.ceil((Date.parse(endsAt) - Date.parse(startsAt)) / 1000 / 86400), 1);
  return Math.ceil(impressionBudget(budgetCents) / days);
}

const ERRORS = {
  bad_target: ["You can promote your own public place or upcoming event", "invalid"],
  bad_dates: ["Choose an end date after the start, at most 60 days later", "invalid"],
  bad_budget: ["Budgets go from $20 to $1,000", "invalid"],
  not_found: ["That campaign isn't available", "not_found"],
  not_pending: ["That campaign was already reviewed", "conflict"],
  bad_headline: ["Headlines are 3 to 60 characters; the text up to 140", "invalid"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type AdsErrorKey = keyof typeof ERRORS;

export function adsError(key: AdsErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

export function parseAdsMessage(message: string): DataError | null {
  const m = /ads:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? adsError(m[1] as AdsErrorKey) : null;
}

/** Checks the parts the database enforces with constraints, in the user's words. */
export function validateCampaign(input: { headline: string; body: string | null; startsAt: string; endsAt: string; budgetCents: number; bounds: { north: number; south: number; east: number; west: number } | null }) {
  const headline = input.headline.trim();
  if (headline.length < 3 || headline.length > 60 || (input.body ?? "").length > 140) throw adsError("bad_headline");
  if (!Number.isInteger(input.budgetCents) || input.budgetCents < MIN_AD_BUDGET_CENTS || input.budgetCents > MAX_AD_BUDGET_CENTS) throw adsError("bad_budget");
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Math.max(start, Date.now()) || end > start + MAX_AD_DAYS * 86_400_000) throw adsError("bad_dates");
  const b = input.bounds;
  if (b && !(b.north > b.south && b.north <= 90 && b.south >= -90 && Math.abs(b.east) <= 180 && Math.abs(b.west) <= 180)) throw new DataError("Invalid area", "invalid");
}
