"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Event } from "@/lib/data/types";
import { EVENT_CATEGORIES } from "@/lib/data/taxonomy";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { EventCard } from "./EventCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeDayLabel } from "@/lib/utils/format";

type When = "all" | "today" | "week" | "mine" | "past";

export function EventsClient({
  events,
  attended,
  joinedIds,
  signedIn,
}: {
  events: Event[];
  /** Events the viewer joined that have already finished. */
  attended: Event[];
  joinedIds: string[];
  signedIn: boolean;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [when, setWhen] = useState<When>("all");
  const joined = useMemo(() => new Set(joinedIds), [joinedIds]);

  const filtered = useMemo(() => {
    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const endOfWeek = now.getTime() + 7 * 86_400_000;
    // "Been to" reads from a different list: the upcoming feed excludes the past.
    const source = when === "past" ? [...attended].reverse() : events;
    return source.filter((e) => {
      if (category && e.categorySlug !== category) return false;
      const t = new Date(e.startsAt).getTime();
      if (when === "today") return t < endOfToday;
      if (when === "week") return t < endOfWeek;
      if (when === "mine") return joined.has(e.id);
      return true;
    });
  }, [events, attended, category, when, joined]);

  // Group by day label for scannability.
  const groups = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of filtered) {
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
  }, [filtered, when]);

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
          <Chip key={k} active={when === k} onClick={() => setWhen(k)}>
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

      {groups.length === 0 ? (
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
        groups.map(([label, list]) => (
          <section key={label}>
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">{label}</h2>
            <div className="flex flex-col gap-2">
              {list.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
