"use client";

import { useCallback, useEffect, useRef } from "react";
import type { InteractionSurface } from "@/lib/data/types";
import { MAX_INTERACTION_BATCH } from "@/lib/data/types";
import { logImpressionsAction } from "@/server/actions/interactions";

/** Which rendering of a recommendation rail showed the card, and what produced it. */
export interface Attribution {
  requestId: string;
  policy: string;
  score: number;
}

export interface Impression extends Partial<Attribution> {
  itemType: "place" | "event";
  itemId: string;
  surface: InteractionSurface;
  position: number | null;
}

/** Sent when this many are waiting, or this long after the first one. */
const FLUSH_AT = 25;
const FLUSH_AFTER_MS = 3000;
/** A card counts as seen once half of it has been on screen this long. */
const DWELL_MS = 1000;

let queue: Impression[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Sends what is waiting, in the background. Logging must never hold up the page. */
export function flushImpressions(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  while (queue.length) {
    const batch = queue.slice(0, MAX_INTERACTION_BATCH);
    queue = queue.slice(MAX_INTERACTION_BATCH);
    void logImpressionsAction(batch).catch(() => undefined);
  }
}

export function queueImpression(impression: Impression): void {
  queue.push(impression);
  if (queue.length >= FLUSH_AT) flushImpressions();
  else timer ??= setTimeout(flushImpressions, FLUSH_AFTER_MS);
}

if (typeof window !== "undefined") {
  // Leaving or backgrounding the tab: send now rather than lose the batch.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushImpressions();
  });
  window.addEventListener("pagehide", flushImpressions);
}

/**
 * A ref for a card: records one impression per mount once half of it has
 * been visible for a second. Does nothing when `impression` is null.
 */
export function useImpression<T extends Element>(impression: Impression | null): (node: T | null) => void {
  const seenKey = useRef<string | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = impression ? JSON.stringify(impression) : null;

  const stop = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    if (dwell.current) clearTimeout(dwell.current);
    dwell.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  return useCallback(
    (node: T | null) => {
      stop();
      if (!node || !key || seenKey.current === key || typeof IntersectionObserver === "undefined") return;
      // The key carries every field, so this copy is the impression for it.
      const seen = JSON.parse(key) as Impression;
      observer.current = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting && entry.intersectionRatio >= 0.5) {
            dwell.current ??= setTimeout(() => {
              seenKey.current = key;
              queueImpression(seen);
              stop();
            }, DWELL_MS);
          } else if (dwell.current) {
            clearTimeout(dwell.current);
            dwell.current = null;
          }
        },
        { threshold: [0, 0.5] },
      );
      observer.current.observe(node);
    },
    [key, stop],
  );
}
