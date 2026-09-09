import type { Metadata } from "next";
import { requireViewer } from "@/lib/auth/server";
import { PlaceForm } from "@/components/forms/PlaceForm";
import { FormShell } from "@/components/layout/FormShell";
import { SEED_CITY } from "@/lib/seed/seed-data";

export const metadata: Metadata = { title: "Add a place" };
export const dynamic = "force-dynamic";

export default async function NewPlacePage() {
  const viewer = await requireViewer("/places/new");
  return (
    <FormShell
      title="Add a place"
      subtitle="The court, trail, bar or corner that locals actually use. Skip the tourist stuff."
      eyebrow="Contribute"
      backHref="/"
    >
      <PlaceForm defaultCity={viewer.profile.homeCity ?? SEED_CITY} />
    </FormShell>
  );
}
