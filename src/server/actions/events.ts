"use server";

import { track } from "@/server/analytics";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { parseEventPilotFields, type EventPilotFields } from "@/lib/events/form";
import { combineDateTime, eventSchema, fieldErrors, uuidSchema } from "@/lib/validation/schemas";
import { fail, str, strList, succeed, toFailure, type ActionResult } from "./result";

/** Pilot event fields (roadmap M4): read only with pilotEvents on; off, nothing extra is written. */
function pilotFields(formData: FormData): { ok: true; data: EventPilotFields } | { ok: false; errors: Record<string, string> } {
  if (!featureEnabled("pilotEvents")) return { ok: true, data: {} };
  return parseEventPilotFields((key) => str(formData, key));
}

export async function createEventAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to create an event", undefined, "unauthenticated");

  const parsed = eventSchema.safeParse({
    title: str(formData, "title"),
    description: str(formData, "description"),
    placeId: str(formData, "placeId"),
    locationName: str(formData, "locationName"),
    address: str(formData, "address"),
    city: str(formData, "city"),
    lat: str(formData, "lat"),
    lng: str(formData, "lng"),
    date: str(formData, "date"),
    startTime: str(formData, "startTime"),
    endTime: str(formData, "endTime"),
    categorySlug: str(formData, "categorySlug"),
    capacity: str(formData, "capacity"),
    tags: strList(formData, "tags"),
    tzOffsetMinutes: str(formData, "tzOffsetMinutes") || "0",
  });
  const pilot = pilotFields(formData);
  if (!parsed.success || !pilot.ok) return fail("Check the highlighted fields", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(pilot.ok ? {} : pilot.errors) });

  const v = parsed.data;
  const { startsAt, endsAt } = combineDateTime(v.date, v.startTime, v.endTime, v.tzOffsetMinutes);
  try {
    const repo = await getRepository();
    const event = await repo.events.create(
      {
        title: v.title,
        description: v.description,
        placeId: v.placeId,
        locationName: v.locationName,
        address: v.address,
        lat: v.lat,
        lng: v.lng,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt ? endsAt.toISOString() : null,
        categorySlug: v.categorySlug,
        capacity: v.capacity,
        tags: v.tags,
        ...pilot.data,
      },
      viewer.id,
    );
    revalidatePath("/");
    revalidatePath("/events");
    revalidatePath("/profile");
    await track("create_event", { eventId: event.id });
    redirect(`/events/${event.id}?new=1`);
  } catch (err) {
    return toFailure(err);
  }
}

export async function updateEventAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to edit events", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(str(formData, "eventId"));
  if (!id.success) return fail("Invalid event");
  const parsed = eventSchema.safeParse({
    title: str(formData, "title"), description: str(formData, "description"), placeId: str(formData, "placeId"),
    locationName: str(formData, "locationName"), address: str(formData, "address"), city: str(formData, "city"), lat: str(formData, "lat"), lng: str(formData, "lng"),
    date: str(formData, "date"), startTime: str(formData, "startTime"), endTime: str(formData, "endTime"), categorySlug: str(formData, "categorySlug"),
    capacity: str(formData, "capacity"), tags: strList(formData, "tags"), tzOffsetMinutes: str(formData, "tzOffsetMinutes") || "0",
  });
  const pilot = pilotFields(formData);
  if (!parsed.success || !pilot.ok) return fail("Check the highlighted fields", { ...(parsed.success ? {} : fieldErrors(parsed.error)), ...(pilot.ok ? {} : pilot.errors) });
  const v = parsed.data;
  const { startsAt, endsAt } = combineDateTime(v.date, v.startTime, v.endTime, v.tzOffsetMinutes);
  try {
    const repo = await getRepository();
    const event = await repo.events.update(id.data, { title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags, ...pilot.data }, viewer.id);
    revalidatePath(`/events/${id.data}`); revalidatePath(`/events/${id.data}/edit`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
    redirect(`/events/${event.id}`);
  } catch (err) { return toFailure(err); }
}

export async function cancelEventAction(eventId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to cancel events", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    await repo.events.cancel(id.data, viewer.id);
    // Paid tickets now wait for their refund (the payments cron asks Stripe).
    // In demo mode no money moved, so the refunds are settled straight away.
    if (paymentsMode() === "demo") for (const t of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(t.paymentIntentId);
    revalidatePath(`/events/${id.data}`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

export async function deleteEventAction(eventId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to delete events", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    await repo.events.delete(id.data, viewer.id);
    revalidatePath(`/events/${id.data}`); revalidatePath("/events"); revalidatePath("/profile");
    redirect("/events");
  } catch (err) { return toFailure(err); }
}

export async function toggleAttendanceAction(eventId: string, join: boolean): Promise<ActionResult<{ joined: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to join events", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    if (join) await repo.events.join(viewer.id, id.data);
    else await repo.events.leave(viewer.id, id.data);
    if (join) await track("join_event", { eventId: id.data });
    revalidatePath(`/events/${id.data}`);
    revalidatePath("/events");
    revalidatePath("/profile");
    return succeed({ joined: join });
  } catch (err) {
    return toFailure(err);
  }
}
