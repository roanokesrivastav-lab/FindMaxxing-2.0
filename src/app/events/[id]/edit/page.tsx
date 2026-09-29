import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { EventForm } from "@/components/forms/EventForm";
import { toPlaceOption } from "@/components/forms/PlacePicker";
import { FormShell } from "@/components/layout/FormShell";
import { eventHasEnded } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Edit event" };
export const dynamic = "force-dynamic";

export default async function EditEventPage({ params }: PageProps<"/events/[id]/edit">) {
  const [{ id }, viewer, repo] = await Promise.all([params, requireViewer("/events"), getRepository()]);
  const event = await repo.events.get(id, viewer.id);
  if (!event || event.creatorId !== viewer.id || event.status !== "published" || eventHasEnded(event.startsAt, event.endsAt)) notFound();
  const linked = event.placeId ? await repo.places.get(event.placeId, viewer.id) : null;
  return (
    <FormShell title="Edit event" subtitle="Existing attendees stay joined when details change." eyebrow="Owner controls" backHref={`/events/${id}`} tone="pulse">
      <EventForm initialPlace={linked ? toPlaceOption(linked) : null} initial={event} defaultCity={viewer.profile.homeCity ?? ""} edit />
    </FormShell>
  );
}
