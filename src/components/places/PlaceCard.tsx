import Link from "next/link";
import { Star, MapPin } from "lucide-react";
import type { Place } from "@/lib/data/types";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { formatRating } from "@/lib/utils/format";
import { formatDistance } from "@/lib/utils/geo";
import { cn } from "@/lib/utils/cn";
import { PlaceCover } from "./PlaceCover";

export function PlaceCard({
  place,
  distanceMeters,
  compact,
  className,
  onHover,
}: {
  place: Place;
  distanceMeters?: number | null;
  compact?: boolean;
  className?: string;
  onHover?: () => void;
}) {
  const c = getCategory(place.categorySlug);
  return (
    <Link
      href={`/places/${place.id}`}
      onMouseEnter={onHover}
      className={cn("card overflow-hidden flex hover:shadow-float transition-shadow group", compact ? "h-[104px]" : "flex-col", className)}
    >
      <div className={cn("relative shrink-0 overflow-hidden", compact ? "w-[104px]" : "aspect-[16/10]")}>
        <PlaceCover photoUrl={place.photos[0]?.url} categorySlug={place.categorySlug} name={place.name} emojiSize={compact ? 30 : 44} />
      </div>
      <div className={cn("min-w-0 flex-1 flex flex-col", compact ? "p-3 justify-center gap-1" : "p-4 gap-1.5")}>
        <div className="flex items-center gap-2 text-xs font-semibold" style={{ color: c.color }}>
          <span>{c.emoji}</span>
          <span className="truncate">{c.label}</span>
          {place.neighborhood ? (
            <>
              <span className="text-line-2">•</span>
              <span className="text-muted truncate">{place.neighborhood}</span>
            </>
          ) : null}
        </div>
        <h3 className={cn("font-bold leading-snug group-hover:text-flare-600 transition-colors", compact ? "text-[15px] line-clamp-1" : "text-lg line-clamp-2")}>
          {place.name}
        </h3>
        {!compact ? <p className="text-sm text-ink-2 line-clamp-2">{place.localTip ?? place.description}</p> : null}
        <div className="mt-auto flex items-center gap-3 text-xs text-muted pt-0.5">
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            <Star size={13} className="text-sun" fill="currentColor" strokeWidth={0} />
            {formatRating(place.ratingAvg)}
            <span className="text-muted font-medium">({place.ratingCount})</span>
          </span>
          {distanceMeters != null ? (
            <span className="inline-flex items-center gap-1">
              <MapPin size={12} />
              {formatDistance(distanceMeters)}
            </span>
          ) : null}
          {!compact && place.tags.length ? (
            <span className="ml-auto flex gap-1 overflow-hidden">
              {place.tags.slice(0, 2).map((t) => (
                <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 font-medium whitespace-nowrap">
                  {getInterest(t).label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
