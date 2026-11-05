"use client";
import { formatInZone, formatTimeRange, relativeDayLabel, timeZoneLabel } from "@/lib/utils/format";
import { useViewerTime } from "./ViewerTime";

/**
 * Text for an instant in the viewer's zone, usable from server components.
 * Renders with the shared snapshot first, so hydration always matches.
 */
export function LocalDate({ value, format, zone = false }: { value: string; format: Intl.DateTimeFormatOptions; zone?: boolean }) {
  const time = useViewerTime();
  return <>{zone ? `${formatInZone(value, time, format)} ${timeZoneLabel(value, time)}` : formatInZone(value, time, format)}</>;
}

/** "3:00 PM – 5:00 PM EDT" in the viewer's zone. */
export function LocalTimeRange({ startsAt, endsAt }: { startsAt: string; endsAt: string | null }) {
  return <>{formatTimeRange(startsAt, endsAt, useViewerTime())}</>;
}

/** "Today", "Tomorrow", a weekday or "In 9 days", by the viewer's calendar. */
export function LocalDayLabel({ value }: { value: string }) {
  return <>{relativeDayLabel(value, useViewerTime())}</>;
}
