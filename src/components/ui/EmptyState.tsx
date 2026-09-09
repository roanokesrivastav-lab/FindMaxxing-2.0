import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function EmptyState({
  emoji,
  title,
  body,
  action,
  className,
}: {
  emoji: string;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("card px-6 py-10 text-center flex flex-col items-center gap-3", className)}>
      <div className="h-14 w-14 rounded-2xl bg-paper-2 inline-flex items-center justify-center text-3xl" aria-hidden>
        {emoji}
      </div>
      <h3 className="text-lg font-bold">{title}</h3>
      {body ? <p className="text-sm text-muted max-w-xs">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden />;
}
