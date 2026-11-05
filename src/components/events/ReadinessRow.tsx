import type { EventReadiness } from "@findmaxxing/shared/events";
import { readinessParts } from "@/lib/events/readiness";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { cn } from "@/lib/utils/cn";

/**
 * Roadmap 4.3: the Readiness row, e.g. "8 going · 4 spots open · 2 more needed · host confirms by 4 p.m.".
 * Each number comes from its own field, and a field that is not set says nothing. States that change
 * what the event means (Full, Confirmed, Not happening, venue unconfirmed) use StatusLabel: text + shape.
 * No hooks, so server pages and client cards share it; the caller passes the zone and clock.
 */
export function ReadinessRow({ readiness, timeZone, now, cancelled = false, className }: { readiness: EventReadiness; timeZone: string; now: number; cancelled?: boolean; className?: string }) {
  const parts = readinessParts(readiness, timeZone, now, cancelled);
  return (
    <span data-readiness="" className={cn("type-body text-ink-2 flex flex-wrap items-center gap-x-item gap-y-hair", className)}>
      {parts.map((p, i) => (
        <span key={p.text} className="inline-flex items-center gap-x-item">
          {i > 0 ? <span aria-hidden className="text-muted">·</span> : null}
          {p.tone ? <StatusLabel tone={p.tone === "positive" ? "positive" : p.tone === "negative" ? "negative" : p.tone === "warning" ? "warning" : "neutral"}>{p.text}</StatusLabel> : <span>{p.text}</span>}
        </span>
      ))}
    </span>
  );
}
