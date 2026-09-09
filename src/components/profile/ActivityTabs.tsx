"use client";
import { useState } from "react";
import Link from "next/link";
import type { UserActivity } from "@/lib/data/types";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils/cn";

type Tab = "places" | "events" | "joined" | "saved";

export function ActivityTabs({ activity, isSelf }: { activity: UserActivity; isSelf: boolean }) {
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "places", label: "Places", count: activity.createdPlaces.length },
    { key: "events", label: "Hosting", count: activity.createdEvents.length },
    { key: "joined", label: "Going", count: activity.joinedEvents.length },
    ...(isSelf ? [{ key: "saved" as Tab, label: "Saved", count: activity.savedPlaces.length }] : []),
  ];
  const [tab, setTab] = useState<Tab>("places");

  return (
    <div>
      <div className="flex gap-1 rounded-full bg-surface-2 p-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 h-9 rounded-full text-sm font-semibold transition-colors",
              tab === t.key ? "bg-surface shadow-card text-ink" : "text-muted hover:text-ink",
            )}
          >
            {t.label} <span className="text-xs opacity-70">{t.count}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {tab === "places" &&
          (activity.createdPlaces.length ? (
            activity.createdPlaces.map((p) => <PlaceCard key={p.id} place={p} compact />)
          ) : (
            <EmptyState emoji="📍" title={isSelf ? "You haven't added a place yet" : "No places yet"} body={isSelf ? "Know a spot? Put it on the map." : undefined} action={isSelf ? <Link href="/places/new" className="chip" data-active="true">+ Add a place</Link> : undefined} />
          ))}
        {tab === "events" &&
          (activity.createdEvents.length ? (
            activity.createdEvents.map((e) => <EventCard key={e.id} event={e} compact />)
          ) : (
            <EmptyState emoji="📅" title={isSelf ? "You're not hosting anything" : "Not hosting anything"} action={isSelf ? <Link href="/events/new" className="chip" data-active="true">+ Create an event</Link> : undefined} />
          ))}
        {tab === "joined" &&
          (activity.joinedEvents.length ? (
            activity.joinedEvents.map((e) => <EventCard key={e.id} event={e} compact />)
          ) : (
            <EmptyState emoji="🎟️" title={isSelf ? "No events joined yet" : "Not going to anything yet"} action={isSelf ? <Link href="/events" className="chip" data-active="true">Browse events</Link> : undefined} />
          ))}
        {tab === "saved" &&
          (activity.savedPlaces.length ? (
            activity.savedPlaces.map((p) => <PlaceCard key={p.id} place={p} compact />)
          ) : (
            <EmptyState emoji="🔖" title="Nothing saved" action={<Link href="/" className="chip" data-active="true">Explore</Link>} />
          ))}
      </div>
    </div>
  );
}
