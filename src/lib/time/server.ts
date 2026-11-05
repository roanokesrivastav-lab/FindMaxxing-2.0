import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { DEFAULT_TIME_ZONE, normalizeTimeZone, TIME_ZONE_COOKIE } from "@/lib/utils/timezone";

export type ViewerTime = { timeZone: string; now: number };

/**
 * One clock/zone snapshot per request. The root layout hands the same values
 * to the client so its first render matches the server's text exactly.
 */
export const getViewerTime = cache(async (): Promise<ViewerTime> => {
  const store = await cookies();
  const timeZone = normalizeTimeZone(store.get(TIME_ZONE_COOKIE)?.value) ?? DEFAULT_TIME_ZONE;
  return { timeZone, now: Date.now() };
});
