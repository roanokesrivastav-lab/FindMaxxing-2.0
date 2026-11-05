/**
 * Roadmap 4.3: the Readiness row. `computeReadiness` mirrors public.event_readiness() (used by the demo
 * store; tests hold the two to the same vectors). `readinessParts` turns it into the row's text, each
 * number from its own field, and says nothing about a field that is not set.
 */
import type { EventReadiness, SessionDecision, VenueStatus } from "@findmaxxing/shared/events";
import { calendarDayDiff, zonedFormatter } from "@/lib/utils/timezone";

export function computeReadiness(f: {
  going: number;
  held: number;
  capacity: number | null;
  minAttendance: number | null;
  decisionDeadline: string | null;
  decision: SessionDecision;
  venueStatus: VenueStatus;
  waitlist?: number;
}): EventReadiness {
  return {
    going: f.going,
    capacity: f.capacity,
    held: f.held,
    spotsOpen: f.capacity === null ? null : Math.max(0, f.capacity - f.going - f.held),
    minAttendance: f.minAttendance,
    moreNeeded: f.minAttendance === null ? null : Math.max(0, f.minAttendance - f.going),
    decisionDeadline: f.decisionDeadline,
    decision: f.decision,
    venueStatus: f.venueStatus,
    waitlist: f.waitlist ?? 0,
  };
}

/** "4 p.m.", "4:30 p.m.", with the weekday when it is not today (in the event's zone). */
export function deadlineText(iso: string, timeZone: string, now: number): string {
  const parts = zonedFormatter(timeZone, { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().startsWith("a") ? "a.m." : "p.m.";
  const clock = `${hour}${minute === "00" ? "" : `:${minute}`} ${period}`;
  const diff = calendarDayDiff(now, Date.parse(iso), timeZone);
  if (diff === 0) return clock;
  if (diff === 1) return `tomorrow ${clock}`;
  return `${zonedFormatter(timeZone, { weekday: "short" }).format(new Date(iso))} ${clock}`;
}

export type ReadinessTone = "positive" | "negative" | "neutral" | "warning";
export interface ReadinessPart { text: string; tone?: ReadinessTone }

/** The Readiness row, e.g. "8 going · 4 spots open · 2 more needed · host confirms by 4 p.m.". */
export function readinessParts(r: EventReadiness, timeZone: string, now: number, cancelled = false): ReadinessPart[] {
  const out: ReadinessPart[] = [{ text: `${r.going} going` }];
  if (cancelled) return out;
  if (r.spotsOpen !== null) out.push(r.spotsOpen > 0 ? { text: `${r.spotsOpen} spot${r.spotsOpen === 1 ? "" : "s"} open` } : { text: "Full", tone: "warning" });
  if (r.decision === "happening") out.push({ text: "Confirmed", tone: "positive" });
  else if (r.decision === "not_happening") out.push({ text: "Not happening", tone: "negative" });
  else {
    if (r.moreNeeded !== null) out.push(r.moreNeeded > 0 ? { text: `${r.moreNeeded} more needed` } : { text: "Minimum met", tone: "positive" });
    if (r.decisionDeadline) out.push({ text: `host confirms by ${deadlineText(r.decisionDeadline, timeZone, now)}` });
  }
  if (r.waitlist > 0) out.push({ text: `${r.waitlist} on the waitlist` });
  if (r.venueStatus === "unconfirmed") out.push({ text: "Venue not confirmed yet", tone: "warning" });
  return out;
}
