/**
 * Notification types, defaults and wording, shared by the server (push
 * payloads), the pages and both repositories. Client-safe.
 */
import type { AppNotification, NotificationSettings, NotificationType } from "./types";

/** At most this many pushes per person in any 24 hours; the rest stay in-app. */
export const MAX_PUSHES_PER_DAY = 5;
/** Pushes older than this are not sent late. */
export const PUSH_MAX_AGE_HOURS = 24;

export const NOTIFICATION_TYPES: { type: NotificationType; label: string }[] = [
  { type: "new_message", label: "New messages" },
  { type: "new_follower", label: "New followers" },
  { type: "event_joined", label: "Someone joins your event" },
  { type: "event_tomorrow", label: "An event you're going to is tomorrow" },
  { type: "event_soon", label: "An event you're going to starts soon" },
  { type: "event_changed", label: "An event you're going to changes" },
  { type: "event_cancelled", label: "An event you're going to is cancelled" },
  { type: "place_saved", label: "Your places are saved" },
  { type: "place_rated", label: "Your places are rated" },
  { type: "report_resolved", label: "Your reports are reviewed" },
  { type: "content_moderated", label: "Moderators act on your content" },
  { type: "trip_plan_ready", label: "A trip plan is ready" },
  { type: "event_offer", label: "A spot opens up for you on a waitlist" },
  { type: "event_offer_expired", label: "A spot offer runs out" },
  { type: "event_not_happening", label: "A session is called off for too few people" },
  { type: "series_update", label: "A series you follow changes" },
];
export const ALL_NOTIFICATION_TYPES = NOTIFICATION_TYPES.map((t) => t.type);

/** As the notification_settings column defaults: everything but saves and ratings is pushed. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  mutedTypes: [],
  pushTypes: ALL_NOTIFICATION_TYPES.filter((t) => t !== "place_saved" && t !== "place_rated"),
  quietStart: null,
  quietEnd: null,
  timeZone: "America/New_York",
};

type Describable = Pick<AppNotification, "type" | "label" | "detail" | "count" | "subjectType" | "subjectId"> & { actorName: string | null };

const others = (n: number, one: string, many: string) => (n <= 1 ? one : many.replace("{n}", String(n)));

/** One line of text. Never includes message text (it is never stored). */
export function notificationText(n: Describable): string {
  const who = n.actorName ?? "Someone";
  const label = n.label ?? "";
  const plus = n.count > 1 ? ` and ${n.count - 1} other${n.count === 2 ? "" : "s"}` : "";
  switch (n.type) {
    case "new_follower":
      return `${who} followed you`;
    case "event_joined":
      return `${who}${plus} joined ${label || "your event"}`;
    case "event_tomorrow":
      return `${label || "An event you're going to"} is tomorrow`;
    case "event_soon":
      return `${label || "An event you're going to"} starts within the hour`;
    case "event_changed":
      return `${label || "An event you're going to"} changed time or place`;
    case "event_cancelled":
      return `${label || "An event you're going to"} was cancelled`;
    case "new_message":
      return label
        ? others(n.count, `New message in ${label}`, `{n} new messages in ${label}`)
        : others(n.count, `${who} sent you a message`, `{n} new messages from ${who}`);
    case "place_saved":
      return others(n.count, `Someone saved ${label || "your place"}`, `{n} people saved ${label || "your place"}`);
    case "place_rated":
      return `${who}${plus} rated ${label || "your place"}`;
    case "report_resolved":
      return n.detail === "dismissed" ? "A moderator reviewed your report and left the content up" : "A moderator reviewed your report";
    case "content_moderated":
      return n.detail === "restore"
        ? `Moderators restored ${label || "your content"}`
        : `Moderators removed ${label || (n.subjectType === "message" ? "one of your messages" : "your content")}`;
    case "trip_plan_ready":
      return `Your plan "${label || "Plan my day"}" is ready`;
    case "event_offer":
      return `A spot opened up at ${label || "an event you're waiting for"}. Accept it before it runs out`;
    case "event_offer_expired":
      return `Your spot offer for ${label || "an event"} ran out`;
    case "event_not_happening":
      return `${label || "A session you signed up for"} isn't happening: not enough people signed up`;
    case "series_update":
      return `${label || "A series you follow"}: ${n.detail ? n.detail.charAt(0).toLowerCase() + n.detail.slice(1) : "something changed"}`;
  }
}

/** Where a notification leads. */
export function notificationHref(n: Pick<AppNotification, "type" | "subjectType" | "subjectId"> & { actorUsername: string | null }): string {
  switch (n.subjectType) {
    case "event":
      return n.subjectId ? `/events/${n.subjectId}` : "/events";
    case "place":
      return n.subjectId ? `/places/${n.subjectId}` : "/";
    case "conversation":
      return n.subjectId ? `/messages/${n.subjectId}` : "/messages";
    case "profile":
      return n.actorUsername ? `/u/${n.actorUsername}` : "/people";
    case "report":
      return "/profile/reports";
    case "plan":
      return "/plan";
    case "series":
      return n.subjectId ? `/series/${n.subjectId}` : "/events";
    default:
      return "/profile";
  }
}
