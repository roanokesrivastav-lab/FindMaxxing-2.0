"use client";
import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import type { Event } from "@/lib/data/types";
import { useViewerTime } from "@/components/time/ViewerTime";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { eventHasEnded, formatInZone, formatTime, timeZoneLabel } from "@/lib/utils/format";
import { availability, priceText } from "@/lib/events/tab";
import { ReadinessRow } from "./ReadinessRow";
import { cn } from "@/lib/utils/cn";
import { useImpression, type Impression as ImpressionData } from "@/components/interactions/impressions";

/**
 * Roadmap 1.5: one event as a Quiet-utility flat row. Start time sits on the shared left edge, then
 * title, venue and availability. Price, Full and Cancelled are visible without expanding. Tapping the
 * row expands it in place (meeting point, the host's note, extra details) with a link to the event.
 * The panel stays in the DOM (hidden) so the event link is always present for crawlers and tests.
 */
export function EventRow({
  event,
  price,
  note,
  going,
  details,
  impression = null,
}: {
  event: Event;
  /** Price in cents when payments are on; null otherwise. */
  price?: number | null;
  /** A plain "why this is here" line, e.g. for usual events. */
  note?: string | null;
  /** The viewer is going. */
  going?: boolean;
  /** Extra expanded content from later tickets (activity details, newcomer notes). */
  details?: ReactNode;
  /** Record that the viewer saw this row (feed rows, recommendations on). */
  impression?: ImpressionData | null;
}) {
  const ref = useImpression<HTMLLIElement>(impression);
  const time = useViewerTime();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const avail = availability(event);
  const ended = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const priceLabel = priceText(price ?? null);
  const dayLabel = formatInZone(event.startsAt, time, { weekday: "short", month: "short", day: "numeric" });
  return (
    <li ref={ref} data-row="" data-event-row={event.id} className="surface-flat">
      <div className="flex items-start gap-hair">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn("min-w-0 flex-1 text-left flex flex-wrap items-start gap-x-row gap-y-hair py-row rounded-xl hover:bg-paper-2/60", (ended || avail.kind === "cancelled") && "text-ink-2")}
      >
        {/* The shared left edge: a fixed-width time column (wraps above the text at large sizes). */}
        <span className="type-body w-[5.5rem] shrink-0 font-semibold text-ink tabular-nums">
          {formatTime(event.startsAt, time)}
          <span className="block font-normal text-muted">{dayLabel}</span>
        </span>
        <span className="flex min-w-0 flex-1 basis-[10rem] flex-col gap-hair">
          <span className="type-item-title text-ink line-clamp-2 break-words">{event.title}</span>
          <span className="type-body text-ink-2 break-words">{event.locationName}</span>
          {event.readiness && avail.kind !== "cancelled" ? <ReadinessRow readiness={event.readiness} timeZone={event.timeZone ?? time.timeZone} now={time.now} /> : null}
          <span className="flex flex-wrap items-center gap-x-item gap-y-hair">
            {event.readiness && avail.kind !== "cancelled" ? null : avail.kind === "cancelled" ? (
              <StatusLabel tone="negative">Cancelled</StatusLabel>
            ) : avail.kind === "full" ? (
              <StatusLabel tone="warning">Full</StatusLabel>
            ) : (
              <span className="type-body text-ink-2">{avail.text}</span>
            )}
            {priceLabel ? <span className="type-body font-semibold text-ink">{priceLabel}</span> : null}
            {going ? <StatusLabel tone="positive">Going</StatusLabel> : null}
            {ended && avail.kind !== "cancelled" ? <StatusLabel tone="neutral">Ended</StatusLabel> : null}
          </span>
          {note ? <span className="type-body text-muted break-words">{note}</span> : null}
        </span>
        <ChevronDown size={18} aria-hidden className={cn("mt-hair shrink-0 text-muted transition-transform", open && "rotate-180")} />
        <span className="sr-only">{open ? "Hide details" : "Show details"}</span>
      </button>
      {/* Always-visible way to open the event itself (the row tap expands in place). */}
      <Link href={`/events/${event.id}`} aria-label={`Open event: ${event.title}`} className="mt-row shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 hover:bg-paper-2">
        <ArrowRight size={18} aria-hidden />
      </Link>
      </div>
      <div id={panelId} hidden={!open} className="pb-row pl-[calc(5.5rem+var(--spacing-row))] max-sm:pl-0">
        <div className="surface-inset rounded-xl p-row flex flex-col gap-item">
          <p className="type-body text-ink-2">
            <span className="font-semibold text-ink">Meeting point: </span>
            {event.locationName}
            {event.address ? `, ${event.address}` : ""}
          </p>
          <p className="type-body text-ink-2">
            <span className="font-semibold text-ink">When: </span>
            {formatInZone(event.startsAt, time, { weekday: "long", month: "long", day: "numeric" })}, {formatTime(event.startsAt, time)}
            {event.endsAt ? ` to ${formatTime(event.endsAt, time)}` : ""} {timeZoneLabel(event.startsAt, time)}
          </p>
          {details}
          {event.description ? (
            <p className="type-body text-ink-2 whitespace-pre-line line-clamp-4">
              <span className="font-semibold text-ink">From the host: </span>
              {event.description}
            </p>
          ) : null}
          <Link href={`/events/${event.id}`} className="type-body font-semibold text-pulse-ink underline underline-offset-4 self-start">
            Open event<span className="sr-only">: {event.title}</span>
          </Link>
        </div>
      </div>
    </li>
  );
}
