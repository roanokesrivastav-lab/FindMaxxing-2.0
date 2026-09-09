const DATE_LONG = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DATE_FULL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export function formatEventDate(iso: string): string {
  return DATE_LONG.format(new Date(iso));
}
export function formatEventDateLong(iso: string): string {
  return DATE_FULL.format(new Date(iso));
}
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}
export function formatTimeRange(startsAt: string, endsAt: string | null): string {
  const start = formatTime(startsAt);
  return endsAt ? `${start} – ${formatTime(endsAt)}` : start;
}

/** "Sat, Sep 12 · 3:00 PM" */
export function formatEventWhen(startsAt: string, endsAt: string | null): string {
  return `${formatEventDate(startsAt)} · ${formatTimeRange(startsAt, endsAt)}`;
}

/** Friendly relative label: "Today", "Tomorrow", "In 3 days", "Past". */
export function relativeDayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDay.getTime() - startOfToday.getTime()) / 86_400_000);
  if (d.getTime() < now.getTime() && diffDays <= 0) return diffDays === 0 ? "Today" : "Past";
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return DATE_LONG.format(d).split(",")[0];
  return `In ${diffDays} days`;
}

export function formatRating(avg: number): string {
  return avg > 0 ? avg.toFixed(1) : "–";
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** Convert a Date into the value format used by <input type="date"> / "time". */
export function toDateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function toTimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** True once the event's end (or start, if no end) is in the past. */
export function eventHasEnded(startsAt: string, endsAt: string | null, now: number = Date.now()): boolean {
  return new Date(endsAt ?? startsAt).getTime() < now;
}
