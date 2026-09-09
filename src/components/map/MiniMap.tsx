"use client";
import { useState } from "react";
import { MapView } from "./MapView";
import type { MapMarker } from "@/lib/map/types";

/** Static-feeling map thumbnail for detail pages. */
export function MiniMap({ lat, lng, color, emoji, label, kind }: { lat: number; lng: number; color: string; emoji: string; label: string; kind: "place" | "event" }) {
  const [view, setView] = useState({ latitude: lat, longitude: lng, zoom: 14.5 });
  const markers: MapMarker[] = [{ id: "target", kind, lat, lng, color, emoji, label }];
  return <MapView viewState={view} onViewStateChange={setView} markers={markers} showControls={false} interactive={false} />;
}
