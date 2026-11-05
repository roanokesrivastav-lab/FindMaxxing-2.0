"use client";

import { useImpression, type Impression as ImpressionData } from "./impressions";

export type { ImpressionData };

/** Wraps a result card so seeing it counts as an impression (when `impression` is given). */
export function Impression({ impression, children, className }: { impression: ImpressionData | null; children: React.ReactNode; className?: string }) {
  const ref = useImpression<HTMLDivElement>(impression);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
