import type { Metadata } from "next";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { toPlaceOption } from "@/components/forms/PlacePicker";
import { EventForm } from "@/components/forms/EventForm";
import { FormShell } from "@/components/layout/FormShell";

export const metadata: Metadata = { title: "Create an event" };
export const dynamic = "force-dynamic";

export default async function NewEventPage({ searchParams }: PageProps<"/events/new">) {
  const [sp, viewer] = await Promise.all([searchParams, requireViewer("/events/new")]);
  const repo = await getRepository();
  // Only the place linked from ?placeId= is resolved here; the picker searches for the rest.
  const linked = typeof sp.placeId === "string" ? await repo.places.get(sp.placeId, viewer.id) : null;
  const initialPlace = linked ? toPlaceOption(linked) : null;
  return (
    <FormShell
      title="Create an event"
      subtitle="Pick a time, drop a pin, and people will find you."
      eyebrow="Host"
      backHref="/events"
      tone="pulse"
    >
      <EventForm initialPlace={initialPlace} defaultCity={viewer.profile.homeCity ?? ""} />
    </FormShell>
  );
}
