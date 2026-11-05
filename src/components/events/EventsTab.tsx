"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, History } from "lucide-react";
import type { Event, Page } from "@/lib/data/types";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { LoadMoreButton, PagedError, usePagedList } from "@/components/shared/PagedList";
import { useViewerTime } from "@/components/time/ViewerTime";
import { eventHasEnded, formatInZone } from "@/lib/utils/format";
import { groupByBucket, type UsualEvent } from "@/lib/events/tab";
import { EventRow } from "./EventRow";

const PAGE_SIZE = 30;
type View = "upcoming" | "past";

/**
 * Roadmap 1.5: the Quiet-utility Events tab. "Your events" first (signed up + usually go to), grouped
 * Today / Tomorrow / This weekend / Later, then the rest of the upcoming feed in the same rows, then a
 * Been to view. The flag-off screen is EventsClient, unchanged.
 */
export function EventsTab({
  initial,
  joined,
  usual,
  signedIn,
  showPrices,
  logImpressions = false,
}: {
  /** First page of the upcoming feed. */
  initial: Page<Event>;
  /** Every event the viewer joined, past and upcoming. */
  joined: Event[];
  /** Upcoming events the viewer usually goes to (1.5 rule), not joined. */
  usual: UsualEvent[];
  signedIn: boolean;
  /** Payments on: rows show prices. */
  showPrices: boolean;
  logImpressions?: boolean;
}) {
  const time = useViewerTime();
  const [view, setView] = useState<View>("upcoming");
  const list = usePagedList<Event>({ initial, endpoint: "events", query: {}, pageSize: PAGE_SIZE });

  const going = useMemo(() => joined.filter((e) => !eventHasEnded(e.startsAt, e.endsAt, time.now)), [joined, time.now]);
  const past = useMemo(() => joined.filter((e) => eventHasEnded(e.startsAt, e.endsAt, time.now)).reverse(), [joined, time.now]);
  const goingIds = useMemo(() => new Set(going.map((e) => e.id)), [going]);
  const usualById = useMemo(() => new Map(usual.map((u) => [u.event.id, u])), [usual]);
  const yours = useMemo(() => groupByBucket([...going, ...usual.map((u) => u.event).filter((e) => !goingIds.has(e.id))], time), [going, usual, goingIds, time]);
  const shownAbove = useMemo(() => new Set([...goingIds, ...usualById.keys()]), [goingIds, usualById]);
  const more = useMemo(() => groupByBucket(list.items.filter((e) => !shownAbove.has(e.id)), time), [list.items, shownAbove, time]);
  const positions = useMemo(() => new Map(list.items.map((e, i) => [e.id, i])), [list.items]);

  const row = (e: Event, feed = false) => {
    const u = usualById.get(e.id);
    return (
      <EventRow
        key={e.id}
        event={e}
        price={showPrices ? (e.priceCents ?? null) : null}
        going={goingIds.has(e.id)}
        note={u && !goingIds.has(e.id) ? `Like ${u.like.title}, which you went to` : null}
        impression={feed && logImpressions ? { itemType: "event", itemId: e.id, surface: "list", position: positions.get(e.id) ?? null } : null}
      />
    );
  };

  return (
    <div className="treatment-utility flex flex-col">
      <div className="flex flex-wrap gap-item" role="group" aria-label="Show">
        <Chip active={view === "upcoming"} onClick={() => setView("upcoming")}>
          Upcoming
        </Chip>
        {signedIn ? (
          <Chip active={view === "past"} onClick={() => setView("past")}>
            Been to
          </Chip>
        ) : null}
      </div>

      {view === "past" ? (
        past.length ? (
          <PastList events={past} />
        ) : (
          <EmptyState className="mt-section" icon={History} title="Nothing behind you yet" body="Events you join will show up here once they've happened." />
        )
      ) : (
        <>
          <section aria-labelledby="your-events">
            <SectionHeader id="your-events" title="Your events" />
            {!signedIn ? (
              <p className="type-body text-ink-2">
                <Link href="/auth/sign-in?next=/events" className="font-semibold text-pulse-ink underline underline-offset-4">Sign in</Link> to see the events you signed up for and the ones you usually go to.
              </p>
            ) : yours.length ? (
              <BucketLists groups={yours} render={(e) => row(e)} prefix="yours" />
            ) : (
              <p className="type-body text-ink-2">Nothing yet. Events you join, and ones like those you&apos;ve been to, show up here.</p>
            )}
          </section>

          <section aria-labelledby="more-events" aria-busy={list.stale}>
            <SectionHeader id="more-events" title={signedIn ? "More upcoming" : "Upcoming"} action={<Link href={signedIn ? "/events/new" : "/auth/sign-in?next=/events/new"} className="font-semibold text-pulse-ink underline underline-offset-4">Create an event</Link>} />
            {list.error && list.stale ? <PagedError message={list.error} onRetry={list.retry} /> : null}
            {more.length ? (
              <div className={list.stale ? "opacity-60 transition-opacity" : undefined}>
                <BucketLists groups={more} render={(e) => row(e, true)} prefix="more" />
              </div>
            ) : !list.loading ? (
              <EmptyState icon={CalendarDays} heading="h3" title="No other events coming up" body="Create the event you wish existed." action={<Link href="/events/new" className="chip" data-active="true">+ Create an event</Link>} />
            ) : null}
            {!list.stale && list.error ? <PagedError message={list.error} onRetry={list.retry} /> : null}
            {!list.stale && list.nextCursor && !list.error ? <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} /> : null}
          </section>
        </>
      )}
    </div>
  );
}

function BucketLists({ groups, render, prefix }: { groups: { bucket: string; events: Event[] }[]; render: (e: Event) => React.ReactNode; prefix: string }) {
  return (
    <>
      {groups.map(({ bucket, events }) => {
        const id = `${prefix}-${bucket.toLowerCase().replace(/\s+/g, "-")}`;
        return (
          <div key={bucket} className="mt-row first:mt-0">
            <h3 id={id} className="type-body font-semibold text-muted">{bucket}</h3>
            <ul aria-labelledby={id}>{events.map(render)}</ul>
          </div>
        );
      })}
    </>
  );
}

function PastList({ events }: { events: Event[] }) {
  const time = useViewerTime();
  const months = new Map<string, Event[]>();
  for (const e of events) {
    const label = formatInZone(e.startsAt, time, { month: "long", year: "numeric" });
    months.set(label, [...(months.get(label) ?? []), e]);
  }
  return (
    <>
      {[...months.entries()].map(([label, rows]) => (
        <section key={label} aria-label={label}>
          <SectionHeader title={label} as="h2" />
          <ul>{rows.map((e) => <EventRow key={e.id} event={e} going />)}</ul>
        </section>
      ))}
    </>
  );
}
