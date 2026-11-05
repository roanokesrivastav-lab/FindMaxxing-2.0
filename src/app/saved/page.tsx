import Link from "next/link";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { SavedClient } from "@/components/places/SavedClient";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { ListCards } from "@/components/saved/ListCards";
import { NewListButton } from "@/components/saved/NewListButton";
import { Bookmark, Map as MapIcon } from "lucide-react";
import { featureEnabled } from "@/lib/config";
import { LibraryView } from "@/components/saved/LibraryView";
import { parseLibraryFilters } from "@/lib/places/library";

export const metadata: Metadata = { title: "Saved" };
export const dynamic = "force-dynamic";

export default async function SavedPage({ searchParams }: PageProps<"/saved">) {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav">
        <PageHeader eyebrow="Your list" title="Saved places" />
        <EmptyState
          icon={Bookmark}
          title="Sign in to keep a list"
          body="Save the spots you want to try. They'll sync across your devices."
          action={<ButtonLink href="/auth/sign-in?next=/saved" variant="ink">Sign in</ButtonLink>}
        />
      </div>
    );
  }
  const repo = await getRepository();
  if (featureEnabled("pilotLibrary")) {
    // Roadmap 3.2: the library tools. Flag off keeps the page below exactly as it was.
    const sp = await searchParams;
    const [items, lists, tags] = await Promise.all([repo.saves.library(viewer.id), repo.savedLists.list(viewer.id), repo.saves.tags(viewer.id)]);
    const page = Math.min(50, Math.max(1, Number.parseInt(String(sp.page ?? "1"), 10) || 1));
    return (
      <div className="max-w-2xl mx-auto px-edge md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
        <PageHeader eyebrow="Your list" title="Saved places" subtitle={items.length ? `${items.length} place${items.length === 1 ? "" : "s"}` : undefined} />
        <section className="mb-6" aria-labelledby="your-lists">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 id="your-lists" className="text-xs font-bold uppercase tracking-wider text-muted">
              Your lists{lists.length ? ` · ${lists.length}` : ""}
            </h2>
            <NewListButton />
          </div>
          {lists.length ? <ListCards lists={lists} /> : <p className="text-sm text-muted">Group saved places into lists like “Date night” or “Rainy day”.</p>}
        </section>
        {items.length ? (
          <LibraryView items={items} filters={parseLibraryFilters(sp)} page={page} tags={tags.map((t) => t.tag)} lists={lists.map((l) => ({ id: l.id, name: l.name }))} />
        ) : (
          <EmptyState
            heading="h2"
            icon={MapIcon}
            title="Nothing saved yet"
            body="Tap the bookmark on any place to add it here."
            action={<Link href="/" className="chip" data-active="true">Explore the map</Link>}
          />
        )}
      </div>
    );
  }
  const [places, lists] = await Promise.all([repo.places.listSaved(viewer.id), repo.savedLists.list(viewer.id)]);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Your list" title="Saved places" subtitle={places.length ? `${places.length} place${places.length === 1 ? "" : "s"} to try` : undefined} />

      <section className="mb-6" aria-labelledby="your-lists">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 id="your-lists" className="text-xs font-bold uppercase tracking-wider text-muted">
            Your lists{lists.length ? ` · ${lists.length}` : ""}
          </h2>
          <NewListButton />
        </div>
        {lists.length ? (
          <ListCards lists={lists} />
        ) : (
          <p className="text-sm text-muted">
            Group saved places into lists like “Date night” or “Rainy day”. Add a place from the bookmark on its page.
          </p>
        )}
      </section>

      <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">All saved</h2>
      {places.length ? (
        <SavedClient places={places} />
      ) : (
        <EmptyState
          heading="h3"
          icon={MapIcon}
          title="Nothing saved yet"
          body="Tap the bookmark on any place to add it here."
          action={
            <Link href="/" className="chip" data-active="true">
              Explore the map
            </Link>
          }
        />
      )}
    </div>
  );
}
