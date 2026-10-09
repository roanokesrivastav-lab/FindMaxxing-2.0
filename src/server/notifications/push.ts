import "server-only";
import type { DataRepository } from "@/lib/data/repository";
import type { PushClaim, PushDevice } from "@/lib/data/types";
import { MAX_PUSHES_PER_DAY, notificationHref, notificationText } from "@/lib/notifications";
import { getSiteUrl } from "@/lib/config";

/** Sends one encrypted payload to one device. `gone` means the push service forgot the device. */
export interface PushSender {
  send(device: PushDevice, payload: string): Promise<{ ok: true } | { ok: false; gone: boolean }>;
}

/**
 * The mobile app's devices: Expo's push service. Needs no key (an access
 * token is optional, EXPO_ACCESS_TOKEN); `DeviceNotRegistered` means gone.
 */
export function expoPushSender(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): PushSender {
  return {
    async send(device, payload) {
      const { title, body, url } = JSON.parse(payload) as { title: string; body: string; url: string };
      try {
        const res = await fetcher("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...(env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}) },
          body: JSON.stringify({ to: device.endpoint, title, body, data: { url }, sound: "default" }),
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await res.json().catch(() => ({}))) as { data?: { status?: string; details?: { error?: string } } };
        if (res.ok && json.data?.status === "ok") return { ok: true };
        return { ok: false, gone: json.data?.details?.error === "DeviceNotRegistered" };
      } catch {
        return { ok: false, gone: false };
      }
    },
  };
}

/** Routes each device to its service: web push for browsers, Expo for the app. Null when neither can send. */
export function combinedSender(web: PushSender | null, expo: PushSender | null): PushSender | null {
  if (!web && !expo) return null;
  return {
    async send(device, payload) {
      const sender = device.kind === "expo" ? expo : web;
      return sender ? sender.send(device, payload) : { ok: false, gone: false };
    },
  };
}

/** web-push with the VAPID keys from the environment, or null when they are not set. */
export async function webPushSender(env: Record<string, string | undefined> = process.env): Promise<PushSender | null> {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const webpush = (await import("web-push")).default;
  const subject = env.VAPID_SUBJECT || getSiteUrl();
  return {
    async send(device, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh ?? "", auth: device.auth ?? "" } },
          payload,
          { vapidDetails: { subject, publicKey, privateKey }, TTL: 12 * 3600, timeout: 10_000 },
        );
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410 };
      }
    },
  };
}

/** What the service worker shows. No message text: it is never stored in a notification. */
export function pushPayload(c: PushClaim): string {
  const text = notificationText({ ...c, actorName: c.actorUsername ? `@${c.actorUsername}` : null });
  return JSON.stringify({ title: "FindMaxxing", body: text, url: notificationHref({ ...c, actorUsername: c.actorUsername }), tag: c.notificationId });
}

export interface PushRunResult {
  reminders: number;
  claimed: number;
  sent: number;
  failed: number;
  dropped: number;
}

/**
 * One scheduler run: create due reminders, then claim and send pending
 * pushes. Claims are marked sent in the database before anything goes out, so
 * a retry after a crash can miss a push but never sends one twice. Without a
 * sender (no VAPID keys), nothing is claimed: pushes wait in the queue.
 */
export async function runNotificationJobs(repo: DataRepository, sender: PushSender | null, now = new Date().toISOString()): Promise<PushRunResult> {
  const reminders = await repo.notifications.scheduleReminders(now);
  const result: PushRunResult = { reminders, claimed: 0, sent: 0, failed: 0, dropped: 0 };
  if (!sender) return result;
  const claims = await repo.notifications.claimPushes(now, 200);
  result.claimed = claims.length;
  for (const claim of claims) {
    const payload = pushPayload(claim);
    for (const device of claim.devices) {
      const res = await sender.send(device, payload);
      if (res.ok) result.sent += 1;
      else {
        result.failed += 1;
        if (res.gone) {
          await repo.notifications.dropDevice(device.endpoint);
          result.dropped += 1;
        }
      }
    }
  }
  return result;
}

export { MAX_PUSHES_PER_DAY };
