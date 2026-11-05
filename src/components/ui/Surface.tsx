import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Role-based surfaces (roadmap 1.1). Each variant has one fixed meaning, and
 * elevation comes from the role, never decoration:
 * - raised: floats over the map, or marks the selected item (the only shadow)
 * - flat:   a comparable item in a list (no box, a hairline between rows)
 * - inset:  tinted, for a local tip or a note (no border, no shadow)
 * Styles live in globals.css (.surface-*). Use this instead of the legacy .card.
 */
export type SurfaceVariant = "raised" | "flat" | "inset";

export function Surface({
  variant,
  as: Tag = "div",
  className,
  children,
  ...rest
}: { variant: SurfaceVariant; as?: ElementType; className?: string; children?: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag data-surface={variant} className={cn(`surface-${variant}`, className)} {...rest}>
      {children}
    </Tag>
  );
}
