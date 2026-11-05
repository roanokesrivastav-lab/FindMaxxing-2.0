import Link from "next/link";
import { forYouEvents } from "@/server/recommendations";
import { ForYouRail } from "@/components/recommendations/ForYouRail";
import type { Metadata } from "next";
import { CalendarPlus } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { EventsClient } from "@/components/events/EventsClient";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function EventsPage() {
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
