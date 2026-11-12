/**
 * Does a walking plan fit? (roadmap 6.2, spec docs/features/6.0.md §4)
 *
 * A pure function: no clock, no network, no storage. The planner proposes the
 * order; this only decides. It walks the stops in the order given, on instants,
 * and returns one of three answers:
 *
 * - feasible: concrete times for every stop;
 * - infeasible: the FIRST failing constraint and one suggested edit;
 * - uncertain: something it needed is unknown (a walking leg, or opening hours
 *   the caller said matter). It never says "feasible" on an unknown.
 *
 * Rules that are easy to get wrong, and are tested:
 * - A fixed stop (an event occurrence, a reservation) must be reached at least
 *   `slackMin` before it starts. Arriving early and waiting is allowed.
 * - Local wall times become instants with zonedTimeToUtc: a time skipped by the
 *   spring change moves forward, a repeated autumn time takes its first instant.
 *   Fixed starts arrive as instants, so a clock change cannot shift them.
 * - A window whose end is not after its start locally ends on the next local day.
 * - Only what is known before the first unknown is judged. A failure there is
 *   certain and reported as infeasible; otherwise the answer is uncertain.
 */
import { z } from "zod";
import { zonedParts, zonedTimeToUtc } from "./timezone";

export type LatLng = { lat: number; lng: number };

/** One walking leg from the router (6.0 §3). `unknown` is never treated as short. */
export type LegResult =
  | { status: "ok"; seconds: number; meters: number }
  | { status: "unknown"; reason: "timeout" | "no_route" | "provider_error" | "not_configured" };
export type LegUnknownReason = Extract<LegResult, { status: "unknown" }>["reason"];

/** 6.0 decision R-4. Editable per outing later (6.4). */
export const DEFAULT_MAX_WALK_MIN = { perLeg: 30, total: 90 } as const;
export const DEFAULT_SLACK_MIN = 5;

export interface FeasibilityStop {
  id: string;
  point: LatLng;
  /** Minutes spent at the stop. */
  durationMin: number;
  /** ISO instant the stop starts at, whatever the walk: an event occurrence or a reservation. */
  fixedStart?: string;
  optional?: boolean;
  /**
   * Opening hours as local "HH:MM" intervals on the day of the visit (closes not after opens runs
   * past midnight). Leave it out when hours are not being checked at all (places have none today,
   * 6.0 R-5): the result then says so per stop. "unknown" means hours matter for this stop and are
   * not known, which makes the answer uncertain. Ignored for a fixed stop: its start is the fact.
   */
  hours?: ReadonlyArray<{ opens: string; closes: string }> | "unknown";
  /** The caller found this stop hidden or removed for the requesting member. */
  unavailable?: boolean;
}

export interface FeasibilityInput {
  /** IANA zone of the outing or event. Never defaulted. */
  timeZone: string;
  /** Local "YYYY-MM-DDTHH:MM". An end not after the start is the next local day (overnight). */
  window: { startLocal: string; endLocal: string };
  startPoint: LatLng;
  stops: ReadonlyArray<FeasibilityStop>;
  /** One per stop, in order: start point to stop 1, stop 1 to stop 2, and so on. */
  legs: ReadonlyArray<LegResult>;
  maxWalkMin?: { perLeg: number; total: number };
  /** Minutes a fixed stop must be reached before it starts. */
  slackMin?: number;
  /**
   * A pause on arrival before any stop begins, in minutes. 6.0 does not define a break; this is the
   * narrowest reading of the batch's "break constraints" and is off (0) unless set.
   */
  minBreakMin?: number;
}

export interface StopTime {
  id: string;
  /** ISO instants. */
  arrive: string;
  start: string;
  leave: string;
  /** The same three in the plan's zone, "YYYY-MM-DDTHH:MM". */
  arriveLocal: string;
  startLocal: string;
  leaveLocal: string;
  /** Minutes walked to get here, rounded up. */
  walkMin: number;
  /** Minutes between arriving and starting (waiting for a fixed start or for opening). */
  waitMin: number;
  /** Whether opening hours were part of the decision for this stop. */
  hours: "checked" | "not_checked" | "fixed";
}

export type FailingConstraint =
  | { kind: "stop_unavailable"; stopId: string }
  | { kind: "leg_over_max"; stopId: string; legMin: number; maxMin: number }
  | { kind: "total_walk_over_max"; stopId: string; totalMin: number; maxMin: number }
  | { kind: "fixed_start_missed"; stopId: string; arriveLocal: string; fixedStartLocal: string; lateByMin: number }
  | { kind: "break_too_short"; stopId: string; shortByMin: number }
  | { kind: "outside_hours"; stopId: string; why: "closed" | "closes_too_soon" | "opens_too_late"; arriveLocal: string }
  | { kind: "window_overrun"; stopId: string; overByMin: number };

export type SuggestedEdit = (
  | { kind: "drop_stop"; stopId: string }
  | { kind: "shorten_stop"; stopId: string; fromMin: number; toMin: number }
  | { kind: "start_earlier"; byMin: number; startLocal: string }
  | { kind: "swap_stops"; firstId: string; secondId: string }
) & {
  /**
   * True when re-running the check with this edit clears the failing constraint. Dropping or
   * swapping stops changes the walking legs, so those cannot be checked here: they need new legs.
   */
  verified: boolean;
};

export type Feasible = { status: "feasible"; stops: StopTime[]; totalWalkMin: number; endsLocal: string };
export type Infeasible = { status: "infeasible"; failing: FailingConstraint; suggestion: SuggestedEdit | null; reached: StopTime[] };
export type Uncertain = {
  status: "uncertain";
  /** The first stop whose timing could not be decided. */
  stopId: string;
  reason: { kind: "leg_unknown"; leg: LegUnknownReason } | { kind: "hours_unknown" };
  reached: StopTime[];
};
export type FeasibilityResult = Feasible | Infeasible | Uncertain;

/** The input itself is unusable (a programming error, not a verdict about the plan). */
export class FeasibilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeasibilityInputError";
  }
}

const MIN = 60_000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, "0");
const ceilMin = (ms: number) => Math.ceil(ms / MIN - 1e-9);

function splitLocal(local: string, what: string): { date: string; time: string } {
  const m = LOCAL.exec(local);
  if (!m) throw new FeasibilityInputError(`${what} must be local "YYYY-MM-DDTHH:MM", got "${local}"`);
  const [, y, mo, d] = m;
  const real = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (real.getUTCMonth() !== Number(mo) - 1 || real.getUTCDate() !== Number(d)) throw new FeasibilityInputError(`${what} is not a real date: "${local}"`);
  return { date: `${y}-${mo}-${d}`, time: `${m[4]}:${m[5]}` };
}
const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
/** "YYYY-MM-DDTHH:MM" of an instant in the zone. */
export function toLocal(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
const instant = (date: string, time: string, timeZone: string) => zonedTimeToUtc(date, time, timeZone).getTime();

interface Normalized {
  timeZone: string;
  startMs: number;
  endMs: number;
  stops: ReadonlyArray<FeasibilityStop>;
  fixedMs: (number | null)[];
  legs: ReadonlyArray<LegResult>;
  perLeg: number;
  total: number;
  slackMs: number;
  breakMs: number;
}

function normalize(input: FeasibilityInput): Normalized {
  // No default: a plan checked in the wrong zone is wrong by hours.
  if (typeof input.timeZone !== "string" || !input.timeZone) throw new FeasibilityInputError("a time zone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone });
  } catch {
    throw new FeasibilityInputError(`unknown time zone "${input.timeZone}"`);
  }
  const start = splitLocal(input.window.startLocal, "window start");
  const end = splitLocal(input.window.endLocal, "window end");
  // Not after the start, read as local text: the window ends on the next local day.
  const overnight = input.window.endLocal <= input.window.startLocal;
  const startMs = instant(start.date, start.time, input.timeZone);
  const endMs = instant(overnight ? addDays(end.date, 1) : end.date, end.time, input.timeZone);
  if (endMs <= startMs) throw new FeasibilityInputError("the window has no length");
  if (input.legs.length !== input.stops.length) {
    throw new FeasibilityInputError(`expected ${input.stops.length} legs (one per stop), got ${input.legs.length}`);
  }
  const ids = new Set<string>();
  const fixedMs = input.stops.map((s) => {
    if (!s.id || ids.has(s.id)) throw new FeasibilityInputError(`stop ids must be present and unique: "${s.id}"`);
    ids.add(s.id);
    if (!Number.isFinite(s.durationMin) || s.durationMin < 0) throw new FeasibilityInputError(`stop "${s.id}" has an invalid duration`);
    if (Array.isArray(s.hours)) {
      for (const h of s.hours) if (!CLOCK.test(h.opens) || !CLOCK.test(h.closes)) throw new FeasibilityInputError(`stop "${s.id}" has hours that are not "HH:MM"`);
    }
    if (s.fixedStart === undefined) return null;
    const ms = Date.parse(s.fixedStart);
    if (!Number.isFinite(ms) || !/(Z|[+-]\d{2}:?\d{2})$/.test(s.fixedStart)) throw new FeasibilityInputError(`stop "${s.id}" has a fixed start that is not an instant`);
    return ms;
  });
  const max = input.maxWalkMin ?? DEFAULT_MAX_WALK_MIN;
  const slack = input.slackMin ?? DEFAULT_SLACK_MIN;
  const pause = input.minBreakMin ?? 0;
  for (const [name, n] of [["per-leg walking limit", max.perLeg], ["total walking limit", max.total], ["slack", slack], ["break", pause]] as const) {
    if (!Number.isFinite(n) || n < 0) throw new FeasibilityInputError(`the ${name} must be zero or more minutes`);
  }
  return { timeZone: input.timeZone, startMs, endMs, stops: input.stops, fixedMs, legs: input.legs, perLeg: max.perLeg, total: max.total, slackMs: slack * MIN, breakMs: pause * MIN };
}

type HoursFit = { ok: true; startMs: number; openNow: boolean } | { ok: false; why: "closed" | "closes_too_soon" };

/** The earliest moment at or after `earliestMs` when the whole visit fits inside one opening interval. */
function fitHours(earliestMs: number, durationMs: number, hours: ReadonlyArray<{ opens: string; closes: string }>, timeZone: string): HoursFit {
  const day = toLocal(earliestMs, timeZone).slice(0, 10);
  const intervals: { open: number; close: number }[] = [];
  // Yesterday's hours may run past midnight; tomorrow's may be what the visitor waits for.
  for (const offset of [-1, 0, 1]) {
    const date = addDays(day, offset);
    for (const h of hours) {
      intervals.push({ open: instant(date, h.opens, timeZone), close: instant(h.closes <= h.opens ? addDays(date, 1) : date, h.closes, timeZone) });
    }
  }
  intervals.sort((a, b) => a.open - b.open || a.close - b.close);
  const openNow = intervals.some((i) => i.open <= earliestMs && earliestMs < i.close);
  for (const i of intervals) {
    const start = Math.max(earliestMs, i.open);
    if (start + durationMs <= i.close) return { ok: true, startMs: start, openNow };
  }
  return { ok: false, why: openNow ? "closes_too_soon" : "closed" };
}

type Walk =
  | { status: "feasible"; times: StopTime[]; totalWalkMin: number; endMs: number }
  | { status: "uncertain"; index: number; reason: Uncertain["reason"]; times: StopTime[] }
  | { status: "infeasible"; index: number; failing: FailingConstraint; times: StopTime[]; needMin: number | null };

/** The schedule, stop by stop, stopping at the first failure or the first unknown. */
function walk(n: Normalized): Walk {
  const times: StopTime[] = [];
  const local = (ms: number) => toLocal(ms, n.timeZone);
  // A hidden or removed stop is certain whatever else is unknown.
  const gone = n.stops.findIndex((s) => s.unavailable);
  if (gone >= 0) return { status: "infeasible", index: gone, failing: { kind: "stop_unavailable", stopId: n.stops[gone].id }, times, needMin: null };

  let clock = n.startMs;
  let totalWalkMin = 0;
  for (let i = 0; i < n.stops.length; i++) {
    const stop = n.stops[i];
    const leg = n.legs[i];
    const fail = (failing: FailingConstraint, needMin: number | null): Walk => ({ status: "infeasible", index: i, failing, times, needMin });

    // A leg that is not a clean measurement is unknown, never short.
    const usable = leg.status === "ok" && Number.isFinite(leg.seconds) && leg.seconds >= 0;
    if (!usable) {
      return { status: "uncertain", index: i, reason: { kind: "leg_unknown", leg: leg.status === "unknown" ? leg.reason : "provider_error" }, times };
    }
    const walkMin = Math.ceil(leg.seconds / 60 - 1e-9);
    if (walkMin > n.perLeg) return fail({ kind: "leg_over_max", stopId: stop.id, legMin: walkMin, maxMin: n.perLeg }, null);
    totalWalkMin += walkMin;
    if (totalWalkMin > n.total) return fail({ kind: "total_walk_over_max", stopId: stop.id, totalMin: totalWalkMin, maxMin: n.total }, null);

    const arriveMs = clock + walkMin * MIN;
    const durationMs = stop.durationMin * MIN;
    const fixed = n.fixedMs[i];
    let startMs: number;
    let hours: StopTime["hours"];
    if (fixed !== null) {
      if (arriveMs + n.slackMs > fixed) {
        return fail({ kind: "fixed_start_missed", stopId: stop.id, arriveLocal: local(arriveMs), fixedStartLocal: local(fixed), lateByMin: ceilMin(arriveMs + n.slackMs - fixed) }, ceilMin(arriveMs + n.slackMs - fixed));
      }
      if (arriveMs + n.breakMs > fixed) {
        return fail({ kind: "break_too_short", stopId: stop.id, shortByMin: ceilMin(arriveMs + n.breakMs - fixed) }, ceilMin(arriveMs + n.breakMs - fixed));
      }
      startMs = fixed;
      hours = "fixed";
    } else {
      const earliest = arriveMs + n.breakMs;
      if (stop.hours === "unknown") return { status: "uncertain", index: i, reason: { kind: "hours_unknown" }, times };
      if (stop.hours === undefined) {
        startMs = earliest;
        hours = "not_checked";
      } else {
        const fit = fitHours(earliest, durationMs, stop.hours, n.timeZone);
        if (!fit.ok) {
          return fail({ kind: "outside_hours", stopId: stop.id, why: fit.why, arriveLocal: local(arriveMs) }, null);
        }
        // Waiting for the doors is fine, unless the wait is what pushes the visit past the window:
        // open now but shutting before the visit ends, or not opening until too late.
        if (fit.startMs + durationMs > n.endMs && earliest + durationMs <= n.endMs) {
          return fail({ kind: "outside_hours", stopId: stop.id, why: fit.openNow ? "closes_too_soon" : "opens_too_late", arriveLocal: local(arriveMs) }, null);
        }
        startMs = fit.startMs;
        hours = "checked";
      }
    }
    const leaveMs = startMs + durationMs;
    if (leaveMs > n.endMs) return fail({ kind: "window_overrun", stopId: stop.id, overByMin: ceilMin(leaveMs - n.endMs) }, ceilMin(leaveMs - n.endMs));
    times.push({
      id: stop.id,
      arrive: new Date(arriveMs).toISOString(),
      start: new Date(startMs).toISOString(),
      leave: new Date(leaveMs).toISOString(),
      arriveLocal: local(arriveMs),
      startLocal: local(startMs),
      leaveLocal: local(leaveMs),
      walkMin,
      waitMin: Math.round((startMs - arriveMs) / MIN),
      hours,
    });
    clock = leaveMs;
  }
  return { status: "feasible", times, totalWalkMin, endMs: clock };
}

/** True when the same plan with this change no longer fails at or before the stop that failed. */
function clears(changed: Normalized, failedIndex: number): boolean {
  const again = walk(changed);
  return again.status === "feasible" || again.index > failedIndex;
}

/**
 * One edit, chosen in the spec's fixed order: drop the latest optional stop, shorten the longest
 * flexible stop by up to half, start earlier, then swap two adjacent flexible stops. An edit is
 * only offered where it can help the constraint that failed.
 */
function suggest(n: Normalized, failed: Extract<Walk, { status: "infeasible" }>): SuggestedEdit | null {
  const k = failed.index;
  const kind = failed.failing.kind;
  if (kind === "stop_unavailable") return { kind: "drop_stop", stopId: n.stops[k].id, verified: false };
  const timeFailure = kind === "fixed_start_missed" || kind === "break_too_short" || kind === "window_overrun" || kind === "outside_hours";
  const flexible = (i: number) => n.fixedMs[i] === null;

  // 1. Drop the latest optional stop that is on the way to the failure.
  const dropUpTo = kind === "fixed_start_missed" || kind === "break_too_short" ? k - 1 : k;
  const dropFrom = kind === "leg_over_max" ? k : 0;
  for (let i = dropUpTo; i >= dropFrom; i--) {
    if (n.stops[i].optional) return { kind: "drop_stop", stopId: n.stops[i].id, verified: false };
  }

  if (timeFailure && failed.needMin !== null && failed.needMin > 0) {
    const need = failed.needMin;
    // 2. Shorten the longest flexible stop, by no more than half, when that is enough.
    const upTo = kind === "window_overrun" ? k : k - 1;
    const byLength = [...Array(Math.max(0, upTo + 1)).keys()].filter(flexible).sort((a, b) => n.stops[b].durationMin - n.stops[a].durationMin || a - b);
    for (const i of byLength) {
      const from = n.stops[i].durationMin;
      if (need > Math.floor(from / 2)) continue;
      const stops = n.stops.map((s, j) => (j === i ? { ...s, durationMin: from - need } : s));
      if (clears({ ...n, stops }, k)) return { kind: "shorten_stop", stopId: n.stops[i].id, fromMin: from, toMin: from - need, verified: true };
    }
    // 3. Start earlier, in five-minute steps.
    const byMin = Math.ceil(need / 5) * 5;
    if (clears({ ...n, startMs: n.startMs - byMin * MIN }, k)) {
      return { kind: "start_earlier", byMin, startLocal: toLocal(n.startMs - byMin * MIN, n.timeZone), verified: true };
    }
  }

  // 4. Swap two adjacent flexible stops: the pair nearest before the failure, else the first after it.
  const pairs = [...Array(Math.max(0, n.stops.length - 1)).keys()].filter((i) => flexible(i) && flexible(i + 1));
  const pair = [...pairs].reverse().find((i) => i + 1 <= k) ?? pairs[0];
  if (pair !== undefined) return { kind: "swap_stops", firstId: n.stops[pair].id, secondId: n.stops[pair + 1].id, verified: false };
  return null;
}

/** Decide whether the plan fits. Throws FeasibilityInputError only for input that is not a plan at all. */
export function validate(input: FeasibilityInput): FeasibilityResult {
  const n = normalize(input);
  const result = walk(n);
  if (result.status === "feasible") {
    return { status: "feasible", stops: result.times, totalWalkMin: result.totalWalkMin, endsLocal: toLocal(result.endMs, n.timeZone) };
  }
  if (result.status === "uncertain") {
    return { status: "uncertain", stopId: n.stops[result.index].id, reason: result.reason, reached: result.times };
  }
  return { status: "infeasible", failing: result.failing, suggestion: suggest(n, result), reached: result.times };
}

// ---------------------------------------------------------------------------
// What may be kept (6.0 §5, decision R-2): our verdict, never the provider's numbers.
// ---------------------------------------------------------------------------

export const ROUTER_IDS = ["fake", "mapbox-walking", "graphhopper-foot"] as const;
const id = z.string().min(1).max(80);
const storedFailing = z
  .object({ kind: z.enum(["stop_unavailable", "leg_over_max", "total_walk_over_max", "fixed_start_missed", "break_too_short", "outside_hours", "window_overrun"]), stopId: id })
  .strict();
const storedSuggestion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drop_stop"), stopId: id }).strict(),
  z.object({ kind: z.literal("shorten_stop"), stopId: id, toMin: z.number().int().min(0).max(1440) }).strict(),
  z.object({ kind: z.literal("start_earlier"), startLocal: z.string().regex(LOCAL) }).strict(),
  z.object({ kind: z.literal("swap_stops"), firstId: id, secondId: id }).strict(),
]);
/**
 * The verdict as it may be stored with an itinerary. Strict at every level: a key that is not
 * listed here (a provider duration, distance, geometry or raw payload) fails the parse, so it
 * cannot ride along into storage.
 */
export const storedValidationSchema = z
  .object({
    status: z.enum(["feasible", "infeasible", "uncertain"]),
    failing: storedFailing.optional(),
    suggestion: storedSuggestion.optional(),
    uncertainStopId: id.optional(),
    validatedAt: z.string().datetime(),
    router: z.enum(ROUTER_IDS),
  })
  .strict();
export type StoredValidation = z.infer<typeof storedValidationSchema>;

/**
 * Reduce a result to what may be stored. Walking minutes (a leg's, the total, how late) come from
 * the provider's durations and are left out; which constraint failed, at which stop, and our own
 * suggested edit are kept.
 */
export function toStoredValidation(result: FeasibilityResult, meta: { validatedAt: string; router: (typeof ROUTER_IDS)[number] }): StoredValidation {
  const base = { status: result.status, validatedAt: meta.validatedAt, router: meta.router };
  if (result.status === "feasible") return storedValidationSchema.parse(base);
  if (result.status === "uncertain") return storedValidationSchema.parse({ ...base, uncertainStopId: result.stopId });
  const s = result.suggestion;
  const suggestion =
    s === null
      ? undefined
      : s.kind === "drop_stop"
        ? { kind: s.kind, stopId: s.stopId }
        : s.kind === "shorten_stop"
          ? { kind: s.kind, stopId: s.stopId, toMin: s.toMin }
          : s.kind === "start_earlier"
            ? { kind: s.kind, startLocal: s.startLocal }
            : { kind: s.kind, firstId: s.firstId, secondId: s.secondId };
  return storedValidationSchema.parse({ ...base, failing: { kind: result.failing.kind, stopId: result.failing.stopId }, ...(suggestion ? { suggestion } : {}) });
}

/**
 * After re-checking a saved plan. When the new check could not be made because a walking leg is
 * unknown (a timeout, no key, a provider error), the previous verdict is kept exactly as it was,
 * with its own time, and reported as not fresh: a failed recalculation never relabels the old
 * verdict as current. Any other outcome is a real verdict and replaces it.
 */
export function afterRecalculation(
  previous: StoredValidation | null,
  next: FeasibilityResult,
  meta: { validatedAt: string; router: (typeof ROUTER_IDS)[number] },
): { validation: StoredValidation; fresh: boolean; failed: LegUnknownReason | null } {
  const routingFailed = next.status === "uncertain" && next.reason.kind === "leg_unknown" ? next.reason.leg : null;
  if (routingFailed && previous) return { validation: previous, fresh: false, failed: routingFailed };
  return { validation: toStoredValidation(next, meta), fresh: true, failed: routingFailed };
}
