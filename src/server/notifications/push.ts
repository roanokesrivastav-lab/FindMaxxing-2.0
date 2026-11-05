import "server-only";
import type { DataRepository } from "@/lib/data/repository";
import type { PushClaim, PushDevice } from "@/lib/data/types";
import { MAX_PUSHES_PER_DAY, notificationHref, notificationText } from "@/lib/notifications";
import { featureEnabled, getSiteUrl } from "@/lib/config";
import { isWebPushEndpoint } from "@/lib/security/pushEndpoints";
import { webPushAgent } from "./pushAgent";

/** Sends one encrypted payload. `gone` means the subscription is no longer usable. */
export interface PushSender {
  /** Omitted only for legacy/test senders that can handle both transports. */
  supportedKinds?: ("web" | "expo")[];
  send(device: PushDevice, payload: string): Promise<{ ok: true } | { ok: false; gone: boolean }>;
}

/**
 * The mobile app's devices: Expo's push service. Needs no key (an access
 * token is optional, EXPO_ACCESS_TOKEN); `DeviceNotRegistered` means gone.
 */
export function expoPushSender(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): PushSender {
  return {
    supportedKinds: ["expo"],
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
    supportedKinds: [...(web ? ["web" as const] : []), ...(expo ? ["expo" as const] : [])],
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
    supportedKinds: ["web"],
    async send(device, payload) {
      // Recheck stored subscriptions too: old rows may predate registration rules.
      if (!isWebPushEndpoint(device.endpoint)) return { ok: false, gone: true };
      let agent: Awaited<ReturnType<typeof webPushAgent>> | undefined;
      try {
        agent = await webPushAgent(device.endpoint);
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh ?? "", auth: device.auth ?? "" } },
          payload,
          { vapidDetails: { subject, publicKey, privateKey }, TTL: 12 * 3600, timeout: 10_000, agent },
        );
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410 };
      } finally {
        agent?.destroy();
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
  /** 4.3 (pilotEvents): sessions called off at their decision deadline. */
  notHappening?: number;
  /** 4.4: waitlist offers that ran out (declined and passed on). */
  offersExpired?: number;
  /** 4.5a: series occurrences materialized this run. */
  occurrencesGenerated?: number;
  /** R2: need-players alerts sent this run. */
  needPlayers?: number;
  reminders: number;
  claimed: number;
  sent: number;
  failed: number;
  dropped: number;
}

/**
 * One scheduler run: create due reminders, then claim and send pending
 * pushes for ready transports. Each kind is claimed before sending, retaining
 * the existing at-most-once policy on send failures/crashes. Unready kinds are
 * not consumed; they stay pending until ready or normal notification expiry.
 */
export async function runNotificationJobs(repo: DataRepository, sender: PushSender | null, now = new Date().toISOString()): Promise<PushRunResult> {
  // 4.3 (pilotEvents): decide sessions at their deadline first, so the "not happening" notices go out
  // in this run's pushes.
  const notHappening = featureEnabled("pilotEvents") && typeof repo.events?.decideSessions === "function" ? await repo.events.decideSessions(now) : undefined;
  // 4.4: expired offers are declined and the seat is offered on (the expiry itself already stopped
  // holding at offer_expires_at; this tidies status and notifies). Runs whatever the flag: waitlists are data.
  const offersExpired = typeof repo.events?.expireOffers === "function" ? await repo.events.expireOffers(now) : undefined;
  // 4.5a: keep every active series materialized 4 weeks ahead (idempotent).
  const occurrencesGenerated = typeof repo.series?.generate === "function" ? await repo.series.generate(now) : undefined;
  // R2 (pilotEvents): opt-in need-players alerts, before this run's pushes are claimed.
  const needPlayers = featureEnabled("pilotEvents") && typeof repo.events?.sendNeedPlayerAlerts === "function" ? await repo.events.sendNeedPlayerAlerts(now) : undefined;
  const reminders = await repo.notifications.scheduleReminders(now);
  const result: PushRunResult = { ...(notHappening !== undefined ? { notHappening } : {}), ...(offersExpired !== undefined ? { offersExpired } : {}), ...(occurrencesGenerated !== undefined ? { occurrencesGenerated } : {}), ...(needPlayers !== undefined ? { needPlayers } : {}), reminders, claimed: 0, sent: 0, failed: 0, dropped: 0 };
  if (!sender) return result;
  const kinds = sender.supportedKinds ?? ["web", "expo"];
  if (!kinds.length) return result;
  const claims = await repo.notifications.claimPushes(now, 200, kinds);
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
