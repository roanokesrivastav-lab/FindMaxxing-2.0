import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { getCategory } from "@/lib/data/taxonomy";
import { PageHeader } from "@/components/ui/PageHeader";
import { BackButton } from "@/components/ui/BackButton";
import { PlaceCard } from "@/components/places/PlaceCard";
import { EventCard } from "@/components/events/EventCard";
import { MiniMap } from "@/components/map/MiniMap";
import { pluralize } from "@/lib/utils/format";
import { shareMetadata } from "@/lib/utils/share-metadata";
import { findNeighborhood, groupByNeighborhood, neighborhoodHref } from "@/lib/utils/neighborhoods";

export const dynamic = "force-dynamic";

function decodeSegment(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export async function generateMetadata({ params }: PageProps<"/neighborhoods/[name]">): Promise<Metadata> {
  const { name } = await params;
  const repo = await getRepository();
  // Anonymous on purpose: crawlers only ever see public places.
  const group = findNeighborhood(groupByNeighborhood(await repo.places.list({ limit: 500 })), decodeSegment(name));
  if (!group) return { title: "Neighborhood" };
  return shareMetadata({
    title: group.name,
    description: `${pluralize(group.places.length, "place")} locals actually use in ${group.name}, ${group.city}.`,
    path: neighborhoodHref(group.name),
    image: group.places.find((p) => p.photos.length)?.photos[0]?.url ?? null,
  });
}

export default async function NeighborhoodPage({ params }: PageProps<"/neighborhoods/[name]">) {
  const [{ name }, viewer, repo] = await Promise.all([params, getViewer(), getRepository()]);
  const viewerId = viewer?.id ?? null;
  const [places, allEvents] = await Promise.all([repo.places.list({ limit: 500, viewerId }), repo.events.list({ limit: 300, viewerId })]);
  const groups = groupByNeighborhood(places);
  const group = findNeighborhood(groups, decodeSegment(name));
  if (!group) notFound();

  const placeIds = new Set(group.places.map((p) => p.id));
  const events = allEvents.filter((e) => e.placeId && placeIds.has(e.placeId));
  const others = groups.filter((g) => g.name !== group.name).slice(0, 8);
  const sorted = [...group.places].sort((a, b) => b.ratingCount - a.ratingCount || b.ratingAvg - a.ratingAvg || a.name.localeCompare(b.name));
  const lead = group.topCategories[0] ? getCategory(group.topCategories[0]) : null;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/neighborhoods" />
      </div>
      <PageHeader
        eyebrow={
          <Link href="/neighborhoods" className="hover:text-flare-600">
            Neighborhoods · {group.city}
          </Link>
        }
        title={group.name}
        subtitle={[pluralize(group.places.length, "place"), events.length ? pluralize(events.length, "upcoming event") : null].filter(Boolean).join(" · ")}
        action={
          <Link href="/places/new" className="chip shrink-0" data-active="true">
            + Add here
          </Link>
        }
      />

      <div className="card overflow-hidden mb-6">
        <div className="h-40">
          <MiniMap lat={group.lat} lng={group.lng} color={lead?.color ?? "#7b7c85"} emoji={lead?.emoji ?? "📍"} label={group.name} kind="place" />
        </div>
        {group.topCategories.length ? (
          <div className="p-3 flex gap-1.5 flex-wrap">
            {group.topCategories.slice(0, 5).map((slug) => {
              const c = getCategory(slug);
              return (
                <span key={slug} className="rounded-full px-2.5 py-1 text-xs font-semibold text-white" style={{ background: c.color }}>
                  {c.emoji} {c.label}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>

      {events.length ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Happening here · {events.length}</h2>
          <div className="flex flex-col gap-2">
            {events.map((e) => (
              <EventCard key={e.id} event={e} compact />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mb-8">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Places · {sorted.length}</h2>
        <div className="flex flex-col gap-2">
          {sorted.map((p) => (
            <PlaceCard key={p.id} place={p} compact />
          ))}
        </div>
      </section>

      {others.length ? (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Other neighborhoods</h2>
          <div className="flex gap-2 flex-wrap">
            {others.map((g) => (
              <Link key={g.name} href={neighborhoodHref(g.name)} className="chip">
                {g.name} <span className="text-muted tabular-nums">{g.places.length}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
