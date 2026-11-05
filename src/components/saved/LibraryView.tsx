import Link from "next/link";
import { Download, SearchX } from "lucide-react";
import { getCategory } from "@/lib/data/taxonomy";
import { SAVE_STATUSES, SAVE_STATUS_LABEL } from "@/lib/places/saves";
import { LIBRARY_PAGE, filterLibrary, hasFilters, type LibraryFilters, type LibraryItem } from "@/lib/places/library";
import { Input, Select } from "@/components/ui/Field";
import { buttonClass } from "@/components/ui/Button";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { LibraryClient } from "./LibraryClient";
import { PickFromSaves } from "./PickFromSaves";

/**
 * The library (3.2): search, filter by tag / status / category, paginated rows with
 * bulk edit and undo, and export. Filters are a plain GET form, so they work with no
 * script and survive reloads; 50 rows render per page with "Show more".
 */
export function LibraryView({
  items,
  filters,
  page,
  tags,
  lists,
  pickSlot,
}: {
  items: LibraryItem[];
  filters: LibraryFilters;
  page: number;
  tags: string[];
  lists: { id: string; name: string }[];
  pickSlot?: React.ReactNode;
}) {
  const matching = filterLibrary(items, filters);
  const shown = matching.slice(0, page * LIBRARY_PAGE);
  const categories = [...new Set(items.map((i) => i.place.categorySlug))].map((slug) => getCategory(slug)).sort((a, b) => a.label.localeCompare(b.label));
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.tag) p.set("tag", filters.tag);
    if (filters.status) p.set("status", filters.status);
    if (filters.category) p.set("category", filters.category);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <section aria-labelledby="library" data-block="library">
      <SectionHeader
        title="All saved"
        id="library"
        action={
          <span className="flex flex-wrap gap-item">
            <a href="/saved/export?format=csv" className="inline-flex items-center gap-hair font-semibold underline-offset-4 hover:underline" download>
              <Download size={14} aria-hidden /> CSV
            </a>
            <a href="/saved/export?format=json" className="inline-flex items-center gap-hair font-semibold underline-offset-4 hover:underline" download>
              <Download size={14} aria-hidden /> JSON
            </a>
          </span>
        }
      />
      <form method="get" action="/saved" className="flex flex-col gap-item" role="search" aria-label="Search and filter your saves">
        <label htmlFor="library-q" className="sr-only">Search your saves</label>
        <Input id="library-q" type="search" name="q" defaultValue={filters.q} placeholder="Search names, notes, tags" />
        <div className="grid grid-cols-1 gap-item sm:grid-cols-3">
          <div>
            <label htmlFor="library-tag" className="type-body text-ink-2">Tag</label>
            <Select id="library-tag" name="tag" defaultValue={filters.tag ?? ""}>
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="library-status" className="type-body text-ink-2">Status</label>
            <Select id="library-status" name="status" defaultValue={filters.status ?? ""}>
              <option value="">Any status</option>
              {SAVE_STATUSES.map((s) => (
                <option key={s} value={s}>{SAVE_STATUS_LABEL[s]}</option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="library-category" className="type-body text-ink-2">Category</label>
            <Select id="library-category" name="category" defaultValue={filters.category ?? ""}>
              <option value="">Any category</option>
              {categories.map((c) => (
                <option key={c.slug} value={c.slug}>{c.label}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-item">
          <button type="submit" className={buttonClass("ink", "sm")}>Apply</button>
          {hasFilters(filters) ? (
            <Link href="/saved" className={buttonClass("ghost", "sm")}>Clear filters</Link>
          ) : null}
          <span className="type-body text-ink-2" aria-live="polite">
            {hasFilters(filters) ? `${matching.length} of ${items.length} match` : `${items.length} saved`}
          </span>
        </div>
      </form>

      {pickSlot ?? <PickFromSaves filters={{ q: filters.q, tag: filters.tag, status: filters.status, category: filters.category }} filtered={hasFilters(filters)} />}

      {matching.length ? (
        <div className="mt-row">
          <LibraryClient items={shown} lists={lists} />
          {shown.length < matching.length ? (
            <div className="mt-row">
              <Link href={qs({ page: String(page + 1) })} scroll={false} className={buttonClass("secondary", "md")}>
                Show more ({matching.length - shown.length} left)
              </Link>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-row flex flex-col items-start gap-item" data-library-empty="">
          <p className="type-body text-ink inline-flex items-center gap-item">
            <SearchX size={18} aria-hidden /> No saves match these filters.
          </p>
          <Link href="/saved" className={buttonClass("secondary", "sm")}>Clear filters</Link>
        </div>
      )}
    </section>
  );
}
