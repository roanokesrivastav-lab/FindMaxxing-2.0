const DAY_MS = 86_400_000;
export const NEW_WINDOW_DAYS = 7;

/** ISO timestamp `days` ago: the cutoff for "new" (createdAfter) queries. */
export function newSince(days = NEW_WINDOW_DAYS, now: number = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/** "Added today", "Added yesterday", "Added 3 days ago". */
export function addedLabel(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return "Added today";
  if (days === 1) return "Added yesterday";
  return `Added ${days} days ago`;
}
