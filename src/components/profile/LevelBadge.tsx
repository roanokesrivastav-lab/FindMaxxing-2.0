import Link from "next/link";
import { Sparkles, Sprout, Star } from "lucide-react";
import type { ReputationLevel } from "@/lib/data/types";

const LEVELS: Record<ReputationLevel, { label: string; icon: typeof Star; className: string }> = {
  new: { label: "New", icon: Sprout, className: "bg-surface-2 text-ink-2" },
  contributor: { label: "Contributor", icon: Star, className: "bg-sun-100 text-ink" },
  trusted: { label: "Trusted local", icon: Sparkles, className: "bg-moss-100 text-moss" },
};

/** A level, never a score. Links to how levels are earned. */
export function LevelBadge({ level }: { level: ReputationLevel }) {
  const { label, icon: Icon, className } = LEVELS[level];
  return (
    <Link href="/help/reputation" className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`} title="How levels work">
      <Icon size={13} aria-hidden /> {label}
    </Link>
  );
}
