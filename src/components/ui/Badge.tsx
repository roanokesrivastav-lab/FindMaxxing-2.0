import { cn } from "@/lib/utils/cn";
import { getCategory } from "@/lib/data/taxonomy";
import type { ReactNode } from "react";

export function Badge({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      style={style}
      className={cn("inline-flex items-center gap-1 rounded-full px-2.5 h-6 text-xs font-semibold bg-surface-2 text-ink-2", className)}
    >
      {children}
    </span>
  );
}

export function CategoryBadge({ slug, className, tone = "soft" }: { slug: string; className?: string; tone?: "soft" | "solid" }) {
  const c = getCategory(slug);
  return (
    <Badge
      className={className}
      style={
        tone === "solid"
          ? { background: c.color, color: "white" }
          : { background: `${c.color}1a`, color: c.color }
      }
    >
      <span aria-hidden>{c.emoji}</span>
      {c.label}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: "place" | "event" }) {
  return (
    <Badge className={kind === "event" ? "bg-pulse-100 text-pulse" : "bg-flare-100 text-flare-600"}>
      {kind === "event" ? "Event" : "Place"}
    </Badge>
  );
}
