"use client";
import { useCallback, useEffect, useState } from "react";
import type { LngLat } from "./types";

type Status = "idle" | "requesting" | "granted" | "denied" | "unsupported";

/**
 * Reads the device location once, only after the user (or caller) asks.
 * Never blocks rendering; the map has a sensible default center.
 */
export function useGeolocation(auto = false) {
  const [status, setStatus] = useState<Status>("idle");
  const [location, setLocation] = useState<LngLat | null>(null);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setStatus("unsupported");
      return;
    }
    setStatus("requesting");
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setStatus("granted");
        },
        (error) => setStatus(error.code === error.POSITION_UNAVAILABLE ? "unsupported" : "denied"),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
      );
    } catch {
      // Some browsers throw synchronously when location is blocked by the
      // document's permissions policy instead of calling the error callback.
      setStatus("unsupported");
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    // Only auto-request if permission was previously granted, to avoid a cold prompt on first paint.
    if (typeof navigator !== "undefined" && "permissions" in navigator) {
      navigator.permissions
        ?.query({ name: "geolocation" as PermissionName })
        .then((p) => {
          if (p.state === "granted") request();
        })
        .catch(() => {});
    }
  }, [auto, request]);

  return { status, location, request };
}
