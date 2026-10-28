/**
 * The local-tier rules that the UI and both repositories need as dates.
 * The authoritative checks are public.is_local() and the profiles trigger in
 * 0010_moderation.sql; the demo store mirrors them with these helpers.
 */
import { HOME_CITY_COOLDOWN_DAYS, LOCAL_MIN_ACCOUNT_AGE_DAYS } from "./types";

const DAY_MS = 86_400_000;

/** When the home city may next change, or null when it may change now. */
export function nextHomeCityChange(homeCity: string | null, changedAt: string | null, now = Date.now()): string | null {
  if (!homeCity || !changedAt) return null;
  const next = new Date(changedAt).getTime() + HOME_CITY_COOLDOWN_DAYS * DAY_MS;
  return next > now ? new Date(next).toISOString() : null;
}

/** Whether an account created at `createdAt` is old enough to count as a local. */
export function oldEnoughToBeLocal(createdAt: string, now = Date.now()): boolean {
  return new Date(createdAt).getTime() <= now - LOCAL_MIN_ACCOUNT_AGE_DAYS * DAY_MS;
}

/** When an account created at `createdAt` starts counting as a local. */
export function localEligibleAt(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + LOCAL_MIN_ACCOUNT_AGE_DAYS * DAY_MS).toISOString();
}

/** Case and spacing do not make a different city. */
export function sameCity(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export function homeCityCooldownMessage(next: string): string {
  const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(next));
  return `You can change your home city again on ${date}`;
}
