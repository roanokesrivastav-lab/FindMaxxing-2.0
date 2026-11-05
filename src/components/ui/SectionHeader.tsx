import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * A section heading on the page's one left edge (roadmap 1.1). Space above it is
 * the section gap (24–32px); `action` sits on the trailing side and wraps under
 * the title when text is large.
 */
export function SectionHeader({
  title,
  action,
  as: Heading = "h2",
  id,
  className,
}: { title: ReactNode; action?: ReactNode; as?: "h2" | "h3"; id?: string; className?: string }) {
  return (
    <div className={cn("mt-section mb-item flex flex-wrap items-baseline justify-between gap-x-row gap-y-hair", className)}>
      <Heading id={id} className="type-item-title text-ink min-w-0">
        {title}
      </Heading>
      {action ? <div className="type-body text-ink-2">{action}</div> : null}
    </div>
  );
}
