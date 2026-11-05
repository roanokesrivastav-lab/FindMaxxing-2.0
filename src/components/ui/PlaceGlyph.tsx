import { getCategory } from "@/lib/data/taxonomy";
import { readableInk } from "@/lib/utils/contrast";
import { cn } from "@/lib/utils/cn";
import { CategoryIcon } from "@/components/ui/TaxonomyIcon";

/**
 * The no-photo fallback (roadmap 1.1): a category tile, so a card without a photo
 * is still a complete composition. Decorative by default; pass `label` when the
 * glyph is the only thing naming the category.
 */
export function PlaceGlyph({ categorySlug, size = 56, label, className }: { categorySlug: string; size?: number; label?: string; className?: string }) {
  const c = getCategory(categorySlug);
  return (
    <span
      data-glyph={c.slug}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-xl", className)}
      style={{ width: size, height: size, background: `${c.color}1f`, color: readableInk(c.color) }}
    >
      <CategoryIcon slug={c.slug} size={Math.round(size * 0.45)} />
    </span>
  );
}
