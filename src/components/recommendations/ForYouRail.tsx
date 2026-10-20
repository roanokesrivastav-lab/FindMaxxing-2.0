import Link from "next/link";
import { Sparkles } from "lucide-react";
import type { Event, Place, Recommendation } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import { readableInk } from "@/lib/utils/contrast";
import { LocalDate } from "@/components/time/LocalDate";

const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/**
 * A horizontal "For you" rail. Every card says why it is there, because a
 * recommendation without a reason is just an ad.
 */
export function ForYouRail({ places = [], events = [], title = "For you" }: { places?: Recommendation<Place>[]; events?: Recommendation<Event>[]; title?: string }) {
  const cards = [
    ...places.map((r) => ({ id: r.item.id, href: `/places/${r.item.id}`, title: r.item.name, category: r.item.categorySlug, meta: r.item.neighborhood ?? r.item.city, why: r.reason.text })),
    ...events.map((r) => ({ id: r.item.id, href: `/events/${r.item.id}`, title: r.item.title, category: r.item.categorySlug, meta: <LocalDate value={r.item.startsAt} format={WHEN} zone />, why: r.reason.text })),
  ];
  if (!cards.length) return null;
  return (
    <section aria-labelledby="for-you-heading" className="mb-4">
      <h2 id="for-you-heading" className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted mb-2">
        <Sparkles size={14} aria-hidden /> {title}
      </h2>
      <ul className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 list-none m-0 snap-x" aria-label={title}>
        {cards.map((c) => {
          const cat = getCategory(c.category);
          return (
            <li key={c.id} className="snap-start shrink-0 w-56">
              <Link href={c.href} className="card p-3 h-full flex flex-col gap-1 hover:border-ink transition-colors">
                <span className="text-xs font-semibold" style={{ color: readableInk(cat.color) }}><span aria-hidden>{cat.emoji}</span> {cat.label}</span>
                <span className="font-bold leading-snug line-clamp-2">{c.title}</span>
                <span className="text-xs text-muted truncate">{c.meta}</span>
                <span className="mt-auto text-xs text-ink-2 line-clamp-2">{c.why}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
