"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { Event, Page, Place } from "@/lib/data/types";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { addedLabel } from "@/lib/utils/recent";
import { getJson } from "./getJson";

type Endpoint = "places" | "events";
type Query = Record<string, string>;

interface PagedOptions<T> {
  /** The first page, as the server rendered it for `endpoint` and `query`. */
  initial: Page<T>;
  endpoint: Endpoint;
  /** Filters for /api/discover/{endpoint}; paging parameters are added here. */
  query: Query;
  pageSize: number;
}

const urlFor = (endpoint: Endpoint, query: Query, pageSize: number, cursor: string | null) =>
  `/api/discover/${endpoint}?${new URLSearchParams({ ...query, limit: String(pageSize), ...(cursor ? { cursor } : {}) })}`;

/**
 * Cursor paging over /api/discover/*. Starts from a server-rendered first page;
 * when `query` changes it refetches page 1 (superseding any request in flight)
 * and keeps paging from there.
 */
export function usePagedList<T>({ initial, endpoint, query, pageSize }: PagedOptions<T>) {
  const key = JSON.stringify([endpoint, query, pageSize]);
  const [shown, setShown] = useState({ key, items: initial.items, nextCursor: initial.nextCursor });
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Read only from effects and callbacks: the options behind `key`, and the
  // key and options whose items are on screen.
  const latest = useRef({ endpoint, query, pageSize });
  const shownKey = useRef(shown.key);
  const shownOptions = useRef({ endpoint, query, pageSize });
  const moreController = useRef<AbortController | null>(null);
  useEffect(() => {
    latest.current = { endpoint, query, pageSize };
  });
  useEffect(() => () => moreController.current?.abort(), []);

  useEffect(() => {
    if (key === shownKey.current) return;
    moreController.current?.abort();
    const controller = new AbortController();
    const o = latest.current;
    getJson<Page<T>>(urlFor(o.endpoint, o.query, o.pageSize, null), controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        shownKey.current = key;
        shownOptions.current = o;
        setFailure(null);
        setLoadingMore(false);
        setShown({ key, items: page.items, nextCursor: page.nextCursor });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setFailure({ key, message: err instanceof Error ? err.message : "Something went wrong" });
      });
    return () => controller.abort();
  }, [key, attempt]);

  const loadMore = useCallback(async () => {
    const cursor = shown.nextCursor;
    if (!cursor || loadingMore) return;
    // Page the items on screen, even if newer filters are still settling.
    const forKey = shownKey.current;
    const o = shownOptions.current;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    setFailure(null);
    try {
      const page = await getJson<Page<T>>(urlFor(o.endpoint, o.query, o.pageSize, cursor), controller.signal);
      if (controller.signal.aborted || shownKey.current !== forKey) return;
      setShown((prev) => ({ ...prev, items: [...prev.items, ...page.items], nextCursor: page.nextCursor }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setFailure({ key: forKey, message: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      if (moreController.current === controller) setLoadingMore(false);
    }
  }, [shown.nextCursor, loadingMore]);

  const stale = key !== shown.key;
  const error = failure && (failure.key === key || failure.key === shown.key) ? failure.message : null;
  const retry = useCallback(() => {
    setFailure(null);
    if (stale) setAttempt((n) => n + 1);
    else void loadMore();
  }, [stale, loadMore]);

  return {
    items: shown.items,
    nextCursor: shown.nextCursor,
    /** Filters changed and the new first page has not arrived (or failed). */
    stale,
    loading: stale && !error,
    loadingMore,
    error,
    retry,
    loadMore,
  };
}

export function LoadMoreButton({ loading, onClick, label = "Load more" }: { loading: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={loading} className="chip justify-center self-center">
      {loading ? <Loader2 size={14} className="animate-spin" /> : null} {loading ? "Loading" : label}
    </button>
  );
}

/** The inline failure line shared by every pager, with a way to try again. */
export function PagedError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2" role="alert">
      <p className="text-sm text-danger font-medium">{message}</p>
      <button type="button" onClick={onRetry} className="chip justify-center">
        Retry
      </button>
    </div>
  );
}

export type PagedRender = "place-compact" | "event" | "event-compact";

export function PagedList({
  initial,
  endpoint,
  query,
  pageSize,
  render,
  showAdded = false,
  moreLabel,
}: PagedOptions<Place | Event> & {
  render: PagedRender;
  /** Under each card: when it was added and by whom (New this week). */
  showAdded?: boolean;
  moreLabel?: string;
}) {
  const list = usePagedList({ initial, endpoint, query, pageSize });
  return (
    <div className="flex flex-col gap-2">
      {list.items.map((item) => {
        const card =
          render === "place-compact" ? (
            <PlaceCard place={item as Place} compact />
          ) : (
            <EventCard event={item as Event} compact={render === "event-compact"} />
          );
        if (!showAdded) return <div key={item.id}>{card}</div>;
        const creator = item.creator;
        return (
          <div key={item.id} className="flex flex-col gap-1">
            {card}
            <p className="text-[11px] text-muted pl-1">
              {addedLabel(item.createdAt)}
              {creator ? (
                <>
                  {endpoint === "events" ? " · hosted by " : " · by "}
                  <Link href={`/u/${creator.username}`} className="font-semibold hover:text-flare-600">
                    {creator.displayName}
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        );
      })}
      {list.error ? <PagedError message={list.error} onRetry={list.retry} /> : null}
      {list.nextCursor && !list.error ? <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} label={moreLabel} /> : null}
    </div>
  );
}
