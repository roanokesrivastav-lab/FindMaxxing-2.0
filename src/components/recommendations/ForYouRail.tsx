import { Sparkles } from "lucide-react";
import type { Event, ForYou, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import { readableInk } from "@/lib/utils/contrast";
import { LocalDate } from "@/components/time/LocalDate";
import { RecommendationCard } from "./RecommendationCard";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";

const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/**
 * A horizontal "For you" rail. Every card says why it is there, because a
 * recommendation without a reason is just an ad, and every card can be
 * dismissed as Not interested. Cards seen are logged with their position,
 * the rendering's request id, the policy that produced them and their score.
 */
export function ForYouRail({ places, events, title = "For you" }: { places?: ForYou<Place>; events?: ForYou<Event>; title?: string }) {
  const cards = [
    ...(places?.items ?? []).map((r) => ({ kind: "place" as const, id: r.item.id, href: `/places/${r.item.id}`, title: r.item.name, category: r.item.categorySlug, meta: r.item.neighborhood ?? r.item.city, why: r.reason.text, score: r.score, from: places! })),
    ...(events?.items ?? []).map((r) => ({ kind: "event" as const, id: r.item.id, href: `/events/${r.item.id}`, title: r.item.title, category: r.item.categorySlug, meta: <LocalDate value={r.item.startsAt} format={WHEN} zone />, why: r.reason.text, score: r.score, from: events! })),
  ];
  if (!cards.length) return null;
  return (
    <section aria-labelledby="for-you-heading" className="mb-4">
      <h2 id="for-you-heading" className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted mb-2">
        <Sparkles size={14} aria-hidden /> {title}
      </h2>
      {/* Bleeds to the screen edge and sizes cards so the next one peeks: reads as a carousel, not a clipped card. */}
      <ul className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 scroll-px-4 list-none m-0 snap-x" aria-label={title}>
        {cards.map((c, i) => {
          const cat = getCategory(c.category);
          return (
            <RecommendationCard key={c.id} kind={c.kind} id={c.id} position={i} attribution={{ requestId: c.from.requestId, policy: c.from.policy, score: c.score }} href={c.href} title={c.title}>
              <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: readableInk(cat.color) }}><CategoryIcon slug={cat.slug} size={13} /> {cat.label}</span>
              <span className="font-bold leading-snug line-clamp-2">{c.title}</span>
              <span className="text-xs text-muted truncate">{c.meta}</span>
              <span className="mt-auto text-xs text-ink-2 line-clamp-2">{c.why}</span>
            </RecommendationCard>
          );
        })}
      </ul>
    </section>
  );
}
