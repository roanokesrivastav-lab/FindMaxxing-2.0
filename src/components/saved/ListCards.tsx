import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { SavedList } from "@/lib/data/types";
import { pluralize } from "@/lib/utils/format";

/** The viewer's lists on the Saved page, most recently changed first. */
export function ListCards({ lists }: { lists: SavedList[] }) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
      {lists.map((list) => (
        <li key={list.id}>
          <Link
            href={`/saved/${list.id}`}
            className="card p-4 flex items-center justify-between gap-3 h-full hover:bg-surface-2 hover:-translate-y-0.5 transition-all"
          >
            <span className="min-w-0">
              <span className="block font-bold leading-tight truncate">{list.name}</span>
              <span className="block text-xs text-muted mt-0.5">{list.placeCount ? pluralize(list.placeCount, "place") : "Empty"}</span>
            </span>
            <ChevronRight size={18} className="text-muted shrink-0" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
