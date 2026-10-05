import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { uuidSchema } from "@/lib/validation/schemas";
import { SavedClient } from "@/components/places/SavedClient";
import { ListActions } from "@/components/saved/ListActions";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { BackButton } from "@/components/ui/BackButton";
import { pluralize } from "@/lib/utils/format";

export const dynamic = "force-dynamic";
// Lists are private: nothing about one belongs in a title a crawler or a shared tab could show.
export const metadata: Metadata = { title: "Saved list" };

export default async function SavedListPage({ params }: PageProps<"/saved/[id]">) {
  const [{ id }, viewer] = await Promise.all([params, getViewer()]);
  if (!viewer) redirect(`/auth/sign-in?next=${encodeURIComponent(`/saved/${id}`)}`);
  const listId = uuidSchema.safeParse(id);
  if (!listId.success) notFound();
  const repo = await getRepository();
  // Someone else's list is indistinguishable from a missing one.
  const found = await repo.savedLists.get(viewer.id, listId.data);
  if (!found) notFound();
  const { list, places } = found;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/saved" />
      </div>
      <PageHeader
        eyebrow={
          <Link href="/saved" className="hover:text-flare-600">
            Saved · List
          </Link>
        }
        title={list.name}
        subtitle={places.length ? pluralize(places.length, "place") : undefined}
        action={<ListActions listId={list.id} name={list.name} placeCount={places.length} />}
      />
      {places.length ? (
        <SavedClient places={places} listId={list.id} />
      ) : (
        <EmptyState
          emoji="📌"
          title="Nothing in this list yet"
          body="Open a place and tap its bookmark to add it here. It can be in other lists too."
          action={
            <Link href="/saved" className="chip" data-active="true">
              Back to saved places
            </Link>
          }
        />
      )}
    </div>
  );
}
