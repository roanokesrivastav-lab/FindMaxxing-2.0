"use client";
import { cn } from "@/lib/utils/cn";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet on mobile, centered dialog on larger screens. A modal dialog
 * for keyboard and screen-reader users too: focus moves into it when it opens
 * (the first field, else the first control), Tab and Shift+Tab stay inside,
 * Escape closes it, and focus goes back to whatever opened it.
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
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Kept current without re-running the open effect when the parent re-renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
    // Prefer the first field over the close button, so a form is ready to type into.
    const first = panel?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])") ?? focusables().find((el) => el.dataset.sheetClose === undefined) ?? panel;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === firstItem || !panel.contains(document.activeElement))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (document.activeElement === lastItem || !panel.contains(document.activeElement))) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // Back to the opener, if it is still on the page.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end md:items-center md:justify-center">
      <button className="absolute inset-0 bg-ink/40 animate-fade" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : "Dialog"}
        tabIndex={-1}
        className={cn(
          "relative w-full md:max-w-md bg-surface rounded-t-3xl md:rounded-3xl shadow-float animate-rise safe-bottom max-h-[88dvh] flex flex-col outline-none",
          className,
        )}
      >
        <div className="md:hidden mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-2" aria-hidden />
        <div className="flex items-center justify-between px-5 pt-3 pb-1">
          {title ? <h2 id={titleId} className="text-lg font-bold">{title}</h2> : <span />}
          <button onClick={onClose} data-sheet-close className="h-9 w-9 -mr-2 inline-flex items-center justify-center rounded-full hover:bg-surface-2" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
