import { getCategory } from "@/lib/data/taxonomy";
import { cn } from "@/lib/utils/cn";
import { PHOTO_LAYOUT_SIZES, photoSrc, photoSrcSet } from "@/lib/images/sizes";

/**
 * Visual for a place: the first photo if one exists, otherwise a generated
 * category-colored cover so listings never look empty.
 *
 * `layout` sets `sizes`, which decides the file a phone downloads; `priority`
 * is for the one above-the-fold hero, everything else loads lazily.
 */
export function PlaceCover({
  photoUrl,
  categorySlug,
  name,
  className,
  emojiSize = 40,
  layout,
  priority = false,
}: {
  photoUrl?: string | null;
  categorySlug: string;
  name: string;
  className?: string;
  emojiSize?: number;
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
  const seed = name.length % 4;
  return (
    <div className={cn("relative w-full h-full overflow-hidden", className)} style={{ background: c.color }} aria-hidden>
      <svg className="absolute inset-0 w-full h-full opacity-[0.22]" viewBox="0 0 200 120" preserveAspectRatio="none">
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M-10 ${20 + i * 22 + seed * 3} C 40 ${i * 18 + seed * 6}, 90 ${60 + i * 14}, 130 ${25 + i * 20} S 190 ${70 + i * 10}, 220 ${30 + i * 18}`}
            fill="none"
            stroke="white"
            strokeWidth="1.4"
          />
        ))}
      </svg>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.25),transparent_55%)]" />
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 drop-shadow-sm select-none" style={{ fontSize: emojiSize }}>
        {c.emoji}
      </span>
    </div>
  );
}
