import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { PlaceForm } from "@/components/forms/PlaceForm";
import { FormShell } from "@/components/layout/FormShell";
import { SEED_CITY } from "@/lib/seed/seed-data";

export const metadata: Metadata = { title: "Edit place" };
export const dynamic = "force-dynamic";

export default async function EditPlacePage({ params }: PageProps<"/places/[id]/edit">) {
  const [{ id }, viewer, repo] = await Promise.all([params, requireViewer("/places"), getRepository()]);
  const place = await repo.places.get(id, viewer.id);
  if (!place || place.creatorId !== viewer.id) notFound();
  return (
    <FormShell title="Edit place" subtitle="Keep the local details accurate without changing its community history." eyebrow="Owner controls" backHref={`/places/${id}`}>
      <PlaceForm defaultCity={place.city || viewer.profile.homeCity || SEED_CITY} initial={place} edit />
    </FormShell>
  );
}
