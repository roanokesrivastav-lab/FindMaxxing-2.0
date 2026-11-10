/**
 * The Readiness row (roadmap 4.3, founder decision: the default event card).
 * It reads like "8 going · 4 spots open · 2 more needed · host confirms by
 * 4 p.m.". Every part comes from its own field, and a part whose field is
 * missing is left out: the row never fills a gap with a guess. Client-safe.
 */
import type { EventReadiness } from "./types";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const offsetLabel = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";

/**
 * "4 p.m.", "4:30 p.m.", or with a weekday when the deadline is on another
 * local day than `now`. The time is in the event's zone (4.0 §5). When the
 * viewer's clock differs from it at that moment, the zone is named ("4 p.m.
 * EST"), so the time cannot be misread as the viewer's own.
 */
export function formatConfirmBy(deadline: string, timeZone: string, now: number, viewerTimeZone?: string): string {
  const at = new Date(deadline);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}${get("minute") === "00" ? "" : `:${get("minute")}`} ${get("dayPeriod").toLowerCase() === "am" ? "a.m." : "p.m."}`;
  const day = (d: Date | number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const zone = viewerTimeZone && offsetLabel(at, viewerTimeZone) !== offsetLabel(at, timeZone)
    ? ` ${new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? timeZone}`
    : "";
  if (day(at) === day(now)) return `${time}${zone}`;
  return `${new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at)} ${time}${zone}`;
}

export interface ReadinessInput extends Partial<EventReadiness> {
  going: number;
}

export interface ReadinessOptions {
  now: number;
  cancelled?: boolean;
  ended?: boolean;
  /** The zone the rest of the screen shows times in; names the event's zone when they differ. */
  viewerTimeZone?: string;
}

/**
 * The parts of the row, in order. `cancelled` and `ended` come from the event
 * itself; a cancelled or ended event says only what is still true.
 */
export function readinessParts(r: ReadinessInput, opts: ReadinessOptions): string[] {
  const out = [`${r.going} going`];
  if (opts.cancelled || r.decision === "not_happening") {
    out.push("Not happening");
    return out;
  }
  if (opts.ended) return out;
  if (r.capacity !== null && r.capacity !== undefined && r.spotsOpen !== null && r.spotsOpen !== undefined) {
    out.push(r.spotsOpen > 0 ? plural(r.spotsOpen, "spot open", "spots open") : "Full");
  }
  if (r.waitlist) out.push(`${r.waitlist} on the waitlist`);
  if (r.decision === "happening") {
    out.push("It's on");
  } else if (r.decision === "open" && r.minAttendance !== null && r.minAttendance !== undefined && r.moreNeeded !== null && r.moreNeeded !== undefined) {
    if (r.moreNeeded > 0) out.push(`${r.moreNeeded} more needed`);
    // The deadline is only promised while it is still ahead and undecided.
    if (r.decisionDeadline && r.timeZone && Date.parse(r.decisionDeadline) > opts.now) {
      out.push(`host confirms by ${formatConfirmBy(r.decisionDeadline, r.timeZone, opts.now, opts.viewerTimeZone)}`);
    }
  }
  if (r.venueStatus === "unconfirmed") out.push("venue not confirmed yet");
  return out;
}

export function readinessText(r: ReadinessInput, opts: ReadinessOptions): string {
  return readinessParts(r, opts).join(" · ");
}
