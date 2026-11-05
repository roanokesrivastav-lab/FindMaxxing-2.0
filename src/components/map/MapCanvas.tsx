"use client";
import { forwardRef, useImperativeHandle, useRef, useState, type ComponentType, type FocusEvent, type RefAttributes } from "react";
import type { MapProps, MapRef, MarkerProps, NavigationControlProps } from "react-map-gl/maplibre";
import type { MapMarker, ViewState, LngLat } from "@/lib/map/types";
import type { GeoBounds } from "@/lib/data/types";
import { normalizeViewportBounds } from "@/lib/map/bounds";
import { PlacePin, EventPin, UserDot, DraftPin } from "./Pin";

/**
 * Provider-agnostic map. react-map-gl exposes identical component APIs for
 * Mapbox GL and MapLibre GL, so the concrete library is injected via `lib`
 * and only one of them ends up in the bundle (see MapView).
 */
export interface MapLibComponents {
  Map: ComponentType<MapProps & RefAttributes<MapRef>>;
  Marker: ComponentType<MarkerProps>;
  NavigationControl: ComponentType<NavigationControlProps>;
}

export interface MapCanvasHandle {
  flyTo: (target: LngLat, zoom?: number) => void;
  fitBounds: (bounds: [[number, number], [number, number]], padding?: number, maxZoom?: number) => void;
}

export interface MapCanvasProps {
  lib: MapLibComponents;
  mapStyle: string;
  mapboxAccessToken?: string;
  viewState: ViewState;
  onViewStateChange: (v: ViewState) => void;
  onMoveEnd?: (v: ViewState) => void;
  /** The visible area, once the map loads and each time movement settles. */
  onBoundsChange?: (bounds: GeoBounds) => void;
  markers: MapMarker[];
  activeMarkerId?: string | null;
  onMarkerClick?: (marker: MapMarker) => void;
  onMapClick?: (lngLat: LngLat) => void;
  userLocation?: LngLat | null;
  draftLocation?: LngLat | null;
  onDraftDrag?: (lngLat: LngLat) => void;
  onLoad?: () => void;
  onError?: (message: string) => void;
  showControls?: boolean;
  interactive?: boolean;
  padding?: { top?: number; bottom?: number; left?: number; right?: number };
}

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  {
    lib,
    mapStyle,
    mapboxAccessToken,
    viewState,
    onViewStateChange,
    onMoveEnd,
    onBoundsChange,
    markers,
    activeMarkerId,
    onMarkerClick,
    onMapClick,
    userLocation,
    draftLocation,
    onDraftDrag,
    onLoad,
    onError,
    showControls = true,
    interactive = true,
    padding,
  },
  ref,
) {
  const { Map, Marker, NavigationControl } = lib;
  const mapRef = useRef<MapRef>(null);

  const reportBounds = (map: { getBounds: () => { getNorth(): number; getSouth(): number; getEast(): number; getWest(): number } }) => {
    if (!onBoundsChange) return;
    const b = map.getBounds();
    onBoundsChange(normalizeViewportBounds({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() }));
  };

  const paddingOptions = padding
    ? { top: padding.top ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0, right: padding.right ?? 0 }
    : undefined;

  // Map flights jump instead of animating for people who ask for less motion.
  const duration = () => (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 700);

  // A pin reached with Tab can sit under the floating search bar, the list
  // panel or the results card, or off the map; bring it into the clear part of
  // the map so the focused pin is visible (WCAG 2.4.11).
  // Moving the map refreshes the results, which could drop the focused pin and
  // throw focus back to the page; it stays on the map until focus leaves it.
  const [focused, setFocused] = useState<MapMarker | null>(null);
  const shown = focused && !markers.some((m) => m.kind === focused.kind && m.id === focused.id) ? [...markers, focused] : markers;
  const revealIfHidden = (e: FocusEvent<HTMLElement>, m: MapMarker) => {
    setFocused(m);
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (e.target as HTMLElement).contains(hit)) return;
    mapRef.current?.easeTo({ center: [m.lng, m.lat], duration: duration(), padding: paddingOptions });
  };

  useImperativeHandle(ref, () => ({
    flyTo(target, zoom) {
      mapRef.current?.flyTo({ center: [target.lng, target.lat], zoom: zoom ?? Math.max(viewState.zoom, 14), duration: duration(), padding: paddingOptions });
    },
    fitBounds(bounds, pad = 60, maxZoom = 15) {
      // maxZoom is caller-supplied so a precise street address can settle close
      // while a whole neighborhood stays wide.
      mapRef.current?.fitBounds(bounds, { padding: pad, duration: duration(), maxZoom });
    },
  }));

  return (
    <Map
      ref={mapRef}
      mapStyle={mapStyle}
      {...(mapboxAccessToken ? { mapboxAccessToken } : {})}
      {...viewState}
      onMove={(e) => onViewStateChange({ latitude: e.viewState.latitude, longitude: e.viewState.longitude, zoom: e.viewState.zoom })}
      onMoveEnd={(e) => {
        onMoveEnd?.({ latitude: e.viewState.latitude, longitude: e.viewState.longitude, zoom: e.viewState.zoom });
        reportBounds(e.target);
      }}
      onClick={(e) => onMapClick?.({ lng: e.lngLat.lng, lat: e.lngLat.lat })}
      onLoad={(e) => {
        onLoad?.();
        reportBounds(e.target);
      }}
      onError={(e) => onError?.(e?.error?.message ?? "Map failed to load")}
      style={{ width: "100%", height: "100%" }}
      attributionControl={{ compact: true }}
      dragRotate={false}
      touchPitch={false}
      pitchWithRotate={false}
      interactive={interactive}
      cursor={onMapClick ? "crosshair" : "grab"}
      maxZoom={18}
      minZoom={3}
    >
      {showControls ? (
        <>
          <NavigationControl position="bottom-right" showCompass={false} />
        </>
      ) : null}

      {userLocation ? (
        <Marker longitude={userLocation.lng} latitude={userLocation.lat} anchor="center">
          <UserDot />
        </Marker>
      ) : null}

      {shown.map((m) => (
        <Marker
          key={`${m.kind}-${m.id}`}
          longitude={m.lng}
          latitude={m.lat}
          anchor="bottom"
          style={{ zIndex: m.id === activeMarkerId ? 20 : m.kind === "event" ? 5 : 1 }}
          onClick={(e) => {
            e.originalEvent.stopPropagation();
            onMarkerClick?.(m);
          }}
        >
          <div
            className="contents"
            onFocus={(e) => revealIfHidden(e, m)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused((f) => (f === m ? null : f));
            }}
          >
            {m.kind === "place" ? (
              <PlacePin color={m.color} categorySlug={m.categorySlug} active={m.id === activeMarkerId} label={m.label} />
            ) : (
              <EventPin color={m.color} categorySlug={m.categorySlug} active={m.id === activeMarkerId} label={m.label} />
            )}
          </div>
        </Marker>
      ))}

      {draftLocation ? (
        <Marker
          longitude={draftLocation.lng}
          latitude={draftLocation.lat}
          anchor="bottom"
          draggable={!!onDraftDrag}
          onDragEnd={(e) => onDraftDrag?.({ lng: e.lngLat.lng, lat: e.lngLat.lat })}
          style={{ zIndex: 30 }}
        >
          <DraftPin />
        </Marker>
      ) : null}
    </Map>
  );
});
