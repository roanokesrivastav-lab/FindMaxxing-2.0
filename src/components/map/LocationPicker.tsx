"use client";
import { Crosshair, LocateFixed, MapPin, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MapView } from "./MapView";
import type { MapCanvasHandle } from "./MapCanvas";
import type { LngLat, ViewState } from "@/lib/map/types";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/config";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";
import { geocodeAddress, shortLabel, zoomForBbox, type GeocodeResult, MIN_GEOCODE_QUERY } from "@/lib/map/geocode";

const GEOCODE_DEBOUNCE_MS = 700;

/**
 * Tap-to-drop location picker. Emits lat/lng via hidden inputs so it works
 * inside a plain <form>. The pin is draggable for fine adjustment.
 *
 * When `addressQuery` is supplied, the typed address is looked up and the map
 * moves to it. A pin the user placed themselves is never moved automatically:
 * in that case the match is offered as a chip they can accept.
 */
export function LocationPicker({
  initial,
  error,
  label = "Where is it?",
  onChange,
  addressQuery,
}: {
  initial?: LngLat | null;
  error?: string;
  label?: string;
  onChange?: (v: LngLat) => void;
  /** Address text to look up, e.g. "1210 Oak St, Olde Towne East, Columbus". */
  addressQuery?: string;
}) {
  const [point, setPoint] = useState<LngLat | null>(initial ?? null);
  const [view, setView] = useState<ViewState>({
    latitude: initial?.lat ?? DEFAULT_CENTER.lat,
    longitude: initial?.lng ?? DEFAULT_CENTER.lng,
    zoom: initial ? 15 : DEFAULT_ZOOM,
  });
  const [geoStatus, setGeoStatus] = useState<"idle" | "requesting" | "denied">("idle");
  const [userLocation, setUserLocation] = useState<LngLat | null>(null);
  const mapRef = useRef<MapCanvasHandle>(null);

  // True once the pin represents a deliberate choice: either the user placed it,
  // or the caller supplied one (editing a place, or an event at a known place).
  // From then on the address lookup suggests rather than moves anything.
  const placedByUser = useRef(Boolean(initial));
  const [lookup, setLookup] = useState<"idle" | "searching" | "none">("idle");
  const [suggestion, setSuggestion] = useState<GeocodeResult | null>(null);
  const appliedQuery = useRef<string | null>(null);

  const set = useCallback(
    (p: LngLat) => {
      setPoint(p);
      onChange?.(p);
    },
    [onChange],
  );

  const setByUser = useCallback(
    (p: LngLat) => {
      placedByUser.current = true;
      setSuggestion(null);
      set(p);
    },
    [set],
  );

  const moveTo = useCallback(
    (result: GeocodeResult) => {
      set({ lat: result.lat, lng: result.lng });
      if (result.bbox) {
        const [west, south, east, north] = result.bbox;
        mapRef.current?.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          40,
          zoomForBbox(result.bbox),
        );
      } else {
        mapRef.current?.flyTo({ lat: result.lat, lng: result.lng }, 16);
      }
    },
    [set],
  );

  // Look the address up as it is typed, then either move the pin or offer to.
  // Everything runs after the debounce so no state is written synchronously
  // during the effect, and the "finding…" hint never flickers on a keystroke.
  useEffect(() => {
    const q = (addressQuery ?? "").trim();
    if (q === appliedQuery.current) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (q.length < MIN_GEOCODE_QUERY) {
        setLookup("idle");
        setSuggestion(null);
        return;
      }
      setLookup("searching");
      const results = await geocodeAddress(q, controller.signal);
      if (controller.signal.aborted) return;

      const best = results[0];
      if (!best) {
        setLookup("none");
        setSuggestion(null);
        return;
      }
      setLookup("idle");
      appliedQuery.current = q;
      if (placedByUser.current) {
        // Respect a hand-placed pin; offer the match instead of taking over.
        setSuggestion(best);
      } else {
        setSuggestion(null);
        moveTo(best);
      }
    }, GEOCODE_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [addressQuery, moveTo]);

  const useMyLocation = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoStatus("denied");
      return;
    }
    setGeoStatus("requesting");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(here);
        setByUser(here);
        mapRef.current?.flyTo(here, 15);
        setGeoStatus("idle");
      },
      () => setGeoStatus("denied"),
      { timeout: 8000, maximumAge: 60_000 },
    );
  };

  const hint = point ? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : "tap the map";

  return (
    <div data-field="lat">
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className={cn("relative h-64 rounded-2xl overflow-hidden border", error ? "border-danger" : "border-line")}>
        <MapView
          ref={mapRef}
          viewState={view}
          onViewStateChange={setView}
          markers={[]}
          draftLocation={point}
          onDraftDrag={setByUser}
          onMapClick={setByUser}
          userLocation={userLocation}
          showControls={false}
        />
        <div className="absolute top-2 left-2 right-2 flex items-start justify-between gap-2 pointer-events-none">
          <span className="rounded-full bg-surface/95 border border-line px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 shadow-card">
            {lookup === "searching" ? (
              <>
                <Search size={13} className="animate-pulse" />
                Finding that address…
              </>
            ) : (
              <>
                <Crosshair size={13} />
                {point ? "Drag the pin to adjust" : "Tap to drop a pin"}
              </>
            )}
          </span>
          <button
            type="button"
            onClick={useMyLocation}
            className="pointer-events-auto h-9 w-9 shrink-0 rounded-full bg-surface/95 border border-line inline-flex items-center justify-center shadow-card hover:bg-surface"
            aria-label="Use my location"
            title="Use my location"
          >
            <LocateFixed size={16} className={geoStatus === "requesting" ? "animate-pulse" : ""} />
          </button>
        </div>

      </div>

      {/* Sits below the map rather than over it: an overlay here would collide
          with the map's own attribution and zoom controls. */}
      {suggestion ? (
        <button
          type="button"
          onClick={() => {
            const target = suggestion;
            setSuggestion(null);
            moveTo(target);
          }}
          className="mt-2 w-full rounded-2xl bg-ink text-white px-3 py-2.5 flex items-center gap-2 text-left animate-rise"
        >
          <MapPin size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs opacity-80">Move pin to</span>
            <span className="block text-sm font-semibold truncate">{shortLabel(suggestion.label)}</span>
          </span>
        </button>
      ) : null}

      {point ? (
        <>
          <input type="hidden" name="lat" value={point.lat} />
          <input type="hidden" name="lng" value={point.lng} />
        </>
      ) : null}

      <FieldError>
        {error ??
          (geoStatus === "denied"
            ? "Location unavailable. Tap the map instead."
            : lookup === "none"
              ? "Couldn't find that address. Tap the map to place the pin yourself."
              : undefined)}
      </FieldError>
    </div>
  );
}
