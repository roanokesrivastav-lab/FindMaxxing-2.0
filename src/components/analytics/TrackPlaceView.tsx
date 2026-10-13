"use client";

import { useEffect } from "react";
import { trackPlaceViewAction } from "@/server/actions/analytics";

/** Records one view_place event when the page mounts (signed-in viewers only; the server decides the rest). */
export function TrackPlaceView({ placeId }: { placeId: string }) {
  useEffect(() => {
    void trackPlaceViewAction(placeId).catch(() => undefined);
  }, [placeId]);
  return null;
}
