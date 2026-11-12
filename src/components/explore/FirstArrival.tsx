"use client";

import { X } from "lucide-react";
import { getInterest } from "@/lib/data/taxonomy";
import { Surface } from "@/components/ui/Surface";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import { orList, type ArrivalNotice } from "./arrivalNotice";

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
  const emptyLabels = notice.emptyInterests.map((slug) => getInterest(slug).label);
  return (
    <Surface variant="raised" as="section" aria-label="Your first map" data-first-arrival="" className="p-3 flex flex-col">
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
        <ul className="list-none p-0 m-0 mt-2 flex gap-2 overflow-x-auto scrollbar-none" aria-label="Interests on the map">
          <li className="shrink-0">
            <button type="button" onClick={onShowEverything} className="chip" data-active="true">
              Show everything
            </button>
          </li>
          {interests.map((slug) => {
            const interest = getInterest(slug);
            return (
              <li key={slug} className="shrink-0">
                <button type="button" onClick={() => onRemove(slug)} className="chip" data-interest={slug} aria-label={`Remove ${interest.label}`}>
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
          <button type="button" onClick={onWiden} className="chip" data-widening="wider-area">
            Search a wider area
          </button>
        </div>
      ) : null}
    </Surface>
  );
}
