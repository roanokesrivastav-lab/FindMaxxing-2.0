import Link from "next/link";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function FormShell({
  title,
  subtitle,
  eyebrow,
  backHref,
  tone = "flare",
  children,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  backHref: string;
  tone?: "flare" | "pulse" | "ink";
  children: ReactNode;
}) {
  return (
    <div className="max-w-xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-8">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          {eyebrow ? (
            <p className={cn("text-xs font-bold uppercase tracking-[0.12em] mb-1", tone === "pulse" ? "text-pulse" : tone === "ink" ? "text-ink-2" : "text-flare")}>
              {eyebrow}
            </p>
          ) : null}
          <h1 className="text-[28px] leading-tight font-bold">{title}</h1>
          {subtitle ? <p className="text-muted mt-1">{subtitle}</p> : null}
        </div>
        <Link href={backHref} className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-full bg-surface border border-line" aria-label="Cancel">
          <X size={18} />
        </Link>
      </div>
      {children}
    </div>
  );
}
