"use client";
import Link from "next/link";
import { readableInk } from "@/lib/utils/contrast";
import { Users, MapPin, Ban, TriangleAlert } from "lucide-react";
import type { Event } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import { eventHasEnded, formatEventDate, formatInZone, formatTimeRange, relativeDayLabel } from "@/lib/utils/format";
import { useViewerTime } from "@/components/time/ViewerTime";
import { cn } from "@/lib/utils/cn";
import { AvatarStack } from "@/components/ui/Avatar";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";
import { ReadinessRow } from "./ReadinessRow";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { formatPrice } from "@/lib/data/payments";

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
  // 4.3 (pilotEvents): events carry Readiness numbers, and the card is the Readiness row. No date block.
  // 4.8: the host's Party poster (still pilotEvents-only: readiness is present only then).
  if (event.readiness && event.cardStyle === "party_poster") return <PartyPosterCard event={event} className={className} onHover={onHover} />;
  if (event.readiness) return <ReadinessCard event={event} compact={compact} className={className} onHover={onHover} />;
  const isPast = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const cancelled = event.status === "cancelled";
  const full = event.capacity !== null && event.attendeeCount >= event.capacity;
  const day = relativeDayLabel(event.startsAt, time);
  return (
    <Link
      href={`/events/${event.id}`}
      onMouseEnter={onHover}
      className={cn("card flex gap-3 hover:shadow-float transition-shadow group", compact ? "p-3" : "p-4", (isPast || cancelled) && "opacity-70", className)}
    >
      <div className="shrink-0 w-14 rounded-2xl bg-pulse-50 border border-pulse-100 flex flex-col items-center justify-center py-2 text-pulse">
        <span className="text-[11px] font-bold uppercase tracking-wide">{formatInZone(event.startsAt, time, { month: "short" })}</span>
        <span className="font-display text-2xl font-extrabold leading-none">{formatInZone(event.startsAt, time, { day: "numeric" })}</span>
        <span className="text-[10px] font-semibold mt-1 text-pulse-ink">{formatInZone(event.startsAt, time, { weekday: "short" })}</span>
      </div>
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
        <div className="flex items-center gap-3 text-xs text-muted mt-auto pt-1">
          <span className="inline-flex items-center gap-1 min-w-0">
            <MapPin size={12} className="shrink-0" />
            <span className="truncate">{event.locationName}</span>
          </span>
          <span className="inline-flex items-center gap-1 shrink-0 ml-auto">
            {attendees && attendees.length ? <AvatarStack people={attendees} size={22} max={3} /> : <Users size={12} />}
            <span className="font-semibold text-ink">
              {event.attendeeCount}
              {event.capacity ? `/${event.capacity}` : ""}
            </span>
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Roadmap 4.3: the default event card with pilotEvents on. Category, title, when and where as plain
 * text, then the Readiness row. Price, Full and Cancelled stay visible. No calendar date block (founder
 * decision); complete without a photo (PlaceGlyph).
 */
function ReadinessCard({ event, compact, className, onHover }: { event: Event; compact?: boolean; className?: string; onHover?: () => void }) {
  const time = useViewerTime();
  const c = getCategory(event.categorySlug);
  const isPast = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const cancelled = event.status === "cancelled";
  const zone = { timeZone: event.timeZone ?? time.timeZone };
  return (
    <Link href={`/events/${event.id}`} onMouseEnter={onHover} data-card="readiness" className={cn("surface-flat flex gap-row py-row rounded-xl hover:bg-paper-2/60", className)}>
      <PlaceGlyph categorySlug={event.categorySlug} size={compact ? 40 : 56} />
      <span className="min-w-0 flex-1 flex flex-col gap-hair">
        <span className="type-body flex flex-wrap items-center gap-x-item text-ink-2">
          <span className="font-semibold">{c.label}</span>
          {cancelled ? <StatusLabel tone="negative">Cancelled</StatusLabel> : isPast ? <StatusLabel tone="neutral">Ended</StatusLabel> : null}
          {event.priceCents ? <span className="font-semibold text-ink">{formatPrice(event.priceCents)}</span> : null}
        </span>
        <span className={cn("type-item-title text-ink break-words", compact ? "line-clamp-1" : "line-clamp-2")}>{event.title}</span>
        <span className="type-body text-ink-2 break-words">
          {formatEventDate(event.startsAt, zone)} · {formatTimeRange(event.startsAt, event.endsAt, zone)} · {event.locationName}
        </span>
        {event.readiness ? <ReadinessRow readiness={event.readiness} timeZone={zone.timeZone} now={time.now} cancelled={cancelled} /> : null}
      </span>
    </Link>
  );
}

/**
 * Roadmap 4.8: the Party poster, turned on by the host. A typographic poster on the ink surface: the
 * title set large in the display face, then when and where, then price, Full or Cancelled (always
 * visible), and the going count. Complete with no photo; long titles wrap (clamped at four lines).
 */
function PartyPosterCard({ event, className, onHover }: { event: Event; className?: string; onHover?: () => void }) {
  const time = useViewerTime();
  const c = getCategory(event.categorySlug);
  const zone = { timeZone: event.timeZone ?? time.timeZone };
  const cancelled = event.status === "cancelled";
  const isPast = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const r = event.readiness;
  const full = !!r && r.spotsOpen === 0;
  return (
    <Link href={`/events/${event.id}`} onMouseEnter={onHover} data-card="party-poster" className={cn("block rounded-2xl bg-ink text-paper p-row hover:bg-ink-2", (cancelled || isPast) && "opacity-80", className)}>
      <span className="type-body flex flex-wrap items-center gap-x-item gap-y-hair text-paper/80">
        <CategoryIcon slug={c.slug} size={16} /> <span className="font-semibold">{c.label}</span>
      </span>
      <span className="type-page-title mt-item block break-words line-clamp-4">{event.title}</span>
      <span className="type-item-title mt-item block">{formatEventDate(event.startsAt, zone)} · {formatTimeRange(event.startsAt, event.endsAt, zone)}</span>
      <span className="type-body mt-hair block break-words text-paper/80">{event.locationName}</span>
      <span className="type-body mt-item flex flex-wrap items-center gap-x-row gap-y-hair font-semibold">
        {cancelled ? <span data-status="negative" className="inline-flex items-center gap-hair"><Ban size="1.1em" aria-hidden /> Cancelled</span>
          : isPast ? <span>Ended</span>
          : full ? <span data-status="warning" className="inline-flex items-center gap-hair"><TriangleAlert size="1.1em" aria-hidden /> Full</span> : null}
        {event.priceCents ? <span>{formatPrice(event.priceCents)}</span> : <span>Free</span>}
        {r ? <span className="font-normal text-paper/80">{r.going} going</span> : null}
      </span>
    </Link>
  );
}
