"use client";
import "mapbox-gl/dist/mapbox-gl.css";
import { forwardRef } from "react";
import { Map, Marker, NavigationControl, GeolocateControl } from "react-map-gl/mapbox";
import { MapCanvas, type MapCanvasHandle, type MapCanvasProps, type MapLibComponents } from "./MapCanvas";

// The Mapbox and MapLibre flavors of react-map-gl share a component API.
const lib = { Map, Marker, NavigationControl, GeolocateControl } as unknown as MapLibComponents;

const MapboxCanvas = forwardRef<MapCanvasHandle, Omit<MapCanvasProps, "lib" | "mapStyle">>(function MapboxCanvas(props, ref) {
  return (
    <MapCanvas
      ref={ref}
      lib={lib}
      mapStyle={process.env.NEXT_PUBLIC_MAPBOX_STYLE || "mapbox://styles/mapbox/streets-v12"}
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN}
      {...props}
    />
  );
});

export default MapboxCanvas;
