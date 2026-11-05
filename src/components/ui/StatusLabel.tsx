import { Ban, CircleCheck, CircleDot, Clock3, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * A status as text plus a shape, never colour alone (roadmap 1.1). Each tone has
 * its own icon shape, so the status survives greyscale, colour blindness and
 * forced-colours modes. The visible text is the accessible name.
 */
export type StatusTone = "positive" | "pending" | "warning" | "negative" | "neutral";

const TONES: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  positive: { icon: CircleCheck, className: "text-moss" },
  pending: { icon: Clock3, className: "text-pulse-ink" },
  warning: { icon: TriangleAlert, className: "text-ink-2" },
  negative: { icon: Ban, className: "text-danger" },
  neutral: { icon: CircleDot, className: "text-muted" },
};

export function StatusLabel({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <span data-status={tone} className={cn("type-body inline-flex items-center gap-hair font-semibold", toneClass, className)}>
      <Icon size="1.1em" strokeWidth={2.25} aria-hidden className="shrink-0" />
      <span>{children}</span>
    </span>
  );
}
