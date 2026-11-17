"use server";

import { track } from "@/server/analytics";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { activityDetailsSchema, activityFromFields, type ActivityDetails } from "@/lib/activity";
import type { NewSeriesInput, SeriesPatch, SessionRules } from "@/lib/data/types";
import { DEFAULT_TIME_ZONE, eventTimeZone } from "@/lib/utils/timezone";
import { seriesRuleSchema } from "@findmaxxing/shared/series";
import { combineDateTime, eventSchema, fieldErrors, uuidSchema } from "@/lib/validation/schemas";
import { fail, str, strList, succeed, toFailure, type ActionResult } from "./result";

/**
 * The 4.2 fields the event form adds. The zone is the one the times were typed
 * in (null when absent or unknown: the repository then keeps or defaults it).
 * Activity details are read only behind the pilotEvents flag: `undefined`
 * leaves what is stored alone, null clears it.
 */
function eventExtras(formData: FormData): { timeZone: string | null; activityDetails: ActivityDetails | null | undefined; errors: Record<string, string> | null } {
  const timeZone = eventTimeZone(str(formData, "timeZone"));
  if (!featureEnabled("pilotEvents") || !formData.has("activity.kind")) return { timeZone, activityDetails: undefined, errors: null };
  const raw = activityFromFields((name) => formData.get(name));
  if (!raw) return { timeZone, activityDetails: null, errors: null };
  const parsed = activityDetailsSchema.safeParse(raw);
  if (parsed.success) return { timeZone, activityDetails: parsed.data, errors: null };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[issue.path.length - 1] ?? "kind");
    errors[`activity.${field}`] ??= issue.message;
  }
  if (!Object.keys(errors).length) errors["activity.kind"] = "Check the activity details";
  return { timeZone, activityDetails: undefined, errors };
}

/**
 * The 4.3 session rules from the event form, behind pilotEvents. `undefined`
 * (flag off, or the fields were not on the form) leaves the stored rules alone.
 * The deadline is the start minus the chosen lead time.
 */
function sessionRulesFromForm(formData: FormData, startsAt: Date, capacity: number | null): { rules: SessionRules | undefined; errors: Record<string, string> | null } {
  if (!featureEnabled("pilotEvents") || !formData.has("sessionRules")) return { rules: undefined, errors: null };
  const errors: Record<string, string> = {};
  const minText = str(formData, "minAttendance").trim();
  const leadText = str(formData, "decisionLeadMinutes").trim();
  const min = minText === "" ? null : Number(minText);
  const lead = leadText === "" ? null : Number(leadText);
  if (min !== null && (!Number.isInteger(min) || min < 2 || min > 5000)) errors.minAttendance = "The minimum must be at least 2";
  else if (min !== null && capacity !== null && min > capacity) errors.minAttendance = "The minimum can't be more than the capacity";
  if (lead !== null && (!Number.isInteger(lead) || lead < 15 || lead > 7 * 24 * 60)) errors.decisionLeadMinutes = "Pick when you'll decide";
  else if (lead !== null && min === null) errors.decisionLeadMinutes = "Set a minimum first";
  if (Object.keys(errors).length) return { rules: undefined, errors };
  return {
    rules: {
      minAttendance: min,
      decisionDeadline: lead === null ? null : new Date(startsAt.getTime() - lead * 60_000).toISOString(),
      venueStatus: formData.get("venueUnconfirmed") === "on" ? "unconfirmed" : "confirmed",
    },
    errors: null,
  };
}

/**
 * The 4.5a repeat fields, behind pilotEvents. `rule` is null when the event is a one-off.
 * The weekdays are ISO (Monday 1), the start is the form's start time in the typed zone,
 * and the length comes from the end time (90 minutes when there is none).
 */
function repeatFromForm(formData: FormData, startTime: string, endTime: string | null, errors: Record<string, string>): { rule: NewSeriesInput["rule"] | null; until: string | null } {
  if (!featureEnabled("pilotEvents") || str(formData, "repeat") !== "weekly") return { rule: null, until: null };
  const weekdays = strList(formData, "weekday").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  const interval = Number(str(formData, "repeatInterval") || "1");
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let duration = endTime ? minutes(endTime) - minutes(startTime) : 90;
  if (duration <= 0) duration += 24 * 60;
  const rule = { freq: "weekly" as const, interval, weekdays: [...new Set(weekdays)].sort((a, b) => a - b), start_local: startTime, duration_minutes: duration };
  const parsed = seriesRuleSchema.safeParse(rule);
  if (!parsed.success) {
    if (!rule.weekdays.length) errors.weekday = "Pick at least one day";
    else if (rule.duration_minutes > 720) errors.endTime = "A repeating session can last up to 12 hours";
    else errors.repeat = "Check the repeat settings";
    return { rule: null, until: null };
  }
  const until = str(formData, "repeatUntil").trim();
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) errors.repeatUntil = "Pick an end date";
  return { rule: parsed.data, until: until || null };
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
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  const extras = eventExtras(formData);
  if (extras.errors) return fail("Check the highlighted fields", extras.errors);

  const v = parsed.data;
  const { startsAt, endsAt } = combineDateTime(v.date, v.startTime, v.endTime, v.tzOffsetMinutes);
  const session = sessionRulesFromForm(formData, startsAt, v.capacity);
  if (session.errors) return fail("Check the highlighted fields", session.errors);
  const repeatErrors: Record<string, string> = {};
  const repeat = repeatFromForm(formData, v.startTime, v.endTime, repeatErrors);
  if (Object.keys(repeatErrors).length) return fail("Check the highlighted fields", repeatErrors);
  try {
    const repo = await getRepository();
    if (repeat.rule) {
      // A series: the template, the rule, and the first four weeks of occurrences (0054).
      const lead = session.rules?.decisionDeadline ? Math.round((startsAt.getTime() - Date.parse(session.rules.decisionDeadline)) / 60_000) : null;
      const series = await repo.series.create({
        title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng,
        categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags, timeZone: extras.timeZone ?? DEFAULT_TIME_ZONE, rule: repeat.rule,
        startsOn: v.date, endsOn: repeat.until, minAttendance: session.rules?.minAttendance ?? null, decisionLeadMinutes: lead && lead > 0 ? lead : null,
        activityDetails: extras.activityDetails ?? null,
      }, viewer.id);
      const [first] = await repo.series.occurrences(series.id, viewer.id);
      revalidatePath("/");
      revalidatePath("/events");
      revalidatePath("/profile");
      await track("create_event", { eventId: first?.id ?? series.id });
      redirect(first ? `/events/${first.id}?new=1` : "/events");
    }
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
        timeZone: extras.timeZone,
        activityDetails: extras.activityDetails,
        sessionRules: session.rules,
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
  if (!parsed.success) return fail("Check the highlighted fields", fieldErrors(parsed.error));
  // The zone is set when the event is created and kept on edit.
  const extras = eventExtras(formData);
  if (extras.errors) return fail("Check the highlighted fields", extras.errors);
  const v = parsed.data;
  const { startsAt, endsAt } = combineDateTime(v.date, v.startTime, v.endTime, v.tzOffsetMinutes);
  const session = sessionRulesFromForm(formData, startsAt, v.capacity);
  if (session.errors) return fail("Check the highlighted fields", session.errors);
  try {
    const repo = await getRepository();
    const applyTo = featureEnabled("pilotEvents") ? str(formData, "applyTo") : "";
    if (applyTo === "this" || applyTo === "future") {
      // A series occurrence (0054). "This" records the changed fields as overrides; "future" changes the
      // template from this date on and, when the time changed, the rule.
      const current = await repo.events.get(id.data, viewer.id);
      if (!current?.series) return fail("That session isn't part of a series", undefined, "invalid");
      const lead = session.rules?.decisionDeadline ? Math.round((startsAt.getTime() - Date.parse(session.rules.decisionDeadline)) / 60_000) : null;
      if (applyTo === "future") {
        const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        let duration = v.endTime ? minutes(v.endTime) - minutes(v.startTime) : current.series.rule.duration_minutes;
        if (duration <= 0) duration += 24 * 60;
        const rule = { ...current.series.rule, start_local: v.startTime, duration_minutes: Math.min(720, Math.max(15, duration)) };
        const patch: SeriesPatch = {
          title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng,
          categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags,
          ...(extras.activityDetails !== undefined ? { activityDetails: extras.activityDetails } : {}),
          ...(session.rules ? { minAttendance: session.rules.minAttendance, decisionLeadMinutes: lead && lead > 0 ? lead : null } : {}),
          ...(JSON.stringify(rule) !== JSON.stringify(current.series.rule) ? { rule } : {}),
        };
        await repo.series.updateFrom(viewer.id, id.data, patch);
      } else {
        await repo.series.updateOccurrence(viewer.id, id.data, {
          title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng,
          categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null,
          ...(extras.activityDetails !== undefined ? { activityDetails: extras.activityDetails } : {}),
          ...(session.rules ? { minAttendance: session.rules.minAttendance, decisionDeadline: session.rules.decisionDeadline, venueStatus: session.rules.venueStatus } : {}),
        });
      }
      revalidatePath(`/events/${id.data}`); revalidatePath(`/events/${id.data}/edit`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
      redirect(`/events/${id.data}`);
    }
    const event = await repo.events.update(id.data, { title: v.title, description: v.description, placeId: v.placeId, locationName: v.locationName, address: v.address, lat: v.lat, lng: v.lng, startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, categorySlug: v.categorySlug, capacity: v.capacity, tags: v.tags, activityDetails: extras.activityDetails, sessionRules: session.rules }, viewer.id);
    revalidatePath(`/events/${id.data}`); revalidatePath(`/events/${id.data}/edit`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
    redirect(`/events/${event.id}`);
  } catch (err) { return toFailure(err); }
}

/** Host of a series: cancels this session only (roadmap 4.5a). The date is never recreated. */
export async function cancelOccurrenceAction(eventId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to manage your event", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  if (!featureEnabled("pilotEvents")) return fail("Not available yet", undefined, "forbidden");
  try {
    const repo = await getRepository();
    await repo.series.cancelOccurrence(viewer.id, id.data);
    if (paymentsMode() === "demo") for (const t of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(t.paymentIntentId);
    revalidatePath(`/events/${id.data}`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
    return succeed(undefined);
  } catch (err) { return toFailure(err); }
}

/** Owner of a series: ends it today; later sessions are cancelled and everyone going is told. */
export async function endSeriesAction(seriesId: string, eventId: string): Promise<ActionResult<{ cancelled: number }>> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to manage your series", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(seriesId);
  const ev = uuidSchema.safeParse(eventId);
  if (!id.success || !ev.success) return fail("Invalid series");
  if (!featureEnabled("pilotEvents")) return fail("Not available yet", undefined, "forbidden");
  try {
    const repo = await getRepository();
    const cancelled = await repo.series.end(viewer.id, id.data, null);
    if (paymentsMode() === "demo") for (const t of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(t.paymentIntentId);
    revalidatePath(`/events/${ev.data}`); revalidatePath("/"); revalidatePath("/events"); revalidatePath("/profile");
    return succeed({ cancelled });
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

/** Host: confirms the session is on (roadmap 4.3). */
export async function confirmSessionAction(eventId: string): Promise<ActionResult> {
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in to manage your event", undefined, "unauthenticated");
  const id = uuidSchema.safeParse(eventId);
  if (!id.success) return fail("Invalid event");
  if (!featureEnabled("pilotEvents")) return fail("Not available yet", undefined, "forbidden");
  try {
    const repo = await getRepository();
    await repo.events.confirmSession(viewer.id, id.data);
    revalidatePath(`/events/${id.data}`); revalidatePath("/events");
    return succeed(undefined);
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
