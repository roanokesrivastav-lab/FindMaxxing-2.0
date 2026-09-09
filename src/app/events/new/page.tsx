import type { Metadata } from "next";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { EventForm } from "@/components/forms/EventForm";
import { FormShell } from "@/components/layout/FormShell";

export const metadata: Metadata = { title: "Create an event" };
export const dynamic = "force-dynamic";

export default async function NewEventPage({ searchParams }: PageProps<"/events/new">) {
  const [sp, viewer] = await Promise.all([searchParams, requireViewer("/events/new")]);
  const repo = await getRepository();
  const places = (await repo.places.list({ limit: 500, viewerId: viewer.id }))
    .map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, address: p.address, categorySlug: p.categorySlug }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const initialPlaceId = typeof sp.placeId === "string" && places.some((p) => p.id === sp.placeId) ? sp.placeId : null;
  return (
    <FormShell
      title="Create an event"
      subtitle="Pick a time, drop a pin, and people will find you."
      eyebrow="Host"
      backHref="/events"
      tone="pulse"
    >
      <EventForm places={places} initialPlaceId={initialPlaceId} />
    </FormShell>
  );
}
