"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { normalizeTimeZone, TIME_ZONE_COOKIE } from "@/lib/utils/timezone";

export type ViewerTime = { timeZone: string; now: number };

const ViewerTimeContext = createContext<ViewerTime | null>(null);
const TICK_MS = 60_000;

/**
 * Renders first with the server's zone and clock snapshot (so hydration
 * matches), then switches to the browser's zone and live clock. The zone is
 * remembered in a cookie so the next server render already uses it.
 */
export function ViewerTimeProvider({ initial, children }: { initial: ViewerTime; children: ReactNode }) {
  const [time, setTime] = useState(initial);

  useEffect(() => {
    const browserZone = normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const timeZone = browserZone ?? initial.timeZone;
    if (browserZone && browserZone !== initial.timeZone) {
      document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(browserZone)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    }
    const tick = () => setTime({ timeZone, now: Date.now() });
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [initial.timeZone]);

  return <ViewerTimeContext.Provider value={time}>{children}</ViewerTimeContext.Provider>;
}

/** The zone and clock every client date render must use. */
export function useViewerTime(): ViewerTime {
  const time = useContext(ViewerTimeContext);
  if (!time) throw new Error("useViewerTime must be used inside ViewerTimeProvider");
  return time;
}
