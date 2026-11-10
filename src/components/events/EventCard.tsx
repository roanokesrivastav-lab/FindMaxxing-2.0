"use client";
import Link from "next/link";
import { readableInk } from "@/lib/utils/contrast";
import { Users, MapPin } from "lucide-react";
import type { Event } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import { eventHasEnded, formatEventDate, formatInZone, formatTimeRange, relativeDayLabel } from "@/lib/utils/format";
import { useViewerTime } from "@/components/time/ViewerTime";
import { cn } from "@/lib/utils/cn";
import { AvatarStack } from "@/components/ui/Avatar";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";
import { activitySummary } from "@/lib/activity";
import { readinessText } from "@/lib/readiness";
import { usePilotFlag } from "@/components/shared/PilotFlags";

export function EventCard({
  event,
  compact,
  className,
  attendees,
  onHover,
}: {
  event: Event;
  compact?: boolean;
  className?: string;
  attendees?: { id: string; displayName: string; avatarUrl: string | null }[];
  onHover?: () => void;
}) {
  const c = getCategory(event.categorySlug);
  const time = useViewerTime();
  const isPast = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const cancelled = event.status === "cancelled";
  // Seats held by a paid checkout count too (events_readiness); without it, fall back to the going count.
  const full = event.readiness?.spotsOpen != null ? event.readiness.spotsOpen === 0 : event.capacity !== null && event.attendeeCount >= event.capacity;
  const day = relativeDayLabel(event.startsAt, time);
  const pilotEvents = usePilotFlag("pilotEvents");
  const activity = pilotEvents ? activitySummary(event.activityDetails) : null;
  return (
    <Link
      href={`/events/${event.id}`}
      onMouseEnter={onHover}
      className={cn("card flex gap-3 hover:shadow-float transition-shadow group", compact ? "p-3" : "p-4", (isPast || cancelled) && "opacity-70", className)}
    >
      {/* Founder decision: the pilot card is the Readiness row, with no calendar date block. */}
      {pilotEvents ? null : (
        <div className="shrink-0 w-14 rounded-2xl bg-pulse-50 border border-pulse-100 flex flex-col items-center justify-center py-2 text-pulse">
          <span className="text-[11px] font-bold uppercase tracking-wide">{formatInZone(event.startsAt, time, { month: "short" })}</span>
          <span className="font-display text-2xl font-extrabold leading-none">{formatInZone(event.startsAt, time, { day: "numeric" })}</span>
          <span className="text-[10px] font-semibold mt-1 text-pulse-ink">{formatInZone(event.startsAt, time, { weekday: "short" })}</span>
        </div>
      )}
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-center gap-2 text-xs font-semibold flex-wrap">
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: `${c.color}1a`, color: readableInk(c.color) }}>
            <CategoryIcon slug={c.slug} size={13} /> {c.label}
          </span>
          {cancelled ? (
            <span className="rounded-full bg-danger-100 text-danger px-2 py-0.5">Cancelled</span>
          ) : isPast ? (
            <span className="text-muted">Ended</span>
          ) : (
            <span className={cn("text-ink-2", day === "Today" && "text-flare-ink")}>{day}</span>
          )}
          {!cancelled && full ? <span className="rounded-full bg-danger-100 text-danger px-2 py-0.5">Full</span> : null}
        </div>
        <h3 className={cn("font-bold leading-snug group-hover:text-pulse transition-colors", compact ? "text-[15px] line-clamp-1" : "text-lg line-clamp-2")}>
          {event.title}
        </h3>
        <p className="text-sm text-ink-2">
          {formatEventDate(event.startsAt, time)} · {formatTimeRange(event.startsAt, event.endsAt, time)}
        </p>
        {activity ? <p className="text-xs text-ink-2 line-clamp-1">{activity}</p> : null}
        <div className="flex items-center gap-3 text-xs text-muted mt-auto pt-1">
          <span className="inline-flex items-center gap-1 min-w-0">
            <MapPin size={12} className="shrink-0" />
            <span className="truncate">{event.locationName}</span>
          </span>
          {pilotEvents ? (
            attendees && attendees.length ? <span className="shrink-0 ml-auto"><AvatarStack people={attendees} size={22} max={3} /></span> : null
          ) : (
            <span className="inline-flex items-center gap-1 shrink-0 ml-auto">
              {attendees && attendees.length ? <AvatarStack people={attendees} size={22} max={3} /> : <Users size={12} />}
              <span className="font-semibold text-ink">
                {event.attendeeCount}
                {event.capacity ? `/${event.capacity}` : ""}
              </span>
            </span>
          )}
        </div>
        {pilotEvents ? (
          <p className="text-xs font-semibold text-ink" data-testid="readiness-row">
            {readinessText(event.readiness ?? { going: event.attendeeCount }, { now: time.now, cancelled, ended: isPast, viewerTimeZone: time.timeZone })}
          </p>
        ) : null}
      </div>
    </Link>
  );
}
