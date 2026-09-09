"use client";
import { cn } from "@/lib/utils/cn";

/** Teardrop pin for places. */
export function PlacePin({ color, emoji, active, label }: { color: string; emoji: string; active?: boolean; label: string }) {
  return (
    <div className={cn("relative flex flex-col items-center transition-transform duration-150", active ? "scale-125 z-10" : "hover:scale-110")} aria-label={label}>
      <div
        className="h-9 w-9 rounded-full rounded-br-[4px] rotate-45 flex items-center justify-center border-[2.5px] border-white"
        style={{ background: color, boxShadow: "var(--shadow-pin)" }}
      >
        <span className="-rotate-45 text-[15px] leading-none select-none" aria-hidden>
          {emoji}
        </span>
      </div>
      <span className="h-1.5 w-3 rounded-full bg-ink/25 blur-[1px] -mt-0.5" aria-hidden />
    </div>
  );
}

/** Rounded-square pin with pulse ring for events. */
export function EventPin({ color, emoji, active, label }: { color: string; emoji: string; active?: boolean; label: string }) {
  return (
    <div className={cn("relative flex items-center justify-center transition-transform duration-150", active ? "scale-125 z-10" : "hover:scale-110")} aria-label={label}>
      <span className="absolute h-9 w-9 rounded-xl animate-pulse-ring" style={{ background: color, opacity: 0.35 }} aria-hidden />
      <div
        className="relative h-9 w-9 rounded-xl flex items-center justify-center border-[2.5px] border-white"
        style={{ background: color, boxShadow: "var(--shadow-pin)" }}
      >
        <span className="text-[15px] leading-none select-none" aria-hidden>
          {emoji}
        </span>
        <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-pulse border-2 border-white" aria-hidden />
      </div>
    </div>
  );
}

export function UserDot() {
  return (
    <div className="relative flex items-center justify-center" aria-label="Your location">
      <span className="absolute h-8 w-8 rounded-full bg-[#3b6fd6]/25 animate-pulse-ring" aria-hidden />
      <span className="relative h-4 w-4 rounded-full bg-[#3b6fd6] border-[3px] border-white shadow-pin" />
    </div>
  );
}

export function DraftPin() {
  return (
    <div className="flex flex-col items-center animate-pop">
      <div className="h-10 w-10 rounded-full rounded-br-[4px] rotate-45 flex items-center justify-center border-[3px] border-white bg-ink shadow-pin">
        <span className="-rotate-45 text-white text-lg leading-none" aria-hidden>
          +
        </span>
      </div>
      <span className="h-1.5 w-3 rounded-full bg-ink/25 blur-[1px] -mt-0.5" aria-hidden />
    </div>
  );
}
