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

export const metadata: Metadata = { title: "Saved" };
export const dynamic = "force-dynamic";

export default async function SavedPage() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav">
        <PageHeader eyebrow="Your list" title="Saved places" />
        <EmptyState
          emoji="🔖"
          title="Sign in to keep a list"
          body="Save the spots you want to try. They'll sync across your devices."
          action={<ButtonLink href="/auth/sign-in?next=/saved" variant="ink">Sign in</ButtonLink>}
        />
      </div>
    );
  }
  const repo = await getRepository();
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
          emoji="🗺️"
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
