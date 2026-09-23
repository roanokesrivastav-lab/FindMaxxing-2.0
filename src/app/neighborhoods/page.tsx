import type { Metadata } from "next";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { getCategory } from "@/lib/data/taxonomy";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { pluralize } from "@/lib/utils/format";
import { groupByNeighborhood, neighborhoodHref } from "@/lib/utils/neighborhoods";

export const metadata: Metadata = { title: "Neighborhoods" };
export const dynamic = "force-dynamic";

export default async function NeighborhoodsPage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const places = await repo.places.list({ limit: 500, viewerId: viewer?.id ?? null });
  const groups = groupByNeighborhood(places);
  const untagged = places.length - groups.reduce((n, g) => n + g.places.length, 0);

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow="Browse by area"
        title="Neighborhoods"
        subtitle={groups.length ? `${pluralize(groups.length, "neighborhood")} with something worth knowing.` : "Places get grouped here by the neighborhood they're added with."}
      />

      {groups.length ? (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 list-none p-0 m-0">
          {groups.map((g) => (
            <li key={g.name}>
              <Link href={neighborhoodHref(g.name)} className="card p-4 flex flex-col gap-2 h-full hover:bg-surface-2 hover:-translate-y-0.5 transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold leading-tight truncate">{g.name}</p>
                    <p className="text-xs text-muted inline-flex items-center gap-1">
                      <MapPin size={11} /> {g.city}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-bold tabular-nums">{pluralize(g.places.length, "place")}</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {g.topCategories.slice(0, 3).map((slug) => {
                    const c = getCategory(slug);
                    return (
                      <span key={slug} className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: c.color }}>
                        {c.emoji} {c.label}
                      </span>
                    );
                  })}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          emoji="🗺️"
          title="No neighborhoods yet"
          body="Add a place and fill in its neighborhood to start the first one."
          action={
            <Link href="/places/new" className="chip" data-active="true">
              + Add a place
            </Link>
          }
        />
      )}
      {untagged > 0 ? <p className="mt-4 text-xs text-muted text-center">{pluralize(untagged, "place")} without a neighborhood {untagged === 1 ? "is" : "are"} only on the map.</p> : null}
    </div>
  );
}
