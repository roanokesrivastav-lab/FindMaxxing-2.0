import { createElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * `heading` keeps the outline in order: h2 under a page's h1 (the default), h3
 * inside an h2 section, h1 when the empty state is the whole page.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
  heading: Heading = "h2",
}: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
  heading?: "h1" | "h2" | "h3";
}) {
  return (
    <div className={cn("card px-6 py-10 text-center flex flex-col items-center gap-3", className)}>
      <div className="h-14 w-14 rounded-2xl bg-paper-2 inline-flex items-center justify-center text-ink-2" aria-hidden>
        {createElement(icon, { size: 24, strokeWidth: 1.75 })}
      </div>
      <Heading className="text-lg font-bold">{title}</Heading>
      {body ? <p className="text-sm text-muted max-w-xs">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}
