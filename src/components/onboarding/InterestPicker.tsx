"use client";

import { Check, ChevronDown } from "lucide-react";
import { getInterest } from "@/lib/data/taxonomy";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { INTEREST_GLYPH, MAP_INTEREST_LIMIT, mapInterests, visibleInterests } from "@/lib/onboarding/interests";
import { cn } from "@/lib/utils/cn";

/**
 * The pilot Interests step body (roadmap 1.2): thumbnail rows with a visible check, "More interests",
 * and the limit the first map honours said up front. Pure presentation: the caller owns the state.
 */
export function InterestPicker({
  selected,
  expanded,
  onToggle,
  onExpandedChange,
}: {
  selected: string[];
  expanded: boolean;
  onToggle: (slug: string) => void;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const full = selected.length >= MAP_INTEREST_LIMIT;
  const rows = visibleInterests(selected, expanded);
  const used = mapInterests(selected);
  const over = selected.length > MAP_INTEREST_LIMIT;
  return (
    <div className="flex flex-col">
      <ul className="list-none m-0 p-0" aria-label="Interests" id="interest-rows">
        {rows.map((slug) => {
          const interest = getInterest(slug);
          const on = selected.includes(slug);
          const blocked = !on && full;
          return (
            <li key={slug} className="surface-flat">
              <button
                type="button"
                onClick={() => onToggle(slug)}
                aria-pressed={on}
                aria-disabled={blocked || undefined}
                data-interest={slug}
                className={cn(
                  "w-full flex flex-wrap items-center gap-x-row gap-y-item py-item text-left rounded-xl",
                  blocked ? "opacity-60 cursor-not-allowed" : "hover:bg-paper-2/60",
                )}
              >
                <PlaceGlyph categorySlug={INTEREST_GLYPH[slug] ?? "other"} size={40} />
                {/* No min-w-0: a word never breaks mid-word; at large text sizes the check wraps instead. */}
                <span className="type-item-title flex-1 basis-[5rem] break-words">{interest.label}</span>
                {/* Shape, not only colour: an empty ring, or a filled disc with a check. */}
                <span
                  aria-hidden
                  data-check={on ? "on" : "off"}
                  className={cn(
                    "h-7 w-7 shrink-0 rounded-full inline-flex items-center justify-center border-2",
                    on ? "bg-ink border-ink text-white" : "border-line-2 text-transparent",
                  )}
                >
                  <Check size={16} strokeWidth={3} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls="interest-rows"
        className="self-start mt-item inline-flex items-center gap-hair py-item type-body font-semibold text-ink"
      >
        <ChevronDown size={16} aria-hidden className={cn("transition-transform", expanded ? "rotate-180" : "")} />
        {expanded ? "Fewer interests" : "More interests"}
      </button>
      <p className="type-body text-muted mt-item" role="status">
        {over
          ? `Your map starts with these ${MAP_INTEREST_LIMIT}: ${used.map((s) => getInterest(s).label).join(", ")}. Unpick some to choose which.`
          : full
            ? `That's ${MAP_INTEREST_LIMIT}, the most the map can show at once. Unpick one to choose another.`
            : selected.length
              ? `${selected.length} picked. The map starts with all of them (up to ${MAP_INTEREST_LIMIT}).`
              : `Pick any, up to ${MAP_INTEREST_LIMIT}, or none. You can change them later.`}
      </p>
    </div>
  );
}
