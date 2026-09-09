"use client";
import { cn } from "@/lib/utils/cn";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/**
 * Bottom sheet on mobile, centered dialog on larger screens.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end md:items-center md:justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <button className="absolute inset-0 bg-ink/40 animate-fade" onClick={onClose} aria-label="Close" />
      <div
        className={cn(
          "relative w-full md:max-w-md bg-surface rounded-t-3xl md:rounded-3xl shadow-float animate-rise safe-bottom max-h-[88dvh] flex flex-col",
          className,
        )}
      >
        <div className="md:hidden mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-2" aria-hidden />
        <div className="flex items-center justify-between px-5 pt-3 pb-1">
          {title ? <h2 className="text-lg font-bold">{title}</h2> : <span />}
          <button onClick={onClose} className="h-9 w-9 -mr-2 inline-flex items-center justify-center rounded-full hover:bg-surface-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
