import { getCategory } from "@/lib/data/taxonomy";
import { cn } from "@/lib/utils/cn";

/**
 * Visual for a place: the first photo if one exists, otherwise a generated
 * category-colored cover so listings never look empty.
 */
export function PlaceCover({
  photoUrl,
  categorySlug,
  name,
  className,
  emojiSize = 40,
}: {
  photoUrl?: string | null;
  categorySlug: string;
  name: string;
  className?: string;
  emojiSize?: number;
}) {
  const c = getCategory(categorySlug);
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photoUrl} alt={name} className={cn("object-cover w-full h-full bg-surface-2", className)} />;
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
