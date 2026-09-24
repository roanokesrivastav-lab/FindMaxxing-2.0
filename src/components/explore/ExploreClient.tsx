"use client";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, List, Loader2, LocateFixed, Map as MapIcon, PanelLeftClose, PanelLeftOpen, RotateCw, Search, SlidersHorizontal, X } from "lucide-react";
import type { Event, GeoBounds, Place } from "@/lib/data/types";
import type { MapCanvasHandle } from "@/components/map/MapCanvas";
import { MapView } from "@/components/map/MapView";
import { CATEGORIES, INTERESTS, getInterest } from "@/lib/data/taxonomy";
import { eventMarker, placeMarker } from "@/lib/map/markers";
import type { MapMarker, ViewState } from "@/lib/map/types";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/config";
import { useGeolocation } from "@/lib/map/useGeolocation";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { PreviewCard } from "./PreviewCard";
import { boundsFromPoints, distanceMeters } from "@/lib/utils/geo";
import { sameBounds } from "@/lib/map/bounds";
import { useDiscovery } from "./useDiscovery";
import type { DiscoveryRequest, DiscoveryResults } from "./discoveryRequest";
import { cn } from "@/lib/utils/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Logo } from "@/components/layout/Logo";
import { Avatar } from "@/components/ui/Avatar";
import { Sheet } from "@/components/ui/Sheet";
import { usePersistentJson } from "@/lib/utils/usePersistentJson";

const FOLD_STORAGE_KEY = "findmaxxing:explore-folds";
const DEFAULT_FOLDS = { events: true, places: true, panel: true };

type Kind = DiscoveryRequest["kind"];
/** Events shown in the mixed list before handing off to /events. */
const EVENTS_PREVIEW = 4;
type Selected = { kind: "place"; item: Place } | { kind: "event"; item: Event } | null;

export interface ExploreViewer {
  displayName: string;
  avatarUrl: string | null;
  interests: string[];
}

export function ExploreClient({
  initial,
  initialRequest,
  viewer,
}: {
  initial: DiscoveryResults;
  initialRequest: DiscoveryRequest;
  viewer: ExploreViewer | null;
}) {
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
  // Collapsing the whole panel hands the entire map over on desktop. Mobile
  // already has the map/list toggle, so this control is desktop-only.
  const panelOpen = folds.panel;
  const setFold = useCallback(
    (section: "events" | "places" | "panel", open: boolean) => setFolds({ ...folds, [section]: open }),
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

  // The settled viewport. Browsing follows it; a text search covers everywhere
  // until the viewer asks to search this area.
  const [viewport, setViewport] = useState<GeoBounds | null>(null);
  const [searchArea, setSearchArea] = useState<GeoBounds | null>(null);
  const text = deferredQuery.trim();
  const searching = text.length > 0;
  const request = useMemo<DiscoveryRequest>(
    () => ({
      bounds: searching ? searchArea : (viewport ?? initialRequest.bounds),
      text,
      category,
      tags: interests,
      kind,
    }),
    [searching, searchArea, viewport, initialRequest.bounds, text, category, interests, kind],
  );
  const discovery = useDiscovery(request, initial, initialRequest);
  const { results } = discovery;
  const places = results.places.items;
  const events = results.events.items;

  const markers = useMemo<MapMarker[]>(() => {
    const list = [...(results.placeMarkers?.items ?? []).map(placeMarker), ...(results.eventMarkers?.items ?? []).map(eventMarker)];
    // Keep the selected pin on the map across refreshes, even once it falls
    // outside the new results.
    if (selected && !list.some((m) => m.id === selected.item.id)) {
      list.push(selected.kind === "place" ? placeMarker(selected.item) : eventMarker(selected.item));
    }
    return list;
  }, [results.placeMarkers, results.eventMarkers, selected]);

  // A fresh search everywhere: bring its matches into view.
  const fittedFor = useRef<unknown>(null);
  useEffect(() => {
    if (!searching || searchArea || discovery.stale || fittedFor.current === results.placeMarkers) return;
    fittedFor.current = results.placeMarkers;
    const points = [...(results.placeMarkers?.items ?? []), ...(results.eventMarkers?.items ?? [])];
    const box = boundsFromPoints(points, 0.005);
    if (box) mapRef.current?.fitBounds([[box.west, box.south], [box.east, box.north]], 80, 14);
  }, [searching, searchArea, discovery.stale, results.placeMarkers, results.eventMarkers]);

  const placeCount = results.placeMarkers?.items.length ?? 0;
  const eventCount = results.eventMarkers?.items.length ?? 0;
  const truncated = !!(results.placeMarkers?.truncated || results.eventMarkers?.truncated);
  const scope = searching && !searchArea ? "everywhere" : "nearby";
  const canSearchArea = searching && !!viewport && !sameBounds(searchArea, viewport);

  const activeFilterCount = (category ? 1 : 0) + interests.length + (kind !== "all" ? 1 : 0);
  const totalResults = placeCount + eventCount;

  // Pins are compact records; the preview needs the full one. Use it if a list
  // page already has it, otherwise fetch it. Only the latest click wins.
  const lastClick = useRef<string | null>(null);
  const onMarkerClick = async (m: MapMarker) => {
    lastClick.current = m.id;
    mapRef.current?.flyTo({ lat: m.lat, lng: m.lng }, Math.max(view.zoom, 14));
    const loaded = m.kind === "place" ? places.find((p) => p.id === m.id) : events.find((e) => e.id === m.id);
    if (loaded) {
      setSelected(m.kind === "place" ? { kind: "place", item: loaded as Place } : { kind: "event", item: loaded as Event });
      return;
    }
    try {
      const res = await fetch(`/api/discover/item?kind=${m.kind}&id=${m.id}`);
      if (!res.ok || lastClick.current !== m.id) return;
      const item = await res.json();
      setSelected(m.kind === "place" ? { kind: "place", item: item as Place } : { kind: "event", item: item as Event });
    } catch {
      // The pin stays highlighted-free; the viewer can tap again.
    }
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
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchArea(null);
                }}
                placeholder="Pickup soccer, study spot, cheap tacos…"
                className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-muted min-w-0"
                aria-label="Search places and events"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setSearchArea(null);
                  }}
                  aria-label="Clear search"
                  className="text-muted"
                >
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
            <Link href="/new" className="chip shrink-0 snap-start" title="What locals added in the last 7 days">
              ✨ New
            </Link>
            <Link href="/neighborhoods" className="chip shrink-0 snap-start md:hidden" title="Browse by neighborhood">
              🗺️ Areas
            </Link>
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
          onBoundsChange={setViewport}
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
            className="h-11 w-11 rounded-full bg-surface border border-line shadow-card inline-flex items-center justify-center"
            aria-label="Use my location"
            title={geo.status === "denied" ? "Location permission is off" : "Use my location"}
          >
            <LocateFixed size={18} className={geo.status === "requesting" ? "animate-pulse" : geo.location ? "text-[#3b6fd6]" : ""} />
          </button>
        </div>

        {/* Query status: loading, errors, dense areas, search scope */}
        <div
          className={cn(
            "absolute inset-x-0 top-[10.25rem] md:top-[9rem] z-20 flex justify-center px-4 pointer-events-none",
            // Center over the visible map, not behind the desktop list panel.
            panelOpen && "md:left-[400px]",
          )}
        >
          <div className="pointer-events-auto flex flex-wrap justify-center gap-2" aria-live="polite">
            {discovery.status === "loading" ? (
              <span className="chip bg-surface shadow-card">
                <Loader2 size={14} className="animate-spin" /> Updating
              </span>
            ) : null}
            {discovery.status === "error" ? (
              <button type="button" onClick={discovery.retry} className="chip bg-surface shadow-card text-flare-600">
                <RotateCw size={14} /> Couldn&apos;t load results. Retry
              </button>
            ) : null}
            {canSearchArea ? (
              <button type="button" onClick={() => setSearchArea(viewport)} className="chip shadow-card" data-active="true">
                <Search size={14} /> Search this area
              </button>
            ) : null}
            {searching && searchArea ? (
              <button type="button" onClick={() => setSearchArea(null)} className="chip bg-surface shadow-card">
                Search everywhere
              </button>
            ) : null}
            {truncated && discovery.status !== "loading" ? (
              <span className="chip bg-surface shadow-card">Showing the top {placeCount + eventCount} here. Zoom in for more</span>
            ) : null}
          </div>
        </div>

        {/* Selected pin preview */}
        {selected ? (
          <div className={cn("absolute inset-x-0 z-30 px-4 md:right-4", panelOpen ? "md:left-[420px]" : "md:left-4")} style={{ bottom: "calc(var(--nav-height) + var(--safe-bottom) + 5.25rem)" }}>
            <div className="max-w-md mx-auto md:mx-0">
              <PreviewCard selected={selected} onClose={() => setSelected(null)} distanceMeters={geo.location ? distanceMeters(geo.location, selected.item) : null} />
            </div>
          </div>
        ) : null}

        {/* Map-mode bottom summary (mobile) */}
        <div className="md:hidden absolute inset-x-0 z-20 px-4" style={{ bottom: "calc(var(--nav-height) + var(--safe-bottom) + 0.75rem)" }}>
          <div className="mx-auto max-w-md">
            <ResultsSummary total={totalResults} truncated={truncated} scope={scope} places={placeCount} events={eventCount} onList={() => setMode("list")} activeFilters={activeFilterCount} onClear={clearFilters} />
          </div>
        </div>
      </div>

      {/* List panel: full-screen on mobile (list mode), side drawer on desktop */}
      <div
        className={cn(
          "md:absolute md:left-4 md:top-[8.5rem] md:bottom-4 md:w-[380px] md:z-20 md:flex-col",
          panelOpen ? "md:flex" : "md:hidden",
          mode === "list" ? "flex flex-col flex-1 overflow-hidden pt-[9.75rem]" : "hidden",
        )}
      >
        <div className="md:card md:overflow-hidden flex-1 flex flex-col min-h-0 bg-paper md:bg-surface">
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <div>
              <p className="font-bold">{resultsLabel(totalResults, truncated, scope)}</p>
              <p className="text-xs text-muted">
                {countLabel(placeCount, truncated, "place")} · {countLabel(eventCount, truncated, "event")}
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
              <button
                type="button"
                onClick={() => setFold("panel", false)}
                className="hidden md:inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink transition-colors"
                aria-label="Hide the list and show the whole map"
                title="Hide list"
              >
                <PanelLeftClose size={17} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3 pb-nav md:pb-4">
            {totalResults === 0 && discovery.status === "loading" ? (
              <p className="text-sm text-muted text-center py-6">Searching…</p>
            ) : null}
            {totalResults === 0 && discovery.status !== "loading" ? (
              <EmptyState
                emoji="🧭"
                title="Nothing here yet"
                body={
                  searching
                    ? searchArea
                      ? `No matches for “${text}” in this area. Try searching everywhere.`
                      : `No matches for “${text}”. Try fewer words or another filter.`
                    : "Try moving the map, another category, or be the first to add something."
                }
                action={
                  <Link href="/places/new" className="chip" data-active="true">
                    + Add a place
                  </Link>
                }
              />
            ) : null}
            {events.length ? (
              <section className="flex flex-col gap-2">
                <FoldHeader
                  label="Events"
                  count={eventCount}
                  open={eventsOpen}
                  onToggle={() => setFold("events", !eventsOpen)}
                />
                {eventsOpen ? (
                  <>
                    {(kind === "events" ? events : events.slice(0, EVENTS_PREVIEW)).map((e) => (
                      <EventCard key={e.id} event={e} compact onHover={() => setSelected({ kind: "event", item: e })} />
                    ))}
                    {kind === "all" && eventCount > EVENTS_PREVIEW ? (
                      <Link href="/events" className="text-sm font-semibold text-pulse text-center py-1">
                        See all events →
                      </Link>
                    ) : null}
                    {kind === "events" && results.events.nextCursor ? (
                      <LoadMore loading={discovery.loadingMore === "events"} onClick={() => discovery.loadMore("events")} label="More events" />
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
            {places.length ? (
              <section className="flex flex-col gap-2">
                <FoldHeader
                  label="Places"
                  count={placeCount}
                  open={placesOpen}
                  onToggle={() => setFold("places", !placesOpen)}
                />
                {placesOpen ? (
                  <>
                    {places.map((p) => (
                      <PlaceCard key={p.id} place={p} compact distanceMeters={geo.location ? distanceMeters(geo.location, p) : null} onHover={() => setSelected({ kind: "place", item: p })} />
                    ))}
                    {results.places.nextCursor ? (
                      <LoadMore loading={discovery.loadingMore === "places"} onClick={() => discovery.loadMore("places")} label="More places" />
                    ) : null}
                  </>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </div>

      {/* Brings the collapsed panel back. Sits where its header was. */}
      {!panelOpen ? (
        <button
          type="button"
          onClick={() => setFold("panel", true)}
          className="hidden md:inline-flex absolute left-4 top-[8.5rem] z-20 items-center gap-2 rounded-full bg-surface border border-line shadow-card px-4 h-11 font-semibold text-sm hover:bg-surface-2 transition-colors animate-rise"
        >
          <PanelLeftOpen size={17} />
          {resultsLabel(totalResults, truncated, scope)}
        </button>
      ) : null}

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

function resultsLabel(total: number, truncated: boolean, scope: "nearby" | "everywhere") {
  if (!total) return "Nothing matches";
  return `${total}${truncated ? "+" : ""} ${scope === "everywhere" ? (total === 1 ? "match" : "matches") : "nearby"}`;
}

function countLabel(n: number, truncated: boolean, noun: string) {
  return `${n}${truncated && n ? "+" : ""} ${noun}${n === 1 ? "" : "s"}`;
}

function LoadMore({ loading, onClick, label }: { loading: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} disabled={loading} className="chip justify-center self-center">
      {loading ? <Loader2 size={14} className="animate-spin" /> : null} {loading ? "Loading" : label}
    </button>
  );
}

function ResultsSummary({
  total,
  truncated,
  scope,
  places,
  events,
  onList,
  activeFilters,
  onClear,
}: {
  total: number;
  truncated: boolean;
  scope: "nearby" | "everywhere";
  places: number;
  events: number;
  onList: () => void;
  activeFilters: number;
  onClear: () => void;
}) {
  return (
    <div className="card flex items-center gap-3 px-4 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="font-bold text-sm">{resultsLabel(total, truncated, scope)}</p>
        <p className="text-xs text-muted truncate">
          {countLabel(places, truncated, "place")} · {countLabel(events, truncated, "event")}
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
