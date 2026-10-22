"use client";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";

/**
 * Pins are buttons, so they are in the tab order, announce their name and
 * selected state, and show a focus ring. Activation reaches the map marker's
 * own click handler: Enter and Space on a button fire a click that bubbles to it.
 */
const PIN_BUTTON = "rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-white";

/** Category-colored teardrop with a white line icon; places and events share it. */
function PinHead({ color, categorySlug }: { color: string; categorySlug: string }) {
  return (
    <div
      className="h-9 w-9 rounded-full rounded-br-[4px] rotate-45 flex items-center justify-center border-[2.5px] border-white"
      style={{ background: color, boxShadow: "var(--shadow-pin)" }}
    >
      <CategoryIcon slug={categorySlug} size={16} strokeWidth={2.25} className="-rotate-45 text-white" />
    </div>
  );
}

/** Place pin: the teardrop in the category's color. */
export function PlacePin({ color, categorySlug, active, label }: { color: string; categorySlug: string; active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!!active}
      className={cn(PIN_BUTTON, "relative flex flex-col items-center transition-transform duration-150", active ? "scale-125 z-10" : "hover:scale-110 focus-visible:scale-110")}
    >
      <PinHead color={color} categorySlug={categorySlug} />
      <span className="h-1.5 w-3 rounded-full bg-ink/25 blur-[1px] -mt-0.5" aria-hidden />
    </button>
  );
}

/** Event pin: the same teardrop in the event color, with a pulse ring and dot. */
export function EventPin({ color, categorySlug, active, label }: { color: string; categorySlug: string; active?: boolean; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!!active}
      className={cn(PIN_BUTTON, "relative flex flex-col items-center transition-transform duration-150", active ? "scale-125 z-10" : "hover:scale-110 focus-visible:scale-110")}
    >
      <span className="absolute top-0 h-9 w-9 rounded-full animate-pulse-ring" style={{ background: color, opacity: 0.25 }} aria-hidden />
      <span className="relative">
        <PinHead color={color} categorySlug={categorySlug} />
        <span className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-pulse border-2 border-white" aria-hidden />
      </span>
      <span className="h-1.5 w-3 rounded-full bg-ink/25 blur-[1px] -mt-0.5" aria-hidden />
    </button>
  );
}

export function UserDot() {
  return (
    <div className="relative flex items-center justify-center" role="img" aria-label="Your location">
      <span className="absolute h-8 w-8 rounded-full bg-[#3b6fd6]/25 animate-pulse-ring" aria-hidden />
      <span className="relative h-4 w-4 rounded-full bg-[#3b6fd6] border-[3px] border-white shadow-pin" />
    </div>
  );
}

export function DraftPin() {
  return (
    <div className="flex flex-col items-center animate-pop">
      <div className="h-10 w-10 rounded-full rounded-br-[4px] rotate-45 flex items-center justify-center border-[3px] border-white bg-ink shadow-pin">
        <Plus size={18} strokeWidth={2.5} className="-rotate-45 text-white" aria-hidden />
      </div>
      <span className="h-1.5 w-3 rounded-full bg-ink/25 blur-[1px] -mt-0.5" aria-hidden />
    </div>
  );
}
