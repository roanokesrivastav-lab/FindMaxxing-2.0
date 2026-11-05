"use client";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Clock, Footprints, Loader2, Shapes } from "lucide-react";
import { CATEGORIES, getCategory } from "@/lib/data/taxonomy";
import { AREA_MINUTES, WHEN_LABEL, WHEN_TABS, type WhenTab } from "@/lib/explore/intent";
import { Sheet } from "@/components/ui/Sheet";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";
import { cn } from "@/lib/utils/cn";

/**
 * The map tab's filter tabs (roadmap 2.4a): When, a travel limit, and Activity. They change what the
 * map shows and never open a list. `activityTabs` is the slot for data-backed activity tabs (2.4b:
 * "Has room", "Beginner-friendly"); none ship yet.
 */
export function IntentTabs({
  when,
  onWhen,
  area,
  onArea,
  locating,
  locationDenied,
  category,
  onCategory,
  activityTabs = null,
  trailing = null,
}: {
  when: WhenTab;
  onWhen: (w: WhenTab) => void;
  area: boolean;
  onArea: () => void;
  locating: boolean;
  locationDenied: boolean;
  category: string | null;
  onCategory: (slug: string | null) => void;
  activityTabs?: ReactNode;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState<"when" | "activity" | null>(null);
  const activity = category ? getCategory(category) : null;
  return (
    <>
      <div className="flex gap-item overflow-x-auto scrollbar-none px-4 -mx-4" role="group" aria-label="Filter the map" data-intent-tabs="">
        <button type="button" className="chip shrink-0" data-active={when !== "any"} aria-haspopup="dialog" onClick={() => setOpen("when")}>
          <Clock size={14} aria-hidden /> {when === "any" ? "When" : WHEN_LABEL[when]} <ChevronDown size={14} aria-hidden />
        </button>
        <button type="button" className="chip shrink-0" data-active={area} aria-pressed={area} onClick={onArea}>
          {locating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Footprints size={14} aria-hidden />} {AREA_MINUTES} min away
        </button>
        <button type="button" className="chip shrink-0" data-active={!!activity} aria-haspopup="dialog" onClick={() => setOpen("activity")}>
          {activity ? <CategoryIcon slug={activity.slug} /> : <Shapes size={14} aria-hidden />} {activity ? activity.label : "Activity"} <ChevronDown size={14} aria-hidden />
        </button>
        {activityTabs}
        {trailing}
        <span className="shrink-0 w-2" aria-hidden />
      </div>
      {when !== "any" ? <p className="type-body text-ink-2 surface-raised rounded-2xl px-edge py-hair w-fit max-w-full">When shows events only: places don&apos;t list opening hours yet.</p> : null}
      {locationDenied ? (
        <p className="type-body text-ink-2 surface-raised rounded-2xl px-edge py-hair w-fit max-w-full" role="status">
          {AREA_MINUTES} min away needs your location, which is off.
        </p>
      ) : null}

      {/* Portalled: the tabs sit in the map's top bar, whose stacking context would put the sheet
          under the bottom navigation. */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <>
      <Sheet open={open === "when"} onClose={() => setOpen(null)} title="When">
        <div className="flex flex-col gap-item" role="radiogroup" aria-label="When">
          {WHEN_TABS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={when === w}
              className={cn("chip justify-start")}
              data-active={when === w}
              onClick={() => {
                onWhen(w);
                setOpen(null);
              }}
            >
              {WHEN_LABEL[w]}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={open === "activity"} onClose={() => setOpen(null)} title="Activity">
        <div className="flex flex-wrap gap-item" role="radiogroup" aria-label="Activity">
          <button type="button" role="radio" aria-checked={!category} className="chip" data-active={!category} onClick={() => { onCategory(null); setOpen(null); }}>
            Any activity
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c.slug}
              type="button"
              role="radio"
              aria-checked={category === c.slug}
              className="chip"
              data-active={category === c.slug}
              onClick={() => {
                onCategory(c.slug);
                setOpen(null);
              }}
            >
              <CategoryIcon slug={c.slug} /> {c.label}
            </button>
          ))}
        </div>
      </Sheet>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
