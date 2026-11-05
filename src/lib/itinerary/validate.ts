/**
 * Itinerary feasibility validator (roadmap 6.2, 6.0 SPEC §4).
 *
 * Pure and deterministic: no I/O, no clock. The same input always gives the same answer. It decides
 * whether a proposed walking plan fits, in the order given; it never reorders silently. All arithmetic
 * is on UTC instants (whole minutes); local wall times convert through zonedTimeToUtc, so a spring-gap
 * time moves forward and a repeated fall-back time takes its first instant (4.0 decision D-G).
 *
 * Unknowns never become "fits": an unknown leg is scheduled as zero minutes, a lower bound. A failure
 * found even on that lower bound is certain (infeasible); otherwise any unknown makes the answer
 * uncertain.
 */
import { normalizeTimeZone, zonedParts, zonedTimeToUtc } from "@/lib/utils/timezone";
import type { LatLng, LegResult, LegUnknownReason } from "./types";

/** Decision R-4: 30 minutes per leg, 90 minutes in total. */
export const DEFAULT_MAX_WALK_MIN = { perLeg: 30, total: 90 } as const;
/** Minutes a fixed start must be reached ahead of time. */
export const DEFAULT_SLACK_MIN = 5;
/** The "start earlier" suggestion never proposes more than this. */
export const MAX_START_EARLIER_MIN = 180;
/** A plan covers one outing day: windows longer than this (26 h allows a DST day) are rejected. */
export const MAX_WINDOW_MIN = 26 * 60;

const MIN = 60_000;

export type OpeningHours = Array<{ opens: string; closes: string }>;

export type StopInput = {
  id: string;
  point: LatLng;
  /** Minutes spent at the stop. */
  durationMin: number;
  /** ISO instant with an offset or Z: an event occurrence or a reservation. */
  fixedStart?: string;
  optional?: boolean;
  /**
   * Local HH:MM ranges (a close at or before the open runs past midnight). Omitted: no hours constraint,
   * which is the default today because places have no hours (decision R-5). "unknown": the caller says
   * hours matter here but are not known, so the answer is uncertain.
   */
  hours?: OpeningHours | "unknown";
  /**
   * False when the caller's visibility re-check for the requesting member found the venue hidden or
   * removed since planning. Default true.
   */
  available?: boolean;
};

export type ValidateInput = {
  /** IANA zone; never hard-coded. */
  timeZone: string;
  /** Local "YYYY-MM-DDTHH:MM". An end at or before the start is an overnight window ending the next day. */
  window: { startLocal: string; endLocal: string };
  startPoint: LatLng;
  stops: StopInput[];
  /** From the router, in stop order: legs[i] walks into stops[i] (legs[0] from startPoint). */
  legs: LegResult[];
  maxWalkMin?: { perLeg: number; total: number };
  slackMin?: number;
};

export type PlannedStop = {
  id: string;
  walkMin: number;
  arriveAt: string;
  startAt: string;
  leaveAt: string;
  waitMin: number;
  arriveLocal: string;
  startLocal: string;
  leaveLocal: string;
};

export type FailingCode =
  | "stop_unavailable"
  | "leg_over_max"
  | "total_walk_over_max"
  | "fixed_start_missed"
  | "outside_hours"
  | "window_overrun";

export type Failing =
  | { code: "stop_unavailable"; stopId: string }
  | { code: "leg_over_max"; stopId: string; walkMin: number; limitMin: number }
  | { code: "total_walk_over_max"; stopId: string; walkMin: number; limitMin: number }
  | { code: "fixed_start_missed"; stopId: string; lateByMin: number }
  | { code: "outside_hours"; stopId: string }
  | { code: "window_overrun"; stopId: string; overByMin: number };

/**
 * One suggested edit. `recheck: true` means the edit changes which legs are walked, so the caller must
 * route and validate again; the others were verified here to clear every certain failure.
 */
export type Suggestion =
  | { kind: "drop_stop"; stopId: string; recheck: true }
  | { kind: "shorten_stop"; stopId: string; byMin: number; durationMin: number; recheck: false }
  | { kind: "start_earlier"; byMin: number; startLocal: string; recheck: false }
  | { kind: "swap_stops"; stopIds: [string, string]; recheck: true };

export type Uncertainty =
  | { stopId: string; kind: "leg"; reason: LegUnknownReason }
  | { stopId: string; kind: "hours" };

export type Feasible = {
  status: "feasible";
  timeZone: string;
  stops: PlannedStop[];
  totalWalkMin: number;
  startsAt: string;
  endsAt: string;
};
export type Infeasible = { status: "infeasible"; failing: Failing; suggestion: Suggestion | null };
export type Uncertain = { status: "uncertain"; stopId: string; uncertain: Uncertainty[] };
export type ValidationResult = Feasible | Infeasible | Uncertain;

/** Malformed input: a programming error in the caller, never a verdict. */
export class ItineraryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItineraryInputError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Parsing

const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function parseLocal(value: string, what: string): { date: string; time: string } {
  const match = LOCAL_RE.exec(value);
  if (!match || !validDate(match[1]) || !HHMM_RE.test(match[2])) {
    throw new ItineraryInputError(`${what} must be a local "YYYY-MM-DDTHH:MM"`);
  }
  return { date: match[1], time: match[2] };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Local "YYYY-MM-DDTHH:MM" of an instant in `timeZone`. */
export function toLocal(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

type CoreStop = {
  id: string;
  durationMin: number;
  fixed: number | null;
  optional: boolean;
  hours: OpeningHours | "unknown" | undefined;
};

type Core = {
  timeZone: string;
  start: number;
  end: number;
  stops: CoreStop[];
  legs: LegResult[];
  perLeg: number;
  total: number;
  slack: number;
};

function nonNegativeInt(value: unknown, what: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ItineraryInputError(`${what} must be a whole number from 0 to ${max}`);
  }
  return value;
}

function checkPoint(point: LatLng | undefined, what: string): void {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) {
    throw new ItineraryInputError(`${what} must be a valid point`);
  }
}

function parse(input: ValidateInput): { core: Core; unavailable: string | null } {
  const timeZone = normalizeTimeZone(input.timeZone);
  if (!timeZone) throw new ItineraryInputError("timeZone must be a supported IANA zone");
  const s = parseLocal(input.window?.startLocal, "window.startLocal");
  const e = parseLocal(input.window?.endLocal, "window.endLocal");
  const start = zonedTimeToUtc(s.date, s.time, timeZone).getTime();
  // Overnight: an end at or before the start (as local wall time) is that clock time on the next day.
  const overnight = input.window.endLocal <= input.window.startLocal;
  if (overnight && e.date !== s.date) throw new ItineraryInputError("an overnight window gives its end on the start date");
  const end = zonedTimeToUtc(overnight ? addDays(s.date, 1) : e.date, e.time, timeZone).getTime();
  if (end <= start || end - start > MAX_WINDOW_MIN * MIN) {
    throw new ItineraryInputError(`the window must be longer than zero and at most ${MAX_WINDOW_MIN} minutes`);
  }
  checkPoint(input.startPoint, "startPoint");
  if (!Array.isArray(input.stops) || !Array.isArray(input.legs) || input.legs.length !== input.stops.length) {
    throw new ItineraryInputError("legs must hold one leg per stop (start point to stop 1, then stop to stop)");
  }
  const seen = new Set<string>();
  let unavailable: string | null = null;
  const stops = input.stops.map((stop, i): CoreStop => {
    if (typeof stop.id !== "string" || !stop.id || seen.has(stop.id)) throw new ItineraryInputError(`stop ${i} needs a unique id`);
    seen.add(stop.id);
    checkPoint(stop.point, `stop ${stop.id} point`);
    const durationMin = nonNegativeInt(stop.durationMin, `stop ${stop.id} durationMin`, 24 * 60);
    let fixed: number | null = null;
    if (stop.fixedStart !== undefined) {
      fixed = INSTANT_RE.test(stop.fixedStart) ? Date.parse(stop.fixedStart) : NaN;
      if (!Number.isFinite(fixed)) throw new ItineraryInputError(`stop ${stop.id} fixedStart must be an ISO instant with an offset`);
    }
    if (Array.isArray(stop.hours)) {
      for (const range of stop.hours) {
        if (!HHMM_RE.test(range?.opens) || !HHMM_RE.test(range?.closes)) {
          throw new ItineraryInputError(`stop ${stop.id} hours must be local HH:MM ranges`);
        }
      }
    } else if (stop.hours !== undefined && stop.hours !== "unknown") {
      throw new ItineraryInputError(`stop ${stop.id} hours must be ranges or "unknown"`);
    }
    if (stop.available === false && unavailable === null) unavailable = stop.id;
    return { id: stop.id, durationMin, fixed, optional: stop.optional === true, hours: stop.hours };
  });
  for (const [i, leg] of input.legs.entries()) {
    if (leg?.status === "ok") {
      if (!Number.isFinite(leg.seconds) || leg.seconds < 0) throw new ItineraryInputError(`leg ${i} seconds must be zero or more`);
    } else if (leg?.status !== "unknown") {
      throw new ItineraryInputError(`leg ${i} must be ok or unknown`);
    }
  }
  const max = input.maxWalkMin ?? DEFAULT_MAX_WALK_MIN;
  return {
    core: {
      timeZone,
      start,
      end,
      stops,
      legs: input.legs,
      perLeg: nonNegativeInt(max.perLeg, "maxWalkMin.perLeg", 24 * 60),
      total: nonNegativeInt(max.total, "maxWalkMin.total", 24 * 60),
      slack: nonNegativeInt(input.slackMin ?? DEFAULT_SLACK_MIN, "slackMin", 24 * 60),
    },
    unavailable,
  };
}

// ---------------------------------------------------------------------------------------------------
// Scheduling

type FailAt = { failing: Exclude<Failing, { code: "stop_unavailable" }>; index: number };
type Sim =
  | { kind: "fail"; fail: FailAt }
  | { kind: "done"; times: Array<{ walkMin: number; arrive: number; begin: number; leave: number }>; uncertain: Uncertainty[]; walked: number };

/** Whether [begin, leave] lies inside one opening range on the visit's local day (or one carried over midnight). */
function withinHours(begin: number, leave: number, hours: OpeningHours, timeZone: string): boolean {
  const day = toLocal(begin, timeZone).slice(0, 10);
  for (const date of [addDays(day, -1), day]) {
    for (const { opens, closes } of hours) {
      const open = zonedTimeToUtc(date, opens, timeZone).getTime();
      const close = zonedTimeToUtc(closes > opens ? date : addDays(date, 1), closes, timeZone).getTime();
      if (begin >= open && leave <= close) return true;
    }
  }
  return false;
}

function simulate(core: Core): Sim {
  const times: Array<{ walkMin: number; arrive: number; begin: number; leave: number }> = [];
  const uncertain: Uncertainty[] = [];
  let t = core.start;
  let walked = 0;
  for (const [index, stop] of core.stops.entries()) {
    const leg = core.legs[index];
    const fail = (failing: FailAt["failing"]): Sim => ({ kind: "fail", fail: { failing, index } });
    let walkMin = 0;
    if (leg.status === "ok") {
      walkMin = Math.ceil(leg.seconds / 60);
      if (walkMin > core.perLeg) return fail({ code: "leg_over_max", stopId: stop.id, walkMin, limitMin: core.perLeg });
    } else {
      // Lower bound: zero minutes. Anything that fails anyway fails for certain.
      uncertain.push({ stopId: stop.id, kind: "leg", reason: leg.reason });
    }
    walked += walkMin;
    if (walked > core.total) return fail({ code: "total_walk_over_max", stopId: stop.id, walkMin: walked, limitMin: core.total });
    const arrive = t + walkMin * MIN;
    let begin = arrive;
    if (stop.fixed !== null) {
      const latest = stop.fixed - core.slack * MIN;
      if (arrive > latest) return fail({ code: "fixed_start_missed", stopId: stop.id, lateByMin: Math.ceil((arrive - latest) / MIN) });
      begin = stop.fixed;
    }
    const leave = begin + stop.durationMin * MIN;
    if (Array.isArray(stop.hours)) {
      if (!withinHours(begin, leave, stop.hours, core.timeZone)) {
        // With an unknown leg earlier the real visit time is later than this bound, so it may still fit.
        if (uncertain.some((u) => u.kind === "leg") && stop.fixed === null) uncertain.push({ stopId: stop.id, kind: "hours" });
        else return fail({ code: "outside_hours", stopId: stop.id });
      }
    } else if (stop.hours === "unknown") {
      uncertain.push({ stopId: stop.id, kind: "hours" });
    }
    if (leave > core.end) return fail({ code: "window_overrun", stopId: stop.id, overByMin: Math.ceil((leave - core.end) / MIN) });
    times.push({ walkMin, arrive, begin, leave });
    t = leave;
  }
  return { kind: "done", times, uncertain, walked };
}

// ---------------------------------------------------------------------------------------------------
// Suggestions: drop the latest optional stop, shorten the longest flexible stop by up to half, start
// earlier, then swap two adjacent flexible stops (6.0 §4). The first that applies wins.

const TIME_FAILURES: ReadonlySet<FailingCode> = new Set(["fixed_start_missed", "outside_hours", "window_overrun"]);

function clears(core: Core): boolean {
  return simulate(core).kind === "done";
}

function suggest(core: Core, { failing, index }: FailAt): Suggestion | null {
  for (let i = index; i >= 0; i--) {
    if (core.stops[i].optional) return { kind: "drop_stop", stopId: core.stops[i].id, recheck: true };
  }
  if (TIME_FAILURES.has(failing.code)) {
    // A fixed start can only be helped by stops before it; an overrun or closing time also by the stop itself.
    const last = failing.code === "fixed_start_missed" ? index - 1 : index;
    let longest = -1;
    for (let i = 0; i <= last; i++) {
      const stop = core.stops[i];
      if (stop.fixed === null && (longest < 0 || stop.durationMin > core.stops[longest].durationMin)) longest = i;
    }
    if (longest >= 0) {
      const stop = core.stops[longest];
      for (let by = 1; by <= Math.floor(stop.durationMin / 2); by++) {
        const stops = core.stops.map((s, i) => (i === longest ? { ...s, durationMin: s.durationMin - by } : s));
        if (clears({ ...core, stops })) return { kind: "shorten_stop", stopId: stop.id, byMin: by, durationMin: stop.durationMin - by, recheck: false };
      }
    }
    for (let by = 1; by <= MAX_START_EARLIER_MIN; by++) {
      const start = core.start - by * MIN;
      if (clears({ ...core, start })) return { kind: "start_earlier", byMin: by, startLocal: toLocal(start, core.timeZone), recheck: false };
    }
  }
  const flexible = (i: number) => i >= 0 && i < core.stops.length && core.stops[i].fixed === null;
  for (const [a, b] of [[index - 1, index], [index, index + 1]]) {
    if (flexible(a) && flexible(b)) return { kind: "swap_stops", stopIds: [core.stops[a].id, core.stops[b].id], recheck: true };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------

/** Validates a proposed walking plan. Throws ItineraryInputError only for malformed input. */
export function validateItinerary(input: ValidateInput): ValidationResult {
  const { core, unavailable } = parse(input);
  if (unavailable !== null) {
    return { status: "infeasible", failing: { code: "stop_unavailable", stopId: unavailable }, suggestion: { kind: "drop_stop", stopId: unavailable, recheck: true } };
  }
  const sim = simulate(core);
  if (sim.kind === "fail") return { status: "infeasible", failing: sim.fail.failing, suggestion: suggest(core, sim.fail) };
  if (sim.uncertain.length) return { status: "uncertain", stopId: sim.uncertain[0].stopId, uncertain: sim.uncertain };
  const iso = (t: number) => new Date(t).toISOString();
  const local = (t: number) => toLocal(t, core.timeZone);
  return {
    status: "feasible",
    timeZone: core.timeZone,
    stops: sim.times.map((time, i) => ({
      id: core.stops[i].id,
      walkMin: time.walkMin,
      arriveAt: iso(time.arrive),
      startAt: iso(time.begin),
      leaveAt: iso(time.leave),
      waitMin: Math.round((time.begin - time.arrive) / MIN),
      arriveLocal: local(time.arrive),
      startLocal: local(time.begin),
      leaveLocal: local(time.leave),
    })),
    totalWalkMin: sim.walked,
    startsAt: iso(core.start),
    endsAt: iso(sim.times.length ? sim.times[sim.times.length - 1].leave : core.start),
  };
}
