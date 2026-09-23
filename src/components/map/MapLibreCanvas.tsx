"use client";
import "maplibre-gl/dist/maplibre-gl.css";
import { setWorkerUrl } from "maplibre-gl";
import { forwardRef } from "react";
import { Map, Marker, NavigationControl } from "react-map-gl/maplibre";
import { MapCanvas, type MapCanvasHandle, type MapCanvasProps, type MapLibComponents } from "./MapCanvas";
import { MAPLIBRE_FALLBACK_STYLE } from "@/lib/map/config";

// MapLibre resolves its worker with a dynamic `new URL(...)` that bundlers can't
// statically analyze, which leaves the worker URL empty under Turbopack. The worker
// module (and the sibling it imports) are copied to public/maplibre on install
// (scripts/copy-map-worker.mjs) and served as plain ES modules.
if (typeof window !== "undefined") {
  setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
}

const lib: MapLibComponents = { Map, Marker, NavigationControl };

const MapLibreCanvas = forwardRef<MapCanvasHandle, Omit<MapCanvasProps, "lib" | "mapStyle">>(function MapLibreCanvas(props, ref) {
  return <MapCanvas ref={ref} lib={lib} mapStyle={MAPLIBRE_FALLBACK_STYLE} {...props} />;
});

export default MapLibreCanvas;
