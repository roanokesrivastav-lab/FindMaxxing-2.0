"use client";
import { forwardRef, useImperativeHandle, useRef, type ComponentType, type RefAttributes } from "react";
import type { MapProps, MapRef, MarkerProps, NavigationControlProps, GeolocateControlProps } from "react-map-gl/maplibre";
import type { MapMarker, ViewState, LngLat } from "@/lib/map/types";
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
  GeolocateControl: ComponentType<GeolocateControlProps>;
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
  const { Map, Marker, NavigationControl, GeolocateControl } = lib;
  const mapRef = useRef<MapRef>(null);

  const paddingOptions = padding
    ? { top: padding.top ?? 0, bottom: padding.bottom ?? 0, left: padding.left ?? 0, right: padding.right ?? 0 }
    : undefined;

  useImperativeHandle(ref, () => ({
    flyTo(target, zoom) {
      mapRef.current?.flyTo({ center: [target.lng, target.lat], zoom: zoom ?? Math.max(viewState.zoom, 14), duration: 700, padding: paddingOptions });
    },
    fitBounds(bounds, pad = 60, maxZoom = 15) {
      // maxZoom is caller-supplied so a precise street address can settle close
      // while a whole neighborhood stays wide.
      mapRef.current?.fitBounds(bounds, { padding: pad, duration: 700, maxZoom });
    },
  }));

  return (
    <Map
      ref={mapRef}
      mapStyle={mapStyle}
      {...(mapboxAccessToken ? { mapboxAccessToken } : {})}
      {...viewState}
      onMove={(e) => onViewStateChange({ latitude: e.viewState.latitude, longitude: e.viewState.longitude, zoom: e.viewState.zoom })}
      onMoveEnd={(e) => onMoveEnd?.({ latitude: e.viewState.latitude, longitude: e.viewState.longitude, zoom: e.viewState.zoom })}
      onClick={(e) => onMapClick?.({ lng: e.lngLat.lng, lat: e.lngLat.lat })}
      onLoad={() => onLoad?.()}
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
          <GeolocateControl position="bottom-right" trackUserLocation={false} showUserLocation={false} />
        </>
      ) : null}

      {userLocation ? (
        <Marker longitude={userLocation.lng} latitude={userLocation.lat} anchor="center">
          <UserDot />
        </Marker>
      ) : null}

      {markers.map((m) => (
        <Marker
          key={`${m.kind}-${m.id}`}
          longitude={m.lng}
          latitude={m.lat}
          anchor={m.kind === "place" ? "bottom" : "center"}
          style={{ zIndex: m.id === activeMarkerId ? 20 : m.kind === "event" ? 5 : 1 }}
          onClick={(e) => {
            e.originalEvent.stopPropagation();
            onMarkerClick?.(m);
          }}
        >
          {m.kind === "place" ? (
            <PlacePin color={m.color} emoji={m.emoji} active={m.id === activeMarkerId} label={m.label} />
          ) : (
            <EventPin color={m.color} emoji={m.emoji} active={m.id === activeMarkerId} label={m.label} />
          )}
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
