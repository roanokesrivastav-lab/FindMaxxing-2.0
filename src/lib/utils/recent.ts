const DAY_MS = 86_400_000;
export const NEW_WINDOW_DAYS = 7;

/** Items created within the last `days`, newest first. */
export function newestWithin<T extends { createdAt: string }>(items: T[], days = NEW_WINDOW_DAYS, now: number = Date.now()): T[] {
  const since = now - days * DAY_MS;
  return items.filter((item) => new Date(item.createdAt).getTime() >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** "Added today", "Added yesterday", "Added 3 days ago". */
export function addedLabel(iso: string, now: number = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return "Added today";
  if (days === 1) return "Added yesterday";
  return `Added ${days} days ago`;
}
