"use client";
import { Loader2, X } from "lucide-react";
import { getInterest } from "@/lib/data/taxonomy";
import { arrivalWidening, type InterestPresence } from "@/lib/explore/arrival";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import type { PresenceState } from "./useInterestPresence";

/**
 * First map after onboarding (roadmap 1.3): the picked interests as removable filters with "Show
 * everything" beside them, and for any interest with nothing here, a plain statement plus one specific
 * widening. Nothing is relaxed until the viewer picks it.
 */
export function ArrivalBar({
  interests,
  presence,
  onRemove,
  onShowEverything,
  onBiggerArea,
}: {
  interests: string[];
  presence: PresenceState;
  onRemove: (slug: string) => void;
  onShowEverything: () => void;
  onBiggerArea: () => void;
}) {
  const bySlug = new Map<string, InterestPresence>(presence.interests.map((p) => [p.slug, p]));
  const empty = interests
    .map((slug) => bySlug.get(slug))
    .filter((p): p is InterestPresence => !!p && arrivalWidening(p) !== null);
  // Every picked interest is empty: one statement for all of them, not a wall of repeats.
  const allEmpty = empty.length === interests.length && interests.length > 1;
  return (
    <section className="surface-raised rounded-2xl px-edge py-item flex flex-col gap-item" aria-label="Your interests on the map" data-arrival="">
      <div className="flex flex-wrap items-center gap-item">
        <span className="type-body font-semibold text-ink">Showing your interests</span>
        {presence.status === "loading" ? <Loader2 size={14} className="animate-spin text-muted" aria-label="Checking this area" /> : null}
      </div>
      <ul className="list-none m-0 p-0 flex flex-wrap gap-item">
        {interests.map((slug) => {
          const i = getInterest(slug);
          return (
            <li key={slug}>
              <button type="button" className="chip" data-active="true" data-remove={slug} onClick={() => onRemove(slug)}>
                <InterestIcon slug={slug} /> <span className="sr-only">Remove </span>
                {i.label}
                <span className="sr-only"> filter</span> <X size={14} aria-hidden />
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="chip" onClick={onShowEverything}>
            Show everything
          </button>
        </li>
      </ul>
      <div aria-live="polite" className="flex flex-col gap-hair">
        {presence.status === "error" ? <p className="type-body text-muted">Couldn&apos;t check each interest in this area.</p> : null}
        {allEmpty ? (
          <Notice text="None of your interests has anything in this area yet." widening={empty.some((p) => arrivalWidening(p) === "bigger-area") ? "bigger-area" : "all-interests"} onBiggerArea={onBiggerArea} onShowEverything={onShowEverything} />
        ) : (
          empty.map((p) => (
            <Notice key={p.slug} slug={p.slug} text={`Nothing for ${getInterest(p.slug).label} in this area yet.`} widening={arrivalWidening(p)!} onBiggerArea={onBiggerArea} onShowEverything={onShowEverything} />
          ))
        )}
      </div>
    </section>
  );
}

function Notice({
  slug,
  text,
  widening,
  onBiggerArea,
  onShowEverything,
}: {
  slug?: string;
  text: string;
  widening: "bigger-area" | "all-interests";
  onBiggerArea: () => void;
  onShowEverything: () => void;
}) {
  return (
    <p className="type-body text-ink-2 flex flex-wrap items-center gap-x-item" data-empty-interest={slug ?? "all"} data-widening={widening}>
      <span>{text}</span>
      {widening === "bigger-area" ? (
        <button type="button" className="font-semibold text-flare-ink underline underline-offset-2" onClick={onBiggerArea}>
          Look in a bigger area
        </button>
      ) : (
        <button type="button" className="font-semibold text-flare-ink underline underline-offset-2" onClick={onShowEverything}>
          Show all interests
        </button>
      )}
    </p>
  );
}
