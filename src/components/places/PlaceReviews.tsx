import Link from "next/link";
import type { PlaceRating } from "@/lib/data/types";
import { Avatar } from "@/components/ui/Avatar";
import { StarRating } from "@/components/ui/Stars";
import { pluralize } from "@/lib/utils/format";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Notes people attached to their ratings. This is the reviews surface: the
 * rating itself is a number, the note is the local knowledge.
 */
export function PlaceReviews({ ratings }: { ratings: PlaceRating[] }) {
  if (!ratings.length) return null;
  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-lg font-bold">What people say</h2>
        <span className="text-xs text-muted">{pluralize(ratings.length, "note")}</span>
      </div>
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {ratings.map((r) => (
          <li key={r.id} className="card p-4">
            <div className="flex items-center gap-2.5">
              {r.user ? (
                <Link href={`/u/${r.user.username}`} className="flex items-center gap-2.5 min-w-0 hover:text-flare-600">
                  <Avatar name={r.user.displayName} src={r.user.avatarUrl} size={30} />
                  <span className="font-semibold text-sm truncate">{r.user.displayName}</span>
                </Link>
              ) : (
                <span className="text-sm text-muted">Someone</span>
              )}
              <StarRating value={r.score} size={12} className="ml-auto shrink-0" />
            </div>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{r.note}</p>
            <p className="mt-1.5 text-xs text-muted">{DATE.format(new Date(r.updatedAt))}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
