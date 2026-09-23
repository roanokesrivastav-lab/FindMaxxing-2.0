"use client";
import { useDeferredValue, useMemo, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import type { Place } from "@/lib/data/types";
import { PlaceCard } from "./PlaceCard";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { searchTerms } from "@/lib/data/taxonomy";
import { distanceMeters } from "@/lib/utils/geo";
import { useGeolocation } from "@/lib/map/useGeolocation";

type Sort = "recent" | "rating" | "nearest" | "name";

const SORTS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Recently saved" },
  { value: "rating", label: "Top rated" },
  { value: "nearest", label: "Nearest" },
  { value: "name", label: "A–Z" },
];

/**
 * The saved list, with search and sort. Places arrive from the server already
 * ordered by save recency, which is the default here.
 */
export function SavedClient({ places }: { places: Place[] }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [sort, setSort] = useState<Sort>("recent");
  // Only asks for location when the viewer actually picks "Nearest".
  const geo = useGeolocation(false);

  const q = deferred.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return places;
    return places.filter((p) =>
      [p.name, p.description, p.localTip, p.neighborhood, p.city, ...searchTerms(p.categorySlug, p.tags)].some(
        (field) => field && field.toLowerCase().includes(q),
      ),
    );
  }, [places, q]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sort) {
      case "rating":
        return list.sort((a, b) => b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount);
      case "name":
        return list.sort((a, b) => a.name.localeCompare(b.name));
      case "nearest":
        if (!geo.location) return list;
        return list.sort((a, b) => distanceMeters(geo.location!, a) - distanceMeters(geo.location!, b));
      default:
        return list; // Server order is save-recency.
    }
  }, [filtered, sort, geo.location]);

  const chooseSort = (next: Sort) => {
    setSort(next);
    if (next === "nearest" && !geo.location) geo.request();
  };

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 h-12 rounded-full bg-surface border border-line shadow-card px-4">
        <Search size={18} className="text-muted shrink-0" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your saved places"
          className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-muted min-w-0"
          aria-label="Search saved places"
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="text-muted">
            <X size={16} />
          </button>
        ) : null}
      </label>

      <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4">
        {SORTS.map((s) => (
          <Chip key={s.value} active={sort === s.value} onClick={() => chooseSort(s.value)}>
            {s.label}
          </Chip>
        ))}
        <span className="shrink-0 w-2" aria-hidden />
      </div>

      {sort === "nearest" && !geo.location ? (
        <p className="text-xs text-muted -mt-1">
          {geo.status === "denied"
            ? "Location permission is off, so the order is unchanged."
            : geo.status === "unsupported"
              ? "This browser cannot provide a location, so the order is unchanged."
              : "Finding your location to sort by distance…"}
        </p>
      ) : null}

      {sorted.length ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {sorted.map((p) => (
            <PlaceCard
              key={p.id}
              place={p}
              distanceMeters={geo.location ? distanceMeters(geo.location, p) : null}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          emoji="🔍"
          title={`No saved places match “${query}”`}
          body="Try a shorter search, or clear it to see everything you've saved."
          action={
            <button type="button" onClick={() => setQuery("")} className="chip" data-active="true">
              Clear search
            </button>
          }
        />
      )}

      <p className="text-xs text-muted text-center">
        Looking for something you haven&apos;t saved?{" "}
        <Link href="/" className="font-semibold text-ink underline underline-offset-4">
          Explore the map
        </Link>
      </p>
    </div>
  );
}
