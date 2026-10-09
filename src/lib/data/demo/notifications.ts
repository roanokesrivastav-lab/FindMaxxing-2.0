/**
 * Demo-mode notifications. Mirrors 0021_notifications.sql: notify() with its
 * batching, dedupe, blocking and preference rules; the trigger hooks the demo
 * repository calls where the database has triggers; and the scheduled work
 * (reminders, push claims, retention).
 */
import type { DataRepository } from "../repository";
import { DataError, EXPO_PUSH_TOKEN, type AppNotification, type NotificationSettings, type NotificationType, type PushClaim } from "../types";
import { clampLimit, compareTimestamps, decodeCursor, toPage } from "../discovery";
import { ALL_NOTIFICATION_TYPES, DEFAULT_NOTIFICATION_SETTINGS } from "@/lib/notifications";
import { newId } from "@/lib/utils/ids";
import { hasBlocked } from "./messaging";
import type { DemoState, NotificationRow } from "./store";

const HOUR = 3600_000;
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Timestamps strictly after the previous one, like clock_timestamp(): two
 * notifications written in the same millisecond still have an order.
 */
let lastStamp = 0;
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

export function settingsOf(state: DemoState, userId: string): NotificationSettings | null {
  const row = state.notificationSettings.find((s) => s.userId === userId);
  return row ? { mutedTypes: row.mutedTypes, pushTypes: row.pushTypes, quietStart: row.quietStart, quietEnd: row.quietEnd, timeZone: row.timeZone } : null;
}

interface NotifyInput {
  type: NotificationType;
  actorId: string | null;
  subjectType: AppNotification["subjectType"];
  subjectId: string | null;
  label: string | null;
  batchKey?: string | null;
  dedupeKey?: string | null;
  detail?: string | null;
}

/** Mirrors public.notify(). */
export function notifyDemo(state: DemoState, userId: string | null, n: NotifyInput) {
  if (!userId || userId === n.actorId) return;
  if (n.actorId && hasBlocked(state, userId, n.actorId)) return;
  if (!state.profiles.some((p) => p.id === userId)) return;
  const s = settingsOf(state, userId);
  if (s?.mutedTypes.includes(n.type)) return;
  const pushState = (s ? s.pushTypes.includes(n.type) : DEFAULT_NOTIFICATION_SETTINGS.pushTypes.includes(n.type)) ? "pending" : "none";
  const label = n.label ? n.label.slice(0, 140) : null;
  if (n.batchKey) {
    const open = state.notifications.find((x) => x.userId === userId && x.batchKey === n.batchKey && !x.readAt);
    if (open) {
      open.count += 1;
      open.actorId = n.actorId;
      open.label = label;
      open.updatedAt = stamp();
      return;
    }
  } else if (n.dedupeKey && state.notifications.some((x) => x.userId === userId && x.dedupeKey === n.dedupeKey)) {
    return;
  }
  const now = stamp();
  state.notifications.push({
    id: newId(), userId, type: n.type, actorId: n.actorId, subjectType: n.subjectType, subjectId: n.subjectId, label,
    detail: n.detail ?? null, count: 1, batchKey: n.batchKey ?? null, dedupeKey: n.batchKey ? null : (n.dedupeKey ?? null),
    pushState, createdAt: now, updatedAt: now, readAt: null,
  });
}

/** Hooks for the writes the database has notification triggers on. */
export const notifyOn = {
  follow(state: DemoState, followerId: string, followingId: string) {
    notifyDemo(state, followingId, { type: "new_follower", actorId: followerId, subjectType: "profile", subjectId: followerId, label: null, dedupeKey: `follow:${followerId}` });
  },
  join(state: DemoState, eventId: string, userId: string) {
    const e = state.events.find((x) => x.id === eventId);
    if (e) notifyDemo(state, e.creatorId, { type: "event_joined", actorId: userId, subjectType: "event", subjectId: e.id, label: e.title, batchKey: `event_joined:${e.id}` });
  },
  eventChanged(state: DemoState, eventId: string, actorId: string) {
    const e = state.events.find((x) => x.id === eventId);
    if (!e) return;
    for (const a of state.eventAttendees.filter((x) => x.eventId === eventId)) {
      notifyDemo(state, a.userId, { type: "event_changed", actorId, subjectType: "event", subjectId: e.id, label: e.title, batchKey: `event_changed:${e.id}` });
    }
  },
  eventCancelled(state: DemoState, eventId: string, actorId: string) {
    const e = state.events.find((x) => x.id === eventId);
    if (!e) return;
    for (const a of state.eventAttendees.filter((x) => x.eventId === eventId)) {
      notifyDemo(state, a.userId, { type: "event_cancelled", actorId, subjectType: "event", subjectId: e.id, label: e.title, dedupeKey: `event_cancelled:${e.id}` });
    }
  },
  message(state: DemoState, conversationId: string, senderId: string) {
    const c = state.conversations.find((x) => x.id === conversationId);
    if (!c) return;
    const title = c.eventId ? (state.events.find((e) => e.id === c.eventId)?.title ?? null) : null;
    for (const m of state.conversationMembers.filter((x) => x.conversationId === c.id && x.userId !== senderId)) {
      notifyDemo(state, m.userId, { type: "new_message", actorId: senderId, subjectType: "conversation", subjectId: c.id, label: title, batchKey: `message:${c.id}` });
    }
  },
  save(state: DemoState, placeId: string, userId: string) {
    const p = state.places.find((x) => x.id === placeId);
    if (!p || !p.creatorId || p.creatorId === userId) return;
    notifyDemo(state, p.creatorId, { type: "place_saved", actorId: null, subjectType: "place", subjectId: p.id, label: p.name, batchKey: `place_saved:${p.id}` });
  },
  rate(state: DemoState, placeId: string, userId: string) {
    const p = state.places.find((x) => x.id === placeId);
    if (p) notifyDemo(state, p.creatorId, { type: "place_rated", actorId: userId, subjectType: "place", subjectId: p.id, label: p.name, batchKey: `place_rated:${p.id}` });
  },
  reportResolved(state: DemoState, reportId: string, reporterId: string | null, status: string) {
    notifyDemo(state, reporterId, { type: "report_resolved", actorId: null, subjectType: "report", subjectId: reportId, label: null, dedupeKey: `report:${reportId}`, detail: status });
  },
  moderated(state: DemoState, targetType: string, targetId: string, action: string) {
    if (action !== "remove" && action !== "restore") return;
    let owner: string | null = null;
    let label: string | null = null;
    if (targetType === "place") {
      const p = state.places.find((x) => x.id === targetId);
      [owner, label] = [p?.creatorId ?? null, p?.name ?? null];
    } else if (targetType === "event") {
      const e = state.events.find((x) => x.id === targetId);
      [owner, label] = [e?.creatorId ?? null, e?.title ?? null];
    } else if (targetType === "message") {
      owner = state.messages.find((x) => x.id === targetId)?.senderId ?? null;
    } else return;
    notifyDemo(state, owner, { type: "content_moderated", actorId: null, subjectType: targetType as AppNotification["subjectType"], subjectId: targetId, label, detail: action });
  },
  /** Reading a conversation reads its message notification (mark_read). */
  conversationRead(state: DemoState, userId: string, conversationId: string) {
    const now = new Date().toISOString();
    for (const n of state.notifications) if (n.userId === userId && n.batchKey === `message:${conversationId}` && !n.readAt) n.readAt = now;
  },
};

/** Mirrors schedule_event_reminders(). */
export function scheduleDemoReminders(state: DemoState, now: string): number {
  const at = Date.parse(now);
  const before = state.notifications.filter((n) => n.type === "event_tomorrow" || n.type === "event_soon").length;
  for (const e of state.events) {
    const starts = Date.parse(e.startsAt);
    if (e.status !== "published" || starts <= at || starts > at + 24 * HOUR) continue;
    for (const a of state.eventAttendees.filter((x) => x.eventId === e.id)) {
      if (starts <= at + HOUR) notifyDemo(state, a.userId, { type: "event_soon", actorId: null, subjectType: "event", subjectId: e.id, label: e.title, dedupeKey: `event_soon:${e.id}` });
      else if (starts > at + 2 * HOUR) notifyDemo(state, a.userId, { type: "event_tomorrow", actorId: null, subjectType: "event", subjectId: e.id, label: e.title, dedupeKey: `event_tomorrow:${e.id}` });
    }
  }
  return state.notifications.filter((n) => n.type === "event_tomorrow" || n.type === "event_soon").length - before;
}

/** The local hour in a time zone, for quiet hours. */
function localHour(now: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(now)));
}

export function inQuietHours(s: NotificationSettings | null, now: string): boolean {
  if (!s || s.quietStart === null || s.quietEnd === null) return false;
  const h = localHour(now, s.timeZone);
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : s.quietStart > s.quietEnd && (h >= s.quietStart || h < s.quietEnd);
}

/** Mirrors claim_push_batch(). */
export function claimDemoPushes(state: DemoState, now: string, limit = 100, dailyCap = 5): PushClaim[] {
  const at = Date.parse(now);
  const pending = state.notifications
    .filter((n) => n.pushState === "pending")
    .sort((a, b) => compareTimestamps(a.createdAt, b.createdAt) || compareIds(a.id, b.id))
    .slice(0, Math.min(Math.max(limit, 1), 1000));
  const out: PushClaim[] = [];
  for (const n of pending) {
    const s = settingsOf(state, n.userId);
    const devices = state.pushSubscriptions
      .filter((d) => d.userId === n.userId)
      .sort((a, b) => compareTimestamps(a.createdAt, b.createdAt) || compareIds(a.id, b.id))
      .map((d) => ({ kind: d.kind ?? "web", endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }));
    if ((s && !s.pushTypes.includes(n.type)) || !devices.length || Date.parse(n.createdAt) < at - 24 * HOUR) {
      n.pushState = "skipped";
      continue;
    }
    if (inQuietHours(s, now)) continue;
    if (state.pushLog.filter((l) => l.userId === n.userId && Date.parse(l.sentAt) > at - 24 * HOUR).length >= dailyCap) {
      n.pushState = "capped";
      continue;
    }
    n.pushState = "sent";
    state.pushLog.push({ userId: n.userId, notificationId: n.id, sentAt: now });
    out.push({
      notificationId: n.id, userId: n.userId, type: n.type, actorUsername: n.actorId ? (state.profiles.find((p) => p.id === n.actorId)?.username ?? null) : null,
      subjectType: n.subjectType, subjectId: n.subjectId, label: n.label, detail: n.detail, count: n.count, devices,
    });
  }
  return out;
}

/** Mirrors purge_notifications(). */
export function purgeDemoNotifications(state: DemoState, now: string): number {
  const at = Date.parse(now);
  const before = state.notifications.length;
  state.notifications = state.notifications.filter((n) => !((n.readAt && Date.parse(n.updatedAt) < at - 90 * 24 * HOUR) || Date.parse(n.updatedAt) < at - 180 * 24 * HOUR));
  state.pushLog = state.pushLog.filter((l) => Date.parse(l.sentAt) >= at - 2 * 24 * HOUR);
  return before - state.notifications.length;
}

const TIME_ZONE_OK = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length <= 64;
  } catch {
    return false;
  }
};

export function validateSettings(s: NotificationSettings): NotificationSettings {
  const known = new Set<string>(ALL_NOTIFICATION_TYPES);
  if (![...s.mutedTypes, ...s.pushTypes].every((t) => known.has(t))) throw new DataError("Unknown notification type", "invalid");
  const hour = (h: number | null) => h === null || (Number.isInteger(h) && h >= 0 && h <= 23);
  if (!hour(s.quietStart) || !hour(s.quietEnd) || (s.quietStart === null) !== (s.quietEnd === null)) throw new DataError("Choose both quiet-hours times, or neither", "invalid");
  if (!TIME_ZONE_OK(s.timeZone)) throw new DataError("Unknown time zone", "invalid");
  return { mutedTypes: [...new Set(s.mutedTypes)], pushTypes: [...new Set(s.pushTypes)], quietStart: s.quietStart, quietEnd: s.quietEnd, timeZone: s.timeZone };
}

export function createDemoNotifications(state: DemoState, h: { persist(): void; summary(id: string | null): AppNotification["actor"] }): DataRepository["notifications"] {
  const toNotification = (n: NotificationRow): AppNotification => ({
    id: n.id, type: n.type, actor: h.summary(n.actorId), subjectType: n.subjectType, subjectId: n.subjectId, label: n.label, detail: n.detail,
    count: n.count, createdAt: n.createdAt, updatedAt: n.updatedAt, readAt: n.readAt,
  });
  return {
    async list(userId, opts = {}) {
      const limit = clampLimit(opts.limit, 30, 100);
      const before = decodeCursor(opts.cursor);
      const rows = state.notifications
        .filter((n) => n.userId === userId)
        .filter((n) => !before || compareTimestamps(n.updatedAt, before.key) < 0 || (compareTimestamps(n.updatedAt, before.key) === 0 && n.id < before.id))
        .sort((a, b) => compareTimestamps(b.updatedAt, a.updatedAt) || compareIds(b.id, a.id))
        .slice(0, limit + 1);
      return toPage(rows, limit, toNotification, (n) => ({ key: n.updatedAt, id: n.id }));
    },
    async unreadCount(userId) {
      return state.notifications.filter((n) => n.userId === userId && !n.readAt).length;
    },
    async markRead(userId, ids = null) {
      const now = new Date().toISOString();
      let changed = 0;
      for (const n of state.notifications) {
        if (n.userId === userId && !n.readAt && (!ids || ids.includes(n.id))) {
          n.readAt = now;
          changed += 1;
        }
      }
      if (changed) h.persist();
      return changed;
    },
    async settings(userId) {
      return settingsOf(state, userId) ?? { ...DEFAULT_NOTIFICATION_SETTINGS };
    },
    async updateSettings(userId, input) {
      const s = validateSettings(input);
      const row = state.notificationSettings.find((x) => x.userId === userId);
      const updatedAt = new Date().toISOString();
      if (row) Object.assign(row, s, { updatedAt });
      else state.notificationSettings.push({ userId, ...s, updatedAt });
      h.persist();
    },
    async addDevice(userId, device) {
      const kind = device.kind ?? "web";
      const ok = kind === "expo"
        ? EXPO_PUSH_TOKEN.test(device.endpoint)
        : /^https:\/\//.test(device.endpoint) && device.endpoint.length <= 1000 && !!device.p256dh && device.p256dh.length <= 200 && !!device.auth && device.auth.length <= 100;
      if (!ok) throw new DataError("Invalid push subscription", "invalid");
      state.pushSubscriptions = state.pushSubscriptions.filter((d) => d.endpoint !== device.endpoint);
      const mine = state.pushSubscriptions.filter((d) => d.userId === userId).sort((a, b) => compareTimestamps(a.createdAt, b.createdAt) || compareIds(a.id, b.id));
      if (mine.length >= 10) state.pushSubscriptions = state.pushSubscriptions.filter((d) => d.id !== mine[0].id);
      state.pushSubscriptions.push({ id: newId(), userId, kind, endpoint: device.endpoint, p256dh: kind === "expo" ? null : device.p256dh, auth: kind === "expo" ? null : device.auth, createdAt: stamp() });
      h.persist();
    },
    async removeDevice(userId, endpoint) {
      state.pushSubscriptions = state.pushSubscriptions.filter((d) => !(d.userId === userId && d.endpoint === endpoint));
      h.persist();
    },
    async deviceCount(userId) {
      return state.pushSubscriptions.filter((d) => d.userId === userId).length;
    },
    async tripPlanReady(userId, title) {
      notifyDemo(state, userId, { type: "trip_plan_ready", actorId: null, subjectType: "plan", subjectId: null, label: title.trim(), batchKey: "trip_plan" });
      h.persist();
    },
    async scheduleReminders(now) {
      const n = scheduleDemoReminders(state, now);
      if (n) h.persist();
      return n;
    },
    async claimPushes(now, limit) {
      const out = claimDemoPushes(state, now, limit);
      h.persist();
      return out;
    },
    async dropDevice(endpoint) {
      state.pushSubscriptions = state.pushSubscriptions.filter((d) => d.endpoint !== endpoint);
      h.persist();
    },
    async purge(now) {
      const n = purgeDemoNotifications(state, now);
      h.persist();
      return n;
    },
  };
}
