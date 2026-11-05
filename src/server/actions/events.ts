"use server";

import { track } from "@/server/analytics";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { durationMinutes, parseEventPilotFields, parseRepeatRule, pilotInput, type EventPilotFields } from "@/lib/events/form";
import { combineDateTime, eventSchema, fieldErrors, uuidSchema } from "@/lib/validation/schemas";
import { clubSchema, needPlayerAlertsSchema } from "@findmaxxing/shared/events";
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
  // 4.5a (pilotEvents): "Repeats every week" creates a series and its next 4 weeks of occurrences.
  if (featureEnabled("pilotEvents") && str(formData, "repeats") === "on") {
    const repeat = parseRepeatRule((k) => str(formData, k), (k) => strList(formData, k), { date: v.date, startTime: v.startTime, endTime: v.endTime ?? null });
    if (!repeat.ok) return fail("Check the highlighted fields", repeat.errors);
    const p = pilotInput(pilot.data, startsAt);
    try {
      const repo = await getRepository();
      const { seriesId, firstEventId } = await repo.series.create({
        title: v.title, description: v.description, categorySlug: v.categorySlug, placeId: v.placeId, locationName: v.locationName, address: v.address,
        lat: v.lat, lng: v.lng, timeZone: p.timeZone ?? "America/New_York", rule: repeat.rule, capacity: v.capacity, minAttendance: p.minAttendance ?? null,
        decisionLeadMinutes: pilot.data.decisionLeadMinutes ?? null, activityDetails: p.activityDetails ?? null, newcomer: p.newcomer ?? null,
        cardStyle: p.cardStyle, tags: v.tags,
      }, viewer.id);
      revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
      await track("create_event", { eventId: firstEventId ?? seriesId });
      redirect(firstEventId ? `/events/${firstEventId}?new=1` : "/events");
    } catch (err) {
      return toFailure(err);
    }
  }
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
  // 4.5a (pilotEvents): an occurrence of a series is edited as "this one" or "this and future".
  const scope = featureEnabled("pilotEvents") ? str(formData, "editScope") : "";
  if (scope === "this" || scope === "future") {
    try {
      const repo = await getRepository();
      const current = await repo.events.get(id.data, viewer.id);
      if (current?.seriesId) {
        if (scope === "this") {
          await repo.series.updateOccurrence(viewer.id, id.data, { title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags });
        } else {
          const days = strList(formData, "repeatDays").map(Number).filter((d) => d >= 1 && d <= 7);
          if (!days.length) return fail("Check the highlighted fields", { repeatDays: "Pick at least one day" });
          await repo.series.updateFrom(viewer.id, id.data, { title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng, weekdays: days, intervalWeeks: Number(str(formData, "repeatInterval")) || 1, startLocal: v.startTime, durationMinutes: durationMinutes(v.startTime, v.endTime ?? null), capacity: v.capacity });
        }
        revalidatePath(`/events/${id.data}`); revalidatePath("/events");
        redirect(`/events/${id.data}`);
      }
    } catch (err) { return toFailure(err); }
  }
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

/** 4.5a: a series host cancels one occurrence, or ends the series. */
export async function seriesHostAction(op: "cancel-occurrence" | "end-series", id: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!featureEnabled("pilotEvents")) return fail("Not available", undefined, "not_found");
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) return fail("Invalid request");
  try {
    const repo = await getRepository();
    if (op === "cancel-occurrence") await repo.series.cancelOccurrence(viewer.id, parsed.data);
    else await repo.series.end(viewer.id, parsed.data, new Date().toISOString().slice(0, 10));
    revalidatePath("/events");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

/** 4.5b: follow a series (updates only; never signs you up for a session). */
export async function followSeriesAction(seriesId: string, on: boolean): Promise<ActionResult<{ following: boolean }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to follow", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(seriesId);
  if (!id.success) return fail("Invalid series");
  try {
    const repo = await getRepository();
    await repo.series.follow(viewer.id, id.data, on);
    revalidatePath(`/series/${id.data}`);
    return succeed({ following: on });
  } catch (err) { return toFailure(err); }
}

/** 4.5b: the owner adds a backup host by username, or removes one. */
export async function setSeriesHostAction(seriesId: string, usernameOrId: string, on: boolean): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(seriesId);
  if (!id.success) return fail("Invalid series");
  try {
    const repo = await getRepository();
    const asId = uuidSchema.safeParse(usernameOrId);
    const target = asId.success ? asId.data : (await repo.profiles.getByUsername(usernameOrId.trim().replace(/^@/, "")))?.id;
    if (!target) return fail("No one with that username", { hostUsername: "No one with that username" });
    await repo.series.setHost(viewer.id, id.data, target, on);
    revalidatePath(`/series/${id.data}`);
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

/** 4.5b: a host records who came, after the session ended. */
export async function setAttendedAction(eventId: string, userId: string, attended: boolean): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  const ev = uuidSchema.safeParse(eventId);
  const who = uuidSchema.safeParse(userId);
  if (!ev.success || !who.success) return fail("Invalid request");
  try {
    const repo = await getRepository();
    await repo.series.setAttended(viewer.id, ev.data, who.data, attended);
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

/** R3: a series host starts a club around a series they host. */
export async function createClubAction(seriesId: string, name: string, description: string): Promise<ActionResult<{ id: string }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!featureEnabled("pilotEvents")) return fail("Not available", undefined, "not_found");
  const sid = uuidSchema.safeParse(seriesId);
  const parsed = clubSchema.safeParse({ name, description });
  if (!sid.success) return fail("Invalid series");
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    const id = await repo.clubs.create(viewer.id, { ...parsed.data, seriesIds: [sid.data] });
    revalidatePath(`/series/${sid.data}`);
    return succeed({ id });
  } catch (err) { return toFailure(err); }
}

/** R3: join or leave a club (never an RSVP), or the owner removes a member. */
export async function clubMemberAction(clubId: string, op: "join" | "leave" | "remove", userId?: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to join", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(clubId);
  if (!id.success) return fail("Invalid club");
  try {
    const repo = await getRepository();
    if (op === "remove") {
      const who = uuidSchema.safeParse(userId);
      if (!who.success) return fail("Invalid member");
      await repo.clubs.removeMember(viewer.id, id.data, who.data);
    } else await repo.clubs.join(viewer.id, id.data, op === "join");
    revalidatePath(`/clubs/${id.data}`);
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

/** R2 (pilotEvents): save the viewer's own need-players alert settings (area stored as a coarse cell). */
export async function saveNeedPlayerAlertsAction(input: { enabled: boolean; categories: string[]; cellLat: number; cellLng: number; radiusKm: number }): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!featureEnabled("pilotEvents")) return fail("Not available", undefined, "not_found");
  const parsed = needPlayerAlertsSchema.safeParse(input);
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  try {
    const repo = await getRepository();
    await repo.events.setNeedPlayerAlerts(viewer.id, parsed.data);
    revalidatePath("/events/alerts");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}
