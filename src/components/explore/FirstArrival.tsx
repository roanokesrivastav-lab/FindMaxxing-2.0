"use client";

import type { FocusEvent } from "react";
import { X } from "lucide-react";
import { getInterest } from "@/lib/data/taxonomy";
import { Surface } from "@/components/ui/Surface";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import { orList, type ArrivalNotice } from "./arrivalNotice";

// In a narrow strip a chip may be wider than the strip: let it take the full width and wrap its label.
const CHIP = "chip max-w-full @max-[17rem]:h-auto @max-[17rem]:min-h-9 @max-[17rem]:py-1.5 @max-[17rem]:whitespace-normal @max-[17rem]:text-left";
const ITEM = "shrink-0 @max-[17rem]:shrink @max-[17rem]:max-w-full";

/**
 * The first Explore visit after onboarding (roadmap 1.3). Shows the interests
 * the map is filtered to, each removable, with "Show everything" beside them.
 * When an interest has nothing in the area, or location is off, it says so and
 * offers one widening. It never changes a filter itself.
 */
export function FirstArrival({
  interests,
  notice,
  onRemove,
  onShowEverything,
  onWiden,
  onDismiss,
}: {
  interests: readonly string[];
  notice: ArrivalNotice;
  onRemove: (slug: string) => void;
  onShowEverything: () => void;
  onWiden: () => void;
  onDismiss: () => void;
}) {
  const filtered = interests.length > 0;
  // Chrome leaves a chip that is partly inside the sideways-scrolling row where it is when it
  // takes focus, so most of it can stay clipped. Bring the focused control fully into view.
  const reveal = (e: FocusEvent<HTMLElement>) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
  const emptyLabels = notice.emptyInterests.map((slug) => getInterest(slug).label);
  return (
    // A plain block that scrolls: on the map it may be given less height than it needs (large
    // text, short screens), and every control must still be reachable inside it. Not a flex
    // column, which would squash the chip row to nothing instead of scrolling.
    // It is also a size container: when it is narrow for its text (under 17rem, which is a phone
    // at about 130% text or more), the chips stack and wrap instead of scrolling sideways.
    <Surface variant="raised" as="section" aria-label="Your first map" data-first-arrival="" className="@container p-3 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
      <div className="flex items-start gap-3">
        <p className="type-body text-ink flex-1 min-w-0">
          <b>You&apos;re in.</b> {filtered ? "The map is showing your interests." : "The map is showing everything."} Tap the bookmark on a place you like to save it.
        </p>
        <button type="button" onClick={onDismiss} className="shrink-0 min-h-6 text-sm font-semibold text-moss">
          Got it
        </button>
      </div>

      {filtered ? (
        // Show everything comes first so it stays in view however many interests follow.
        <ul className="list-none p-0 m-0 mt-2 flex gap-2 overflow-x-auto scrollbar-none @max-[17rem]:flex-wrap @max-[17rem]:overflow-x-visible" aria-label="Interests on the map">
          <li className={ITEM}>
            <button type="button" onClick={onShowEverything} onFocus={reveal} className={CHIP} data-active="true">
              Show everything
            </button>
          </li>
          {interests.map((slug) => {
            const interest = getInterest(slug);
            return (
              <li key={slug} className={ITEM}>
                <button type="button" onClick={() => onRemove(slug)} onFocus={reveal} className={CHIP} data-interest={slug} aria-label={`Remove ${interest.label}`}>
                  <InterestIcon slug={slug} /> {interest.label} <X size={14} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* One live region, always present, so a change in what the map found is announced. */}
      <div role="status">
        {notice.emptyInterests.length ? (
          <p className="type-body text-ink-2 mt-2" data-notice="no-matches">
            {notice.stillEmptyAfterWidening
              ? notice.nothingMatches
                ? "Still nothing for your interests in the wider area. Your filters are unchanged: remove one, or show everything."
                : `Still nothing for ${orList(emptyLabels)} in the wider area. Your filters are unchanged.`
              : notice.nothingMatches
                ? "Nothing in this area matches your interests yet. Your filters are unchanged."
                : `Nothing for ${orList(emptyLabels)} in this area yet.`}
          </p>
        ) : null}
        {notice.locationDenied ? (
          <p className="type-body text-ink-2 mt-2" data-notice="location-off">
            Location is off, so the map starts in the default area, not where you are.
          </p>
        ) : null}
      </div>

      {notice.widening === "wider-area" ? (
        <div className="mt-2">
          <button type="button" onClick={onWiden} onFocus={reveal} className={CHIP} data-widening="wider-area">
            Search a wider area
          </button>
        </div>
      ) : null}
    </Surface>
  );
}
