import { getCategory } from "@/lib/data/taxonomy";
import { cn } from "@/lib/utils/cn";
import { PHOTO_LAYOUT_SIZES, photoSrc, photoSrcSet } from "@/lib/images/sizes";
import { readableInk } from "@/lib/utils/contrast";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";

const TILE: Record<keyof typeof PHOTO_LAYOUT_SIZES, { box: number; icon: number }> = {
  thumb: { box: 40, icon: 20 },
  card: { box: 52, icon: 26 },
  gallery: { box: 52, icon: 26 },
  hero: { box: 72, icon: 34 },
};

/**
 * Visual for a place: the first photo if one exists, otherwise a generated
 * quiet category-tinted cover so listings never look empty.
 *
 * `layout` sets `sizes`, which decides the file a phone downloads; `priority`
 * is for the one above-the-fold hero, everything else loads lazily.
 */
export function PlaceCover({
  photoUrl,
  categorySlug,
  name,
  className,
  layout,
  priority = false,
}: {
  photoUrl?: string | null;
  categorySlug: string;
  name: string;
  className?: string;
  layout: keyof typeof PHOTO_LAYOUT_SIZES;
  priority?: boolean;
}) {
  const c = getCategory(categorySlug);
  if (photoUrl) {
    return (
      // Not next/image: photos come from the authorized route, which already
      // serves pipeline-sized files; srcSet picks among them.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoSrc(photoUrl, "md")}
        srcSet={photoSrcSet(photoUrl)}
        sizes={PHOTO_LAYOUT_SIZES[layout]}
        alt={name}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        decoding="async"
        className={cn("object-cover w-full h-full bg-surface-2", className)}
      />
    );
  }
  // No photo: a quiet tint of the category color with a dot grid and the
  // category icon, so listings without photos read as intentional.
  const ink = readableInk(c.color);
  const tile = TILE[layout];
  return (
    <div
      className={cn("relative w-full h-full overflow-hidden flex items-center justify-center", className)}
      style={{
        backgroundColor: `color-mix(in srgb, ${c.color} 14%, var(--color-paper))`,
        backgroundImage: `radial-gradient(color-mix(in srgb, ${c.color} 28%, transparent) 1px, transparent 1.5px)`,
        backgroundSize: "14px 14px",
      }}
      aria-hidden
    >
      <span
        className="inline-flex items-center justify-center rounded-2xl bg-surface/90 shadow-card"
        style={{ width: tile.box, height: tile.box, color: ink }}
      >
        <CategoryIcon slug={categorySlug} size={tile.icon} strokeWidth={1.75} />
      </span>
    </div>
  );
}
