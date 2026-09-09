"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, List, LocateFixed, Map as MapIcon, Search, SlidersHorizontal, X } from "lucide-react";
import type { Event, Place } from "@/lib/data/types";
import type { MapCanvasHandle } from "@/components/map/MapCanvas";
import { MapView } from "@/components/map/MapView";
import { CATEGORIES, INTERESTS, getInterest, searchTerms } from "@/lib/data/taxonomy";
import { eventMarker, placeMarker } from "@/lib/map/markers";
import type { MapMarker, ViewState } from "@/lib/map/types";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/config";
import { useGeolocation } from "@/lib/map/useGeolocation";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { PreviewCard } from "./PreviewCard";
import { distanceMeters } from "@/lib/utils/geo";
import { cn } from "@/lib/utils/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Logo } from "@/components/layout/Logo";
import { Avatar } from "@/components/ui/Avatar";
import { Sheet } from "@/components/ui/Sheet";
import { usePersistentJson } from "@/lib/utils/usePersistentJson";

const FOLD_STORAGE_KEY = "findmaxxing:explore-folds";
const DEFAULT_FOLDS = { events: true, places: true };

type Kind = "all" | "places" | "events";
type Selected = { kind: "place"; item: Place } | { kind: "event"; item: Event } | null;

export interface ExploreViewer {
  displayName: string;
  avatarUrl: string | null;
  interests: string[];
}

export function ExploreClient({ places, events, viewer }: { places: Place[]; events: Event[]; viewer: ExploreViewer | null }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [kind, setKind] = useState<Kind>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [interests, setInterests] = useState<string[]>([]);
  const [mode, setMode] = useState<"map" | "list">("map");
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Folding the events section hands the whole panel to places. Remembered so
  // the choice survives navigating to a detail page and back.
  const [folds, setFolds] = usePersistentJson(FOLD_STORAGE_KEY, DEFAULT_FOLDS);
  const eventsOpen = folds.events;
  const placesOpen = folds.places;
  const setFold = useCallback(
    (section: "events" | "places", open: boolean) => setFolds({ ...folds, [section]: open }),
    [folds, setFolds],
  );
  const [selected, setSelected] = useState<Selected>(null);
  const [view, setView] = useState<ViewState>({ latitude: DEFAULT_CENTER.lat, longitude: DEFAULT_CENTER.lng, zoom: DEFAULT_ZOOM });
  const mapRef = useRef<MapCanvasHandle>(null);
  const geo = useGeolocation(true);
  const flewToUser = useRef(false);

  useEffect(() => {
    if (geo.location && !flewToUser.current) {
      flewToUser.current = true;
      // Only recenter if the user is reasonably near the data; otherwise keep the data in view.
      const far = distanceMeters(geo.location, DEFAULT_CENTER) > 80_000;
      if (!far) mapRef.current?.flyTo(geo.location, 13);
    }
  }, [geo.location]);

  const origin = useMemo(
    () => geo.location ?? { lat: view.latitude, lng: view.longitude },
    [geo.location, view.latitude, view.longitude],
  );

  const q = deferredQuery.trim().toLowerCase();
  const matchText = useCallback(
    (text: (string | null | undefined)[]) => !q || text.some((t) => t && t.toLowerCase().includes(q)),
    [q],
  );

  const filteredPlaces = useMemo(
    () =>
      kind === "events"
        ? []
        : places.filter(
            (p) =>
              (!category || p.categorySlug === category) &&
              (interests.length === 0 || interests.some((i) => p.tags.includes(i))) &&
              matchText([p.name, p.description, p.localTip, p.neighborhood, ...searchTerms(p.categorySlug, p.tags)]),
          ),
    [places, kind, category, interests, matchText],
  );

  const filteredEvents = useMemo(
    () =>
      kind === "places"
        ? []
        : events.filter(
            (e) =>
              (!category || e.categorySlug === category) &&
              (interests.length === 0 || interests.some((i) => e.tags.includes(i))) &&
              matchText([e.title, e.description, e.locationName, ...searchTerms(e.categorySlug, e.tags)]),
          ),
    [events, kind, category, interests, matchText],
  );

  const markers = useMemo<MapMarker[]>(
    () => [...filteredPlaces.map(placeMarker), ...filteredEvents.map(eventMarker)],
    [filteredPlaces, filteredEvents],
  );

  const sortedPlaces = useMemo(
    () => [...filteredPlaces].sort((a, b) => distanceMeters(origin, a) - distanceMeters(origin, b)),
    [filteredPlaces, origin],
  );

  const activeFilterCount = (category ? 1 : 0) + interests.length + (kind !== "all" ? 1 : 0);
  const totalResults = filteredPlaces.length + filteredEvents.length;

  const onMarkerClick = (m: MapMarker) => {
    if (m.kind === "place") {
      const item = places.find((p) => p.id === m.id);
      if (item) setSelected({ kind: "place", item });
    } else {
      const item = events.find((e) => e.id === m.id);
      if (item) setSelected({ kind: "event", item });
    }
    mapRef.current?.flyTo({ lat: m.lat, lng: m.lng }, Math.max(view.zoom, 14));
  };

  const clearFilters = () => {
    setCategory(null);
    setInterests([]);
    setKind("all");
  };

  const toggleInterest = (slug: string) => setInterests((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug]));

  const suggestedInterests = viewer?.interests.length ? viewer.interests.slice(0, 5) : ["pickup-sports", "cheap-eats", "studying", "hiking", "new-in-town"];

  return (
    <div className="relative h-dvh flex flex-col">
      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 z-30 pointer-events-none">
        <div className="pointer-events-auto px-4 pt-3 md:pt-4 max-w-3xl mx-auto flex flex-col gap-2.5">
          <div className="flex items-center gap-2 md:hidden">
            <Logo size={26} />
            <div className="flex-1" />
            {viewer ? (
              <Link href="/profile">
                <Avatar name={viewer.displayName} src={viewer.avatarUrl} size={34} />
              </Link>
            ) : (
              <Link href="/auth/sign-in" className="h-9 px-3.5 rounded-full bg-ink text-white text-sm font-semibold inline-flex items-center">
                Sign in
              </Link>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex-1 flex items-center gap-2 h-12 rounded-full bg-surface border border-line shadow-card px-4">
              <Search size={18} className="text-muted shrink-0" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Pickup soccer, study spot, cheap tacos…"
                className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-muted min-w-0"
                aria-label="Search places and events"
              />
              {query ? (
                <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="text-muted">
                  <X size={16} />
                </button>
              ) : null}
            </label>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={cn(
                "h-12 w-12 rounded-full border shadow-card inline-flex items-center justify-center relative shrink-0",
                activeFilterCount ? "bg-ink text-white border-ink" : "bg-surface border-line",
              )}
              aria-label="Filters"
            >
              <SlidersHorizontal size={18} />
              {activeFilterCount ? (
                <span className="absolute -top-1 -right-1 h-5 min-w-5 px-1 rounded-full bg-flare text-white text-[11px] font-bold inline-flex items-center justify-center">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>
          <ChipRow>
            <Chip active={kind === "events"} onClick={() => setKind(kind === "events" ? "all" : "events")} color="#6b4cff">
              📅 Events
            </Chip>
            {CATEGORIES.filter((c) => c.slug !== "other" && c.slug !== "watch-party").map((c) => (
              <Chip key={c.slug} active={category === c.slug} onClick={() => setCategory(category === c.slug ? null : c.slug)} color={c.color}>
                <span aria-hidden>{c.emoji}</span> {c.label}
              </Chip>
            ))}
          </ChipRow>
        </div>
      </div>

      {/* Map */}
      <div className={cn("flex-1 relative", mode === "list" && "hidden md:block")}>
        <MapView
          ref={mapRef}
          viewState={view}
          onViewStateChange={setView}
          markers={markers}
          activeMarkerId={selected?.item.id ?? null}
          onMarkerClick={onMarkerClick}
          onMapClick={() => setSelected(null)}
          userLocation={geo.location}
          padding={{ top: 160, bottom: 220 }}
        />

        {/* Floating controls */}
        <div className="absolute right-4 z-20 flex flex-col gap-2" style={{ bottom: "calc(var(--nav-height) + var(--safe-bottom) + 12.5rem)" }}>
          <button
            type="button"
            onClick={geo.request}
            className="md:hidden h-11 w-11 rounded-full bg-surface border border-line shadow-card inline-flex items-center justify-center"
            aria-label="Use my location"
          >
            <LocateFixed size={18} className={geo.status === "requesting" ? "animate-pulse" : geo.location ? "text-[#3b6fd6]" : ""} />
          </button>
        </div>

        {/* Selected pin preview */}
        {selected ? (
          <div className="absolute inset-x-0 z-30 px-4 md:left-[420px] md:right-4" style={{ bottom: "calc(var(--nav-height) + var(--safe-bottom) + 5.25rem)" }}>
            <div className="max-w-md mx-auto md:mx-0">
              <PreviewCard selected={selected} onClose={() => setSelected(null)} distanceMeters={geo.location ? distanceMeters(geo.location, selected.item) : null} />
            </div>
          </div>
        ) : null}

        {/* Map-mode bottom summary (mobile) */}
        <div className="md:hidden absolute inset-x-0 z-20 px-4" style={{ bottom: "calc(var(--nav-height) + var(--safe-bottom) + 0.75rem)" }}>
          <div className="mx-auto max-w-md">
            <ResultsSummary total={totalResults} places={filteredPlaces.length} events={filteredEvents.length} onList={() => setMode("list")} activeFilters={activeFilterCount} onClear={clearFilters} />
          </div>
        </div>
      </div>

      {/* List panel: full-screen on mobile (list mode), side drawer on desktop */}
      <div
        className={cn(
          "md:absolute md:left-4 md:top-[8.5rem] md:bottom-4 md:w-[380px] md:z-20 md:flex md:flex-col",
          mode === "list" ? "flex flex-col flex-1 overflow-hidden pt-[9.75rem]" : "hidden",
        )}
      >
        <div className="md:card md:overflow-hidden flex-1 flex flex-col min-h-0 bg-paper md:bg-surface">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <div>
              <p className="font-bold">{totalResults ? `${totalResults} nearby` : "Nothing matches"}</p>
              <p className="text-xs text-muted">
                {filteredPlaces.length} places · {filteredEvents.length} events
              </p>
            </div>
            <div className="flex gap-2">
              {activeFilterCount ? (
                <button type="button" onClick={clearFilters} className="text-sm font-semibold text-flare-600">
                  Clear
                </button>
              ) : null}
              <button type="button" onClick={() => setMode("map")} className="md:hidden chip" aria-label="Show map">
                <MapIcon size={15} /> Map
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 pb-nav md:pb-4">
            {totalResults === 0 ? (
              <EmptyState
                emoji="🧭"
                title="Nothing here yet"
                body={q ? `No matches for “${query}”. Try fewer words or another filter.` : "Try a different category, or be the first to add something."}
                action={
                  <Link href="/places/new" className="chip" data-active="true">
                    + Add a place
                  </Link>
                }
              />
            ) : null}
            {filteredEvents.length ? (
              <section className="flex flex-col gap-2">
                <FoldHeader
                  label="Events"
                  count={filteredEvents.length}
                  open={eventsOpen}
                  onToggle={() => setFold("events", !eventsOpen)}
                />
                {eventsOpen ? (
                  <>
                    {filteredEvents.slice(0, kind === "events" ? 100 : 4).map((e) => (
                      <EventCard key={e.id} event={e} compact onHover={() => setSelected({ kind: "event", item: e })} />
                    ))}
                    {kind === "all" && filteredEvents.length > 4 ? (
                      <Link href="/events" className="text-sm font-semibold text-pulse text-center py-1">
                        See all {filteredEvents.length} events →
                      </Link>
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
            {sortedPlaces.length ? (
              <section className="flex flex-col gap-2">
                <FoldHeader
                  label="Places"
                  count={sortedPlaces.length}
                  open={placesOpen}
                  onToggle={() => setFold("places", !placesOpen)}
                />
                {placesOpen
                  ? sortedPlaces.map((p) => (
                      <PlaceCard key={p.id} place={p} compact distanceMeters={geo.location ? distanceMeters(geo.location, p) : null} onHover={() => setSelected({ kind: "place", item: p })} />
                    ))
                  : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>

      {/* Filters sheet */}
      <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-sm font-semibold mb-2">Show</p>
            <div className="flex gap-2">
              {(["all", "places", "events"] as Kind[]).map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "Everything" : k === "places" ? "📍 Places" : "📅 Events"}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold mb-2">Category</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <Chip key={c.slug} active={category === c.slug} onClick={() => setCategory(category === c.slug ? null : c.slug)} color={c.color}>
                  <span aria-hidden>{c.emoji}</span> {c.label}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold mb-0.5">Interests</p>
            <p className="text-xs text-muted mb-2">{viewer?.interests.length ? "Starting with yours" : "Sign in to personalize"}</p>
            <div className="flex flex-wrap gap-2">
              {[...suggestedInterests, ...INTERESTS.map((i) => i.slug).filter((s) => !suggestedInterests.includes(s))].map((slug) => {
                const i = getInterest(slug);
                return (
                  <Chip key={slug} active={interests.includes(slug)} onClick={() => toggleInterest(slug)}>
                    <span aria-hidden>{i.emoji}</span> {i.label}
                  </Chip>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={clearFilters} className="chip flex-1 justify-center">
              Reset
            </button>
            <button type="button" onClick={() => setFiltersOpen(false)} className="chip flex-1 justify-center" data-active="true">
              Show {totalResults} result{totalResults === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function FoldHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex items-center gap-1.5 -mx-1 px-1 py-1 rounded-lg text-xs font-bold uppercase tracking-wider text-muted hover:text-ink transition-colors"
    >
      <ChevronDown size={14} className={cn("transition-transform duration-200", open ? "" : "-rotate-90")} />
      {label}
      <span className="text-line-2">·</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function ResultsSummary({
  total,
  places,
  events,
  onList,
  activeFilters,
  onClear,
}: {
  total: number;
  places: number;
  events: number;
  onList: () => void;
  activeFilters: number;
  onClear: () => void;
}) {
  return (
    <div className="card flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm">{total ? `${total} nearby` : "Nothing matches"}</p>
        <p className="text-xs text-muted truncate">
          {places} places · {events} events
          {activeFilters ? (
            <>
              {" · "}
              <button type="button" onClick={onClear} className="text-flare-600 font-semibold">
                clear filters
              </button>
            </>
          ) : null}
        </p>
      </div>
      <button type="button" onClick={onList} className="chip" data-active="true">
        <List size={15} /> List
      </button>
    </div>
  );
}
