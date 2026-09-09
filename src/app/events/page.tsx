import Link from "next/link";
import type { Metadata } from "next";
import { CalendarPlus } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { EventsClient } from "@/components/events/EventsClient";
import { PageHeader } from "@/components/ui/PageHeader";
import { eventHasEnded } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Events" };
export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const events = await repo.events.list({ includePast: false, limit: 300, viewerId: viewer?.id ?? null });
  // listJoined already includes events that have finished, so the "Been to"
  // filter costs nothing extra: no need to pull every past event in the city.
  const joined = viewer ? await repo.events.listJoined(viewer.id, viewer.id) : [];
  const joinedIds = new Set(joined.map((e) => e.id));
  const attended = joined.filter((e) => eventHasEnded(e.startsAt, e.endsAt));
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
      <EventsClient events={events} attended={attended} joinedIds={[...joinedIds]} signedIn={!!viewer} />
    </div>
  );
}
