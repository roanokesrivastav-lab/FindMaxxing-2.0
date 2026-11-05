"use server";

import { track } from "@/server/analytics";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { parseEventPilotFields, pilotInput, type EventPilotFields } from "@/lib/events/form";
import { combineDateTime, eventSchema, fieldErrors, uuidSchema } from "@/lib/validation/schemas";
import { fail, str, strList, succeed, toFailure, type ActionResult } from "./result";

/** Pilot event fields (roadmap M4): read only with pilotEvents on; off, nothing extra is written. */
function pilotFields(formData: FormData): { ok: true; data: EventPilotFields } | { ok: false; errors: Record<string, string> } {
  if (!featureEnabled("pilotEvents")) return { ok: true, data: {} };
  const parsed = parseEventPilotFields((key) => str(formData, key));
  const capacity = Number(str(formData, "capacity")) || null;
  if (parsed.ok && parsed.data.minAttendance && capacity && parsed.data.minAttendance > capacity) {
    return { ok: false, errors: { minAttendance: "The minimum can't be more than the capacity" } };
  }
  return parsed;
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
        ...pilotInput(pilot.data, startsAt),
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
    const event = await repo.events.update(id.data, { title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags, ...pilotInput(pilot.data, startsAt) }, viewer.id);
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

export async function toggleAttendanceAction(eventId: string, join: boolean): Promise<ActionResult<{ joined: boolean; status?: "going" | "waitlisted" | "left" }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to join events", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    // 4.4: a full free event puts the viewer on the waitlist instead of refusing.
    const outcome = join ? await repo.events.join(viewer.id, id.data) : (await repo.events.leave(viewer.id, id.data), "left" as const);
    if (outcome === "going") await track("join_event", { eventId: id.data });
    revalidatePath(`/events/${id.data}`);
    revalidatePath("/events");
    revalidatePath("/profile");
    return succeed({ joined: outcome === "going", status: outcome });
  } catch (err) {
    return toFailure(err);
  }
}

/** 4.3 (pilotEvents): the host confirms the session is happening before its deadline. */
export async function confirmSessionAction(eventId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!featureEnabled("pilotEvents")) return fail("Not available", undefined, "not_found");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    await repo.events.confirmSession(viewer.id, id.data);
    revalidatePath(`/events/${id.data}`); revalidatePath("/events");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

export type ParticipationOp = "interest-on" | "interest-off" | "accept" | "decline" | "leave";

/** 4.4 (pilotEvents): interested, accept or decline an offer, leave the waitlist. All through the RPCs. */
export async function participationAction(eventId: string, op: ParticipationOp): Promise<ActionResult<{ status: string }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    let status: string;
    if (op === "interest-on" || op === "interest-off") status = await repo.events.setInterest(viewer.id, id.data, op === "interest-on") ?? "none";
    else if (op === "accept") status = await repo.events.acceptOffer(viewer.id, id.data);
    else if (op === "decline") { await repo.events.declineOffer(viewer.id, id.data); status = "declined"; }
    else { await repo.events.leave(viewer.id, id.data); status = "left"; }
    revalidatePath(`/events/${id.data}`); revalidatePath("/events");
    return succeed({ status });
  } catch (err) { return toFailure(err); }
}

/** 4.4: the host removes someone from their event or its waitlist. */
export async function hostRemoveParticipantAction(eventId: string, userId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  const who = uuidSchema.safeParse(userId);
  if (!id.success || !who.success) return fail("Invalid request");
  try {
    const repo = await getRepository();
    await repo.events.hostRemoveParticipant(viewer.id, id.data, who.data);
    revalidatePath(`/events/${id.data}`);
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}
