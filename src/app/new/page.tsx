import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { pluralize } from "@/lib/utils/format";
import { NEW_WINDOW_DAYS, addedLabel, newestWithin } from "@/lib/utils/recent";

export const metadata: Metadata = { title: "New this week" };
export const dynamic = "force-dynamic";

export default async function NewThisWeekPage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const viewerId = viewer?.id ?? null;
  const [allPlaces, allEvents] = await Promise.all([repo.places.list({ limit: 500, viewerId }), repo.events.list({ limit: 300, viewerId })]);
  const places = newestWithin(allPlaces);
  const events = newestWithin(allEvents);
  const total = places.length + events.length;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1">
            <Sparkles size={12} /> Fresh
          </span>
        }
        title="New this week"
        subtitle={total ? `${pluralize(places.length, "place")} and ${pluralize(events.length, "event")} added in the last ${NEW_WINDOW_DAYS} days.` : `What locals added in the last ${NEW_WINDOW_DAYS} days.`}
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

      {places.length ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">New places · {places.length}</h2>
          <div className="flex flex-col gap-2">
            {places.map((p) => (
              <div key={p.id} className="flex flex-col gap-1">
                <PlaceCard place={p} compact />
                <p className="text-[11px] text-muted pl-1">
                  {addedLabel(p.createdAt)}
                  {p.creator ? (
                    <>
                      {" · by "}
                      <Link href={`/u/${p.creator.username}`} className="font-semibold hover:text-flare-600">
                        {p.creator.displayName}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {events.length ? (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">New events · {events.length}</h2>
          <div className="flex flex-col gap-2">
            {events.map((e) => (
              <div key={e.id} className="flex flex-col gap-1">
                <EventCard event={e} compact />
                <p className="text-[11px] text-muted pl-1">
                  {addedLabel(e.createdAt)}
                  {e.creator ? (
                    <>
                      {" · hosted by "}
                      <Link href={`/u/${e.creator.username}`} className="font-semibold hover:text-flare-600">
                        {e.creator.displayName}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
