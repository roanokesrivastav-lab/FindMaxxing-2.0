import Link from "next/link";
import { forYouEvents } from "@/server/recommendations";
import { ForYouRail } from "@/components/recommendations/ForYouRail";
import type { Metadata } from "next";
import { CalendarPlus } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { EventsClient } from "@/components/events/EventsClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { EventsTab } from "@/components/events/EventsTab";
import { usualEvents } from "@/lib/events/tab";
import { MAX_PAGE_SIZE } from "@/lib/data/discovery";
import { getViewerTime } from "@/lib/time/server";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function EventsPage() {
  // Roadmap 1.5 (pilotFoundation): the Quiet-utility tab. Off: the screen below, unchanged.
  if (featureEnabled("pilotFoundation")) return QuietEventsTab();
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  // The client pages onward and refetches page 1 when a filter changes.
  const initial = await repo.events.search({ limit: 30, viewerId: viewer?.id ?? null });
  // listJoined already includes events that have finished, so the "Been to"
  // filter costs nothing extra: no need to pull every past event in the city.
  const joined = viewer ? await repo.events.listJoined(viewer.id, viewer.id) : [];
  // Don't recommend what the list already shows on the first screen.
  const firstScreen = new Set(initial.items.slice(0, 4).map((e) => e.id));
  const rail = await forYouEvents(repo, viewer);
  const forYou = { ...rail, items: rail.items.filter((r) => !firstScreen.has(r.item.id)) };
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow="Do things with people"
        title="Events"
        subtitle="Pickup games, watch parties, study blocks, hikes. Show up and meet someone."
        action={
          <Link href={viewer ? "/events/new" : "/auth/sign-in?next=/events/new"} className="chip shrink-0" data-active="true">
            <CalendarPlus size={15} /> Create
          </Link>
        }
      />
      <ForYouRail events={forYou} title="Events for you" />
      <EventsClient initial={initial} joined={joined} signedIn={!!viewer} logImpressions={!!viewer && featureEnabled("recommendations")} />
    </div>
  );
}

async function QuietEventsTab() {
  const [repo, viewer, time] = await Promise.all([getRepository(), getViewer(), getViewerTime()]);
  const viewerId = viewer?.id ?? null;
  const [initial, joined, candidates] = await Promise.all([
    repo.events.search({ limit: 30, viewerId }),
    viewer ? repo.events.listJoined(viewer.id, viewer.id) : Promise.resolve([]),
    // "Usually go to" candidates: the viewer's own visible upcoming feed (first page).
    viewer ? repo.events.search({ limit: MAX_PAGE_SIZE, viewerId }) : Promise.resolve(null),
  ]);
  // 4.5b (pilotEvents): series the viewer follows count as events they usually go to.
  const followedIds = viewer && featureEnabled("pilotEvents") ? await repo.series.followed(viewer.id) : [];
  const followed = (await Promise.all(followedIds.map((id) => repo.series.get(id, viewerId)))).filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({ id: s.id, title: s.title }));
  const usual = candidates ? usualEvents(joined, candidates.items, time.now, followed) : [];
  return (
    <div className="treatment-utility max-w-2xl mx-auto px-edge md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <div className="flex flex-wrap items-end justify-between gap-row">
        <div className="min-w-0">
          <h1 className="type-page-title text-ink">Events</h1>
          <p className="type-body text-ink-2 mt-hair">What you signed up for and what you usually go to.</p>
        </div>
        <Link href={viewer ? "/events/new" : "/auth/sign-in?next=/events/new"} className="chip shrink-0" data-active="true">
          <CalendarPlus size={15} /> Create
        </Link>
      </div>
      <div className="mt-row">
        <EventsTab initial={initial} joined={joined} usual={usual} signedIn={!!viewer} showPrices={!!paymentsMode()} logImpressions={!!viewer && featureEnabled("recommendations")} />
      </div>
    </div>
  );
}
