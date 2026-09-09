"use client";
import Link from "next/link";
import { ArrowRight, MapPin, Star, Users, X } from "lucide-react";
import type { Event, Place } from "@/lib/data/types";
import { getCategory } from "@/lib/data/taxonomy";
import { formatEventWhen, formatRating, relativeDayLabel } from "@/lib/utils/format";
import { formatDistance } from "@/lib/utils/geo";
import { PlaceCover } from "@/components/places/PlaceCover";
import { KindBadge } from "@/components/ui/Badge";

type Selected = { kind: "place"; item: Place } | { kind: "event"; item: Event };

export function PreviewCard({ selected, onClose, distanceMeters }: { selected: Selected; onClose: () => void; distanceMeters: number | null }) {
  const c = getCategory(selected.item.categorySlug);
  const href = selected.kind === "place" ? `/places/${selected.item.id}` : `/events/${selected.item.id}`;

  return (
    <div className="card overflow-hidden animate-rise shadow-float flex" role="dialog" aria-label={selected.kind === "place" ? selected.item.name : selected.item.title}>
      <Link href={href} className="w-24 shrink-0 relative">
        {selected.kind === "place" ? (
          <PlaceCover photoUrl={selected.item.photos[0]?.url} categorySlug={selected.item.categorySlug} name={selected.item.name} emojiSize={30} />
        ) : (
          <div className="h-full w-full bg-pulse-50 flex flex-col items-center justify-center text-pulse">
            <span className="text-2xl">{c.emoji}</span>
            <span className="text-[11px] font-bold mt-1">{relativeDayLabel(selected.item.startsAt)}</span>
          </div>
        )}
      </Link>
      <div className="flex-1 min-w-0 p-3 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <KindBadge kind={selected.kind} />
          <span className="text-xs font-semibold truncate" style={{ color: c.color }}>
            {c.label}
          </span>
          <button type="button" onClick={onClose} className="ml-auto -mr-1 h-7 w-7 inline-flex items-center justify-center rounded-full hover:bg-surface-2" aria-label="Close preview">
            <X size={15} />
          </button>
        </div>
        <Link href={href} className="font-bold leading-snug line-clamp-1 hover:text-flare-600">
          {selected.kind === "place" ? selected.item.name : selected.item.title}
        </Link>
        {selected.kind === "place" ? (
          <p className="text-xs text-ink-2 line-clamp-1">{selected.item.localTip ?? selected.item.description}</p>
        ) : (
          <p className="text-xs text-ink-2 line-clamp-1">{formatEventWhen(selected.item.startsAt, selected.item.endsAt)}</p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted mt-auto">
          {selected.kind === "place" ? (
            <span className="inline-flex items-center gap-1 font-semibold text-ink">
              <Star size={12} className="text-sun" fill="currentColor" strokeWidth={0} />
              {formatRating(selected.item.ratingAvg)} <span className="text-muted font-medium">({selected.item.ratingCount})</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold text-ink">
              <Users size={12} />
              {selected.item.attendeeCount}
              {selected.item.capacity ? `/${selected.item.capacity}` : ""} going
            </span>
          )}
          {distanceMeters != null ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} />
              {formatDistance(distanceMeters)}
            </span>
          ) : null}
          <Link href={href} className="ml-auto inline-flex items-center gap-1 font-semibold text-ink">
            Open <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}
