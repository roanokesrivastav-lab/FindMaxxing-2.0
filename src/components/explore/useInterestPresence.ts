"use client";
import { useEffect, useRef, useState } from "react";
import { getJson } from "@/components/shared/getJson";
import type { InterestPresence } from "@/lib/explore/arrival";
import { DISCOVERY_DEBOUNCE_MS, discoveryQuery, requestKey, type DiscoveryRequest } from "./discoveryRequest";

export type PresenceState = { status: "idle" | "loading" | "error"; interests: InterestPresence[] };

/**
 * Keeps the first-map per-interest counts (roadmap 1.3) in step with what the map shows: re-asked each
 * time the area or the filters settle, while `enabled`. `initial` is what the server counted for
 * `initialRequest`.
 */
export function useInterestPresence(request: DiscoveryRequest, enabled: boolean, initial: InterestPresence[], initialRequest: DiscoveryRequest): PresenceState {
  const [state, setState] = useState<PresenceState>({ status: "idle", interests: initial });
  const shownKey = useRef(requestKey(initialRequest));
  const key = requestKey(request);
  const latest = useRef(request);
  useEffect(() => {
    latest.current = request;
  });

  useEffect(() => {
    if (!enabled || key === shownKey.current) return;
    const r = latest.current;
    if (!r.bounds || !r.tags.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, status: "loading" }));
      try {
        const body = await getJson<{ interests: InterestPresence[] }>(`/api/discover/presence?${discoveryQuery({ ...r, text: "", near: null }, { kind: r.kind })}`, controller.signal);
        shownKey.current = key;
        setState({ status: "idle", interests: body.interests });
      } catch {
        if (!controller.signal.aborted) setState((s) => ({ ...s, status: "error" }));
      }
    }, DISCOVERY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, key]);

  return state;
}
