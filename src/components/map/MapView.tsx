"use client";
import dynamic from "next/dynamic";
import { forwardRef, useState } from "react";
import { WifiOff } from "lucide-react";
import type { MapCanvasHandle, MapCanvasProps } from "./MapCanvas";
import { mapProvider } from "@/lib/map/config";
import { cn } from "@/lib/utils/cn";

/**
 * Picks the map provider at build time from NEXT_PUBLIC_MAPBOX_TOKEN and
 * lazy-loads only that library on the client. Wraps loading and error states.
 */
const Canvas =
  mapProvider() === "mapbox"
    ? dynamic(() => import("./MapboxCanvas"), { ssr: false, loading: () => <MapSkeleton /> })
    : dynamic(() => import("./MapLibreCanvas"), { ssr: false, loading: () => <MapSkeleton /> });

export type MapViewProps = Omit<MapCanvasProps, "lib" | "mapStyle" | "mapboxAccessToken"> & { className?: string };

export const MapView = forwardRef<MapCanvasHandle, MapViewProps>(function MapView({ className, onLoad, onError, ...props }, ref) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={cn("relative h-full w-full bg-paper-2 overflow-hidden", className)}>
      <Canvas
        ref={ref}
        {...props}
        onLoad={() => {
          setLoaded(true);
          onLoad?.();
        }}
        onError={(msg) => {
          setError(msg);
          onError?.(msg);
        }}
      />
      {!loaded && !error ? (
        <div className="absolute inset-0 pointer-events-none">
          <MapSkeleton />
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 paper-grid flex items-center justify-center p-6">
          <div className="card px-5 py-4 max-w-xs text-center">
            <WifiOff className="mx-auto text-muted mb-2" />
            <p className="font-bold">Map tiles didn&apos;t load</p>
            <p className="text-sm text-muted mt-1">Check your connection. The list below still works.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export function MapSkeleton() {
  return (
    <div className="h-full w-full paper-grid relative overflow-hidden">
      <div className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_50%_45%,rgba(255,77,46,0.10),transparent_45%)]" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 rounded-full bg-surface/90 px-3 py-1.5 text-xs font-semibold text-muted border border-line">
        <span className="h-2 w-2 rounded-full bg-flare animate-pulse" />
        Loading map
      </div>
    </div>
  );
}
