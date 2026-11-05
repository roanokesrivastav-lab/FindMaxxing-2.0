"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, pushTransportReady } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { ALL_NOTIFICATION_TYPES } from "@/lib/notifications";
import type { NotificationType } from "@/lib/data/types";
import { isWebPushEndpoint } from "@/lib/security/pushEndpoints";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const types = z.array(z.enum(ALL_NOTIFICATION_TYPES as [NotificationType, ...NotificationType[]])).max(ALL_NOTIFICATION_TYPES.length);
const hour = z.number().int().min(0).max(23).nullable();
const settingsSchema = z
  .object({ mutedTypes: types, pushTypes: types, quietStart: hour, quietEnd: hour, timeZone: z.string().min(1).max(64) })
  .refine((s) => (s.quietStart === null) === (s.quietEnd === null), { message: "Choose both quiet-hours times, or neither", path: ["quietEnd"] });
const deviceSchema = z.object({
  endpoint: z.string().refine(isWebPushEndpoint),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

async function notificationsViewer() {
  if (!featureEnabled("notifications")) return { error: fail("Notifications are not available", undefined, "unavailable") };
  const viewer = await getViewer();
  if (!viewer) return { error: fail("Sign in first", undefined, "unauthenticated") };
  return { viewer };
}

/** Marks the given notifications (or every one) read. */
export async function markNotificationsReadAction(ids: string[] | null = null): Promise<ActionResult<{ changed: number }>> {
  const { viewer, error } = await notificationsViewer();
  if (error) return error;
  const parsed = z.array(z.string().uuid()).max(100).nullable().safeParse(ids);
  if (!parsed.success) return fail("Nothing to mark");
  try {
    const changed = await (await getRepository()).notifications.markRead(viewer.id, parsed.data);
    revalidatePath("/", "layout");
    return succeed({ changed });
  } catch (err) {
    return toFailure(err);
  }
}

export async function saveNotificationSettingsAction(input: unknown): Promise<ActionResult> {
  const { viewer, error } = await notificationsViewer();
  if (error) return error;
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check your settings");
  try {
    await (await getRepository()).notifications.updateSettings(viewer.id, parsed.data);
    revalidatePath("/profile/settings");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

/** This device opts in to push (the browser's PushSubscription, as JSON). Needs the push flag and VAPID keys. */
export async function savePushDeviceAction(subscription: unknown): Promise<ActionResult> {
  const { viewer, error } = await notificationsViewer();
  if (error) return error;
  if (!pushTransportReady("web")) return fail("Push notifications are not set up", undefined, "unavailable");
  const parsed = deviceSchema.safeParse(subscription);
  if (!parsed.success) return fail("This browser gave an invalid push subscription");
  try {
    await (await getRepository()).notifications.addDevice(viewer.id, { endpoint: parsed.data.endpoint, ...parsed.data.keys });
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

export async function removePushDeviceAction(endpoint: string): Promise<ActionResult> {
  const { viewer, error } = await notificationsViewer();
  if (error) return error;
  if (typeof endpoint !== "string" || endpoint.length > 1000) return fail("Unknown device");
  try {
    await (await getRepository()).notifications.removeDevice(viewer.id, endpoint);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
