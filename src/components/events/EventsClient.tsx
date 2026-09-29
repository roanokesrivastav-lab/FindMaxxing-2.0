"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Event, Page } from "@/lib/data/types";
import { EVENT_CATEGORIES } from "@/lib/data/taxonomy";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { EventCard } from "./EventCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadMoreButton, PagedError, usePagedList } from "@/components/shared/PagedList";
import { eventHasEnded, relativeDayLabel } from "@/lib/utils/format";

type When = "all" | "today" | "week" | "mine" | "past";
type Feed = { when: "all" | "today" | "week"; startsBefore: string | null };

const PAGE_SIZE = 30;
const UPCOMING_GRACE_MS = 60 * 60_000;

const upcomingCutoff = () => Date.now() - UPCOMING_GRACE_MS;

/** The upcoming feed's upper bound for a range, in the viewer's local time. */
function feedFor(when: "all" | "today" | "week"): Feed {
  const now = new Date();
  if (when === "today") return { when, startsBefore: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString() };
  if (when === "week") return { when, startsBefore: new Date(now.getTime() + 7 * 86_400_000).toISOString() };
  return { when, startsBefore: null };
}

export function EventsClient({
  initial,
  joined,
  signedIn,
}: {
  /** First page of the unfiltered upcoming feed. */
  initial: Page<Event>;
  /** Every event the viewer joined, past and upcoming, by start time. */
  joined: Event[];
  signedIn: boolean;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [when, setWhen] = useState<When>("all");
  // Kept while "Joined" / "Been to" are shown so switching back does not refetch.
  const [feed, setFeed] = useState<Feed>({ when: "all", startsBefore: null });

  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (category) q.category = category;
    if (feed.startsBefore) q.startsBefore = feed.startsBefore;
    return q;
  }, [category, feed.startsBefore]);
  const list = usePagedList<Event>({ initial, endpoint: "events", query, pageSize: PAGE_SIZE });

  // "Joined" and "Been to" come from the viewer's own (bounded) list, not the city feed.
  const own = useMemo(() => {
    if (when !== "mine" && when !== "past") return null;
    const cutoff = upcomingCutoff();
    const upcoming = (e: Event) => !eventHasEnded(e.startsAt, e.endsAt, cutoff);
    const rows = when === "mine" ? joined.filter(upcoming) : joined.filter((e) => !upcoming(e)).reverse();
    return rows.filter((e) => !category || e.categorySlug === category);
  }, [when, joined, category]);

  const shown = own ?? list.items;

  function pick(next: When) {
    setWhen(next);
    if (next === "all" || next === "today" || next === "week") setFeed(feedFor(next));
  }

  // Group by day label for scannability.
  const groups = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of shown) {
      const key = relativeDayLabel(e.startsAt);
      const label =
        when === "past"
          ? new Date(e.startsAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
          : key === "Today" || key === "Tomorrow"
            ? key
            : new Date(e.startsAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      map.set(label, [...(map.get(label) ?? []), e]);
    }
    return [...map.entries()];
  }, [shown, when]);

  const feedShown = own === null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(
          [
            ["all", "Upcoming"],
            ["today", "Today"],
            ["week", "This week"],
            ["mine", "Joined"],
            ...(signedIn ? ([["past", "Been to"]] as [When, string][]) : []),
          ] as [When, string][]
        ).map(([k, label]) => (
          <Chip key={k} active={when === k} onClick={() => pick(k)}>
            {label}
          </Chip>
        ))}
      </div>
      <ChipRow>
        {EVENT_CATEGORIES.map((c) => (
          <Chip key={c.slug} active={category === c.slug} onClick={() => setCategory(category === c.slug ? null : c.slug)} color={c.color}>
            <span aria-hidden>{c.emoji}</span> {c.label}
          </Chip>
        ))}
      </ChipRow>

      {feedShown && list.error && list.stale ? <PagedError message={list.error} onRetry={list.retry} /> : null}

      {groups.length === 0 && !(feedShown && list.loading) ? (
        <EmptyState
          emoji={when === "past" ? "🕰️" : when === "mine" ? "🎟️" : "📅"}
          title={
            when === "past"
              ? "Nothing behind you yet"
              : when === "mine"
                ? "You haven't joined anything yet"
                : "No events match"
          }
          body={
            when === "past"
              ? "Events you join will show up here once they've happened."
              : when === "mine"
                ? "Join an event and it'll show up here."
                : "Try another filter, or create the event you wish existed."
          }
          action={
            <Link href={when === "mine" || when === "past" ? "/events" : "/events/new"} className="chip" data-active="true">
              {when === "mine" || when === "past" ? "Browse events" : "+ Create an event"}
            </Link>
          }
        />
      ) : (
        <div className={feedShown && list.stale ? "flex flex-col gap-4 opacity-60 transition-opacity" : "flex flex-col gap-4"} aria-busy={feedShown && list.stale}>
          {groups.map(([label, rows]) => (
            <section key={label}>
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">{label}</h2>
              <div className="flex flex-col gap-2">
                {rows.map((e) => (
                  <EventCard key={e.id} event={e} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {feedShown && !list.stale && list.error ? <PagedError message={list.error} onRetry={list.retry} /> : null}
      {feedShown && !list.stale && list.nextCursor && !list.error ? <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} /> : null}
    </div>
  );
}
