import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { EventForm, type PlaceOption } from "@/components/forms/EventForm";
import { FormShell } from "@/components/layout/FormShell";
import { eventHasEnded } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Edit event" };
export const dynamic = "force-dynamic";

export default async function EditEventPage({ params }: PageProps<"/events/[id]/edit">) {
  const [{ id }, viewer, repo] = await Promise.all([params, requireViewer("/events"), getRepository()]);
  const [event, places] = await Promise.all([repo.events.get(id, viewer.id), repo.places.list({ limit: 500, viewerId: viewer.id })]);
  if (!event || event.creatorId !== viewer.id || event.status !== "published" || eventHasEnded(event.startsAt, event.endsAt)) notFound();
  const options: PlaceOption[] = places.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, address: p.address, categorySlug: p.categorySlug, city: p.city })).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <FormShell title="Edit event" subtitle="Existing attendees stay joined when details change." eyebrow="Owner controls" backHref={`/events/${id}`} tone="pulse">
      <EventForm places={options} initial={event} defaultCity={viewer.profile.homeCity ?? ""} edit />
    </FormShell>
  );
}
