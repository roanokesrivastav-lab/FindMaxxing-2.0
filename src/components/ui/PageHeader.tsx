import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, action, eyebrow }: { title: string; subtitle?: string; action?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-5">
      <div>
        {eyebrow ? <p className="text-xs font-bold uppercase tracking-[0.12em] text-flare mb-1">{eyebrow}</p> : null}
        <h1 className="text-[28px] leading-tight font-bold">{title}</h1>
        {subtitle ? <p className="text-muted mt-1">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}
