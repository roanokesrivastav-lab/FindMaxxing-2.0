"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Reads and writes a small JSON value in localStorage.
 *
 * Uses useSyncExternalStore rather than an effect so the server render and the
 * first client render agree, and so a change in one component is seen by every
 * other reader of the same key. Storage being unavailable (private mode, a
 * browser blocking site data) degrades to the fallback rather than throwing.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Keeps separate tabs in step.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function usePersistentJson<T>(key: string, fallback: T): [T, (next: T) => void] {
  const getSnapshot = useCallback(() => readRaw(key), [key]);
  // Nothing is stored during SSR, so the server always sees the fallback.
  const getServerSnapshot = useCallback(() => null, []);

  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const value = useMemo<T>(() => {
    if (raw === null) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(raw) as object) } as T;
    } catch {
      return fallback;
    }
    // `fallback` is expected to be a stable literal from the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const set = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Not being able to remember a preference is not worth surfacing.
      }
      emit();
    },
    [key],
  );

  return [value, set];
}
