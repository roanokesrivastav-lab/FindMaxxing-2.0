"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Event, EventMapRecord, MapResult, Page, Place, PlaceMapRecord } from "@/lib/data/types";
import { getJson } from "@/components/shared/getJson";
import {
  DISCOVERY_DEBOUNCE_MS,
  EVENT_PAGE,
  PLACE_PAGE,
  discoveryQuery as query,
  requestKey,
  type DiscoveryRequest,
  type DiscoveryResults,
} from "./discoveryRequest";

export type { DiscoveryKind, DiscoveryRequest, DiscoveryResults } from "./discoveryRequest";
export type DiscoveryStatus = "idle" | "loading" | "error";
const EMPTY: Page<never> = { items: [], nextCursor: null };

/**
 * Server-side discovery for the explore screen. Queries once the map (or the
 * search box) has settled, cancels anything a newer request supersedes, and
 * keeps showing the previous results while the next ones load.
 *
 * `initial` is what the server rendered for `initialRequest`; that request is
 * not repeated.
 */
export function useDiscovery(request: DiscoveryRequest, initial: DiscoveryResults, initialRequest: DiscoveryRequest) {
  const [shown, setShown] = useState(() => ({ key: requestKey(initialRequest), results: initial }));
  const [status, setStatus] = useState<DiscoveryStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<"places" | "events" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = requestKey(request);

  // Read only from effects and callbacks: the request behind `key`, the key
  // whose results are on screen, and the last retry already honored.
  const latest = useRef(request);
  const shownKey = useRef(shown.key);
  const shownRequest = useRef(initialRequest);
  const honoredAttempt = useRef(0);
  useEffect(() => {
    latest.current = request;
  });

  useEffect(() => {
    if (key === shownKey.current && attempt === honoredAttempt.current) return;
    honoredAttempt.current = attempt;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const r = latest.current;
      setStatus("loading");
      setError(null);
      try {
        const [map, places, events] = await Promise.all([
          getJson<{ places: MapResult<PlaceMapRecord> | null; events: MapResult<EventMapRecord> | null }>(
            `/api/discover/map?${query(r, { kind: r.kind })}`, controller.signal),
          r.kind === "events" ? EMPTY : getJson<Page<Place>>(`/api/discover/places?${query(r, { limit: PLACE_PAGE })}`, controller.signal),
          r.kind === "places" ? EMPTY : getJson<Page<Event>>(`/api/discover/events?${query(r, { limit: EVENT_PAGE })}`, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        shownKey.current = requestKey(r);
        shownRequest.current = r;
        setShown({ key: shownKey.current, results: { placeMarkers: map.places, eventMarkers: map.events, places, events } });
        setStatus("idle");
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Something went wrong");
        setStatus("error");
      }
    }, DISCOVERY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const { results } = shown;
  const loadMore = useCallback(
    async (which: "places" | "events") => {
      const cursor = which === "places" ? results.places.nextCursor : results.events.nextCursor;
      if (!cursor || loadingMore) return;
      // Page the results on screen, even if newer filters are still settling.
      const forKey = shownKey.current;
      const r = shownRequest.current;
      setLoadingMore(which);
      try {
        const page = await getJson<Page<Place | Event>>(
          `/api/discover/${which}?${query(r, { limit: which === "places" ? PLACE_PAGE : EVENT_PAGE, cursor })}`,
          new AbortController().signal,
        );
        // A new search replaced the results meanwhile: this page belongs to the old one.
        if (shownKey.current !== forKey) return;
        setShown((prev) => ({
          ...prev,
          results:
            which === "places"
              ? { ...prev.results, places: { items: [...prev.results.places.items, ...(page.items as Place[])], nextCursor: page.nextCursor } }
              : { ...prev.results, events: { items: [...prev.results.events.items, ...(page.items as Event[])], nextCursor: page.nextCursor } },
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLoadingMore(null);
      }
    },
    [results.places.nextCursor, results.events.nextCursor, loadingMore],
  );

  return { results, status, error, retry, loadMore, loadingMore, stale: key !== shown.key };
}
