import type { Metadata } from "next";
import Link from "next/link";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { INTERESTS } from "@/lib/data/taxonomy";
import { PageHeader } from "@/components/ui/PageHeader";
import { pluralize } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Interests" };
export const dynamic = "force-dynamic";

export default async function TagsIndexPage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const counts = new Map(Object.entries(await repo.tags.counts({ viewerId: viewer?.id ?? null })));

  const mine = new Set(viewer?.profile.interests ?? []);
  const ordered = [...INTERESTS].sort((a, b) => {
    const am = mine.has(a.slug) ? 0 : 1;
    const bm = mine.has(b.slug) ? 0 : 1;
    if (am !== bm) return am - bm;
    const ac = counts.get(a.slug);
    const bc = counts.get(b.slug);
    return (bc?.places ?? 0) + (bc?.events ?? 0) - ((ac?.places ?? 0) + (ac?.events ?? 0));
  });

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow="Browse by interest"
        title="Interests"
        subtitle={mine.size ? "Yours first, then whatever the city is most into." : "Pick what you're into and see the places and events tagged with it."}
      />
      <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2 list-none p-0 m-0">
        {ordered.map((i) => {
          const c = counts.get(i.slug) ?? { places: 0, events: 0 };
          const yours = mine.has(i.slug);
          return (
            <li key={i.slug}>
              <Link
                href={`/tags/${i.slug}`}
                className="card p-4 flex flex-col gap-2 h-full hover:bg-surface-2 hover:-translate-y-0.5 transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-2xl leading-none" aria-hidden>
                    {i.emoji}
                  </span>
                  {yours ? <span className="rounded-full bg-flare/10 text-flare-600 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5">Yours</span> : null}
                </div>
                <p className="font-bold leading-tight">{i.label}</p>
                <p className="text-xs text-muted">
                  {c.places || c.events ? [c.places ? pluralize(c.places, "place") : null, c.events ? pluralize(c.events, "event") : null].filter(Boolean).join(" · ") : "Nothing tagged yet"}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
