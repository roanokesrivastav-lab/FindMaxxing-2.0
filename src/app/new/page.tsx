import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { PagedList } from "@/components/shared/PagedList";
import { pluralize } from "@/lib/utils/format";
import { NEW_WINDOW_DAYS, newSince } from "@/lib/utils/recent";

export const metadata: Metadata = { title: "New this week" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export default async function NewThisWeekPage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const viewerId = viewer?.id ?? null;
  const createdAfter = newSince();
  const filters = { createdAfter, viewerId };
  const [places, events, placeCount, eventCount] = await Promise.all([
    repo.places.search({ ...filters, limit: PAGE_SIZE }),
    repo.events.search({ ...filters, limit: PAGE_SIZE }),
    repo.places.count(filters),
    repo.events.count(filters),
  ]);
  const total = placeCount + eventCount;
  // The client pages with the same cutoff the server counted against.
  const query = { createdAfter };

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1">
            <Sparkles size={12} /> Fresh
          </span>
        }
        title="New this week"
        subtitle={total ? `${pluralize(placeCount, "place")} and ${pluralize(eventCount, "event")} added in the last ${NEW_WINDOW_DAYS} days.` : `What locals added in the last ${NEW_WINDOW_DAYS} days.`}
        action={
          <Link href={viewer ? "/places/new" : "/auth/sign-in?next=/places/new"} className="chip shrink-0" data-active="true">
            + Add a place
          </Link>
        }
      />

      {total === 0 ? (
        <EmptyState
          emoji="🌱"
          title="Quiet week so far"
          body={`Nothing new in the last ${NEW_WINDOW_DAYS} days. Know a spot the city should hear about?`}
          action={
            <Link href={viewer ? "/places/new" : "/auth/sign-in?next=/places/new"} className="chip" data-active="true">
              + Add a place
            </Link>
          }
        />
      ) : null}

      {placeCount ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">New places · {placeCount}</h2>
          <PagedList initial={places} endpoint="places" query={query} pageSize={PAGE_SIZE} render="place-compact" showAdded />
        </section>
      ) : null}

      {eventCount ? (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">New events · {eventCount}</h2>
          <PagedList initial={events} endpoint="events" query={query} pageSize={PAGE_SIZE} render="event-compact" showAdded />
        </section>
      ) : null}
    </div>
  );
}
