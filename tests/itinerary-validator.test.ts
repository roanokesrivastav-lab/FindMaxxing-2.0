import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_WALK_MIN,
  ItineraryInputError,
  validateItinerary,
  type StopInput,
  type ValidateInput,
} from "@/lib/itinerary/validate";
import { afterRevalidation, storedVerdict } from "@/lib/itinerary/verdict";
import type { LegResult } from "@/lib/itinerary/types";

/**
 * 6.2 feasibility validator: every required case from roadmap-80.md 6.2 and 6.0 SPEC §4, on a frozen
 * clock. The validator must not read the clock at all: Date.now throws for the whole suite.
 */
beforeAll(() => {
  vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("the validator must not read the clock");
  });
});
afterAll(() => vi.restoreAllMocks());

const NY = "America/New_York";
const P = { lat: 39.9686, lng: -83.0037 };
const walk = (min: number): LegResult => ({ status: "ok", seconds: min * 60, meters: min * 80 });
const stop = (id: string, durationMin: number, extra: Partial<StopInput> = {}): StopInput => ({ id, point: P, durationMin, ...extra });
const plan = (over: Partial<ValidateInput> & Pick<ValidateInput, "stops" | "legs">): ValidateInput => ({
  timeZone: NY,
  window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" },
  startPoint: P,
  ...over,
});
// 6 p.m. on Saturday 7 November 2026 in New York (EST, UTC-5).
const SIX_PM = "2026-11-07T18:00:00-05:00";

describe("required: a 6 p.m. reservation can't be reached at 6:20", () => {
  it("arriving at 6:20 is infeasible, never 'fits'", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:55", endLocal: "2026-11-07T23:00" },
      stops: [stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [walk(25)], // arrives 18:20
    }));
    expect(result.status).toBe("infeasible");
    if (result.status !== "infeasible") return;
    // Must be there by 17:55 (5 minutes of slack): 25 minutes late.
    expect(result.failing).toEqual({ code: "fixed_start_missed", stopId: "dinner", lateByMin: 25 });
    expect(result.suggestion).toEqual({ kind: "start_earlier", byMin: 25, startLocal: "2026-11-07T17:30", recheck: false });
  });

  it("after a stop that runs late: suggests shortening it by the least that works (at most half)", () => {
    const result = validateItinerary(plan({
      stops: [stop("bar", 60), stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [walk(10), walk(10)], // bar 17:10–18:10, dinner reached 18:20
    }));
    expect(result).toMatchObject({
      status: "infeasible",
      failing: { code: "fixed_start_missed", stopId: "dinner", lateByMin: 25 },
      suggestion: { kind: "shorten_stop", stopId: "bar", byMin: 25, durationMin: 35, recheck: false },
    });
  });

  it("suggests dropping the latest optional stop first", () => {
    const result = validateItinerary(plan({
      stops: [stop("coffee", 20, { optional: true }), stop("bar", 60, { optional: true }), stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [walk(5), walk(5), walk(10)],
    }));
    expect(result).toMatchObject({ status: "infeasible", suggestion: { kind: "drop_stop", stopId: "bar", recheck: true } });
  });

  it("slackMin boundary: arriving exactly slackMin early fits and waits; one minute later does not", () => {
    const at = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:30", endLocal: "2026-11-07T23:00" },
      stops: [stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [walk(25)], // 17:55
    }));
    expect(at).toMatchObject({ status: "feasible", stops: [{ id: "dinner", arriveLocal: "2026-11-07T17:55", startLocal: "2026-11-07T18:00", waitMin: 5, leaveLocal: "2026-11-07T19:30" }] });
    const late = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:30", endLocal: "2026-11-07T23:00" },
      stops: [stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [{ status: "ok", seconds: 25 * 60 + 1, meters: 2000 }], // rounds up to 26 minutes
    }));
    expect(late).toMatchObject({ status: "infeasible", failing: { code: "fixed_start_missed", lateByMin: 1 } });
    const noSlack = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:30", endLocal: "2026-11-07T23:00" },
      slackMin: 0,
      stops: [stop("dinner", 90, { fixedStart: SIX_PM })],
      legs: [walk(30)], // exactly 18:00
    }));
    expect(noSlack).toMatchObject({ status: "feasible", stops: [{ waitMin: 0 }] });
  });
});

describe("required: a straight-line shortcut across the river", () => {
  // Same two points. As the crow flies (the old planner's estimate) the walk is 15 minutes; the router's
  // detour over the nearest bridge is 28. The fixed start makes the difference decisive.
  const base = {
    window: { startLocal: "2026-11-07T17:30", endLocal: "2026-11-07T23:00" },
    stops: [stop("east-bank-dinner", 60, { fixedStart: SIX_PM })],
  };
  it("the straight-line estimate would claim it fits", () => {
    expect(validateItinerary(plan({ ...base, legs: [walk(15)] })).status).toBe("feasible");
  });
  it("the walking detour makes it infeasible", () => {
    expect(validateItinerary(plan({ ...base, legs: [walk(28)] }))).toMatchObject({
      status: "infeasible",
      failing: { code: "fixed_start_missed", stopId: "east-bank-dinner", lateByMin: 3 },
    });
  });
});

describe("required: an unreachable stop", () => {
  it("is uncertain, naming the stop, and never feasible", () => {
    const result = validateItinerary(plan({
      stops: [stop("park", 30), stop("island", 45), stop("cafe", 30)],
      legs: [walk(10), { status: "unknown", reason: "no_route" }, { status: "unknown", reason: "no_route" }],
    }));
    expect(result).toEqual({
      status: "uncertain",
      stopId: "island",
      uncertain: [
        { stopId: "island", kind: "leg", reason: "no_route" },
        { stopId: "cafe", kind: "leg", reason: "no_route" },
      ],
    });
  });

  it("is still infeasible when the plan fails even with the unknown leg taken as zero", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" },
      stops: [stop("bar", 70), stop("dinner", 60, { fixedStart: SIX_PM })],
      legs: [walk(5), { status: "unknown", reason: "no_route" }], // 17:05–18:15 before any walking
    }));
    expect(result).toMatchObject({ status: "infeasible", failing: { code: "fixed_start_missed", stopId: "dinner", lateByMin: 20 } });
  });
});

describe("required: provider timeout keeps the last valid plan", () => {
  const input = plan({ stops: [stop("bar", 45), stop("dinner", 90, { fixedStart: SIX_PM })], legs: [walk(5), walk(5)] }); // dinner reached 17:55
  const meta = { validatedAt: "2026-11-07T15:00:00.000Z", router: "fake" as const };
  const saved = { plan: { id: "plan-v3", stops: ["bar", "dinner"] }, verdict: storedVerdict(validateItinerary(input), meta) };

  it("a timeout is uncertain, never feasible", () => {
    const timedOut = validateItinerary({ ...input, legs: [{ status: "unknown", reason: "timeout" }, { status: "unknown", reason: "timeout" }] });
    expect(timedOut).toMatchObject({ status: "uncertain", stopId: "bar", uncertain: [{ kind: "leg", reason: "timeout" }, { kind: "leg", reason: "timeout" }] });
  });

  it("the saved plan and its verdict stay on show, marked possibly outdated", () => {
    expect(saved.verdict.status).toBe("feasible");
    for (const reason of ["timeout", "provider_error", "not_configured"] as const) {
      const fresh = validateItinerary({ ...input, legs: [walk(5), { status: "unknown", reason }] });
      const shown = afterRevalidation(saved, fresh, { validatedAt: "2026-11-07T16:00:00.000Z", router: "fake" });
      expect(shown).toEqual({ plan: saved.plan, verdict: saved.verdict, possiblyOutdated: true });
    }
  });

  it("a real answer (no route, or infeasible) replaces the verdict, but never the plan", () => {
    const later = { validatedAt: "2026-11-07T16:00:00.000Z", router: "fake" as const };
    const noRoute = afterRevalidation(saved, validateItinerary({ ...input, legs: [walk(5), { status: "unknown", reason: "no_route" }] }), later);
    expect(noRoute).toEqual({ plan: saved.plan, verdict: { status: "uncertain", uncertainStopId: "dinner", validated_at: later.validatedAt, router: "fake" }, possiblyOutdated: false });
    const late = afterRevalidation(saved, validateItinerary({ ...input, legs: [walk(5), walk(25)] }), later);
    expect(late.plan).toBe(saved.plan);
    expect(late.verdict).toMatchObject({ status: "infeasible", failing: { code: "fixed_start_missed", stopId: "dinner" } });
  });
});

describe("required: overnight window", () => {
  const night = { startLocal: "2026-11-06T22:00", endLocal: "2026-11-06T02:00" }; // ends 2 a.m. on the 7th

  it("an end before the start runs to the next local day", () => {
    const result = validateItinerary(plan({ window: night, stops: [stop("bar", 90), stop("late-food", 60)], legs: [walk(10), walk(10)] }));
    expect(result).toMatchObject({
      status: "feasible",
      startsAt: "2026-11-07T03:00:00.000Z",
      stops: [
        { id: "bar", arriveLocal: "2026-11-06T22:10", leaveLocal: "2026-11-06T23:40" },
        { id: "late-food", arriveLocal: "2026-11-06T23:50", leaveLocal: "2026-11-07T00:50" },
      ],
      endsAt: "2026-11-07T05:50:00.000Z",
    });
  });

  it("running past the overnight end is a window overrun", () => {
    const result = validateItinerary(plan({ window: night, stops: [stop("bar", 90), stop("late-food", 140)], legs: [walk(10), walk(10)] }));
    expect(result).toMatchObject({ status: "infeasible", failing: { code: "window_overrun", stopId: "late-food", overByMin: 10 } });
  });

  it("opening hours that cross midnight are honoured, and a midnight close is enforced", () => {
    const open = validateItinerary(plan({ window: night, stops: [stop("bar", 90), stop("late-food", 60, { hours: [{ opens: "22:00", closes: "03:00" }] })], legs: [walk(10), walk(10)] }));
    expect(open.status).toBe("feasible");
    const closed = validateItinerary(plan({ window: night, stops: [stop("bar", 90), stop("late-food", 60, { hours: [{ opens: "18:00", closes: "00:00" }] })], legs: [walk(10), walk(10)] }));
    // Bar can only lose 45 minutes (half), not the 50 needed; starting 50 minutes earlier works.
    expect(closed).toMatchObject({
      status: "infeasible",
      failing: { code: "outside_hours", stopId: "late-food" },
      suggestion: { kind: "start_earlier", byMin: 50, startLocal: "2026-11-06T21:10", recheck: false },
    });
  });

  it("an overnight window that crosses the fall-back change gains its extra real hour", () => {
    // 22:00 EDT on 31 Oct to 02:00 EST on 1 Nov is five real hours, not four.
    const result = validateItinerary(plan({
      window: { startLocal: "2026-10-31T22:00", endLocal: "2026-10-31T02:00" },
      stops: [stop("show", 120), stop("bar", 150)],
      legs: [walk(10), walk(10)],
    }));
    expect(result).toMatchObject({ status: "feasible", startsAt: "2026-11-01T02:00:00.000Z", endsAt: "2026-11-01T06:50:00.000Z" });
    if (result.status === "feasible") expect(result.stops[1].leaveLocal).toBe("2026-11-01T01:50");
  });
});

describe("required: DST change, both transitions", () => {
  it("spring forward: a 23:00–03:00 night is only three real hours", () => {
    const window = { startLocal: "2026-03-07T23:00", endLocal: "2026-03-07T03:00" };
    const result = validateItinerary(plan({ window, stops: [stop("bar", 100), stop("diner", 80)], legs: [walk(10), walk(10)] }));
    // 200 minutes would fit four wall-clock hours, but the night loses one at 2 a.m.
    expect(result).toMatchObject({ status: "infeasible", failing: { code: "window_overrun", stopId: "diner", overByMin: 20 } });
  });

  it("spring forward: a start in the skipped hour moves forward (2:30 becomes 3:30 EDT)", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-03-08T02:30", endLocal: "2026-03-08T06:00" },
      stops: [stop("bakery", 30)],
      legs: [walk(0)],
    }));
    expect(result).toMatchObject({ status: "feasible", startsAt: "2026-03-08T07:30:00.000Z", stops: [{ startLocal: "2026-03-08T03:30", leaveLocal: "2026-03-08T04:00" }] });
  });

  it("fall back: a repeated time takes the first instant, and a fixed instant is not shifted", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-11-01T01:30", endLocal: "2026-11-01T03:00" },
      // The reservation is at the SECOND 1:30 (EST), given as an instant from the anchored occurrence.
      stops: [stop("reservation", 60, { fixedStart: "2026-11-01T06:30:00Z" })],
      legs: [walk(10)],
    }));
    expect(result).toMatchObject({
      status: "feasible",
      startsAt: "2026-11-01T05:30:00.000Z", // first 1:30, EDT
      stops: [{
        arriveAt: "2026-11-01T05:40:00.000Z",
        startAt: "2026-11-01T06:30:00.000Z",
        waitMin: 50,
        startLocal: "2026-11-01T01:30",
        leaveLocal: "2026-11-01T02:30",
      }],
    });
  });

  it("fall back: 150 real minutes fit a 01:30–03:00 wall-clock window", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-11-01T01:30", endLocal: "2026-11-01T03:00" },
      stops: [stop("late-show", 140)],
      legs: [walk(10)],
    }));
    expect(result).toMatchObject({ status: "feasible", endsAt: "2026-11-01T08:00:00.000Z" });
  });

  it("the zone is the caller's, never hard-coded", () => {
    const tokyo = validateItinerary(plan({ timeZone: "Asia/Tokyo", window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T23:00" }, stops: [stop("a", 30)], legs: [walk(10)] }));
    expect(tokyo).toMatchObject({ status: "feasible", timeZone: "Asia/Tokyo", startsAt: "2026-11-07T08:00:00.000Z" });
  });
});

describe("required: venue hidden after planning", () => {
  const stops = [stop("park", 30), stop("gallery", 45, { optional: true }), stop("cafe", 30)];
  const legs = [walk(5), walk(5), walk(5)];
  it("the same plan flips from feasible to infeasible with stop_unavailable and the edit 'drop it'", () => {
    expect(validateItinerary(plan({ stops, legs })).status).toBe("feasible");
    const hidden = stops.map((s) => (s.id === "cafe" ? { ...s, available: false } : s));
    expect(validateItinerary(plan({ stops: hidden, legs }))).toEqual({
      status: "infeasible",
      failing: { code: "stop_unavailable", stopId: "cafe" },
      suggestion: { kind: "drop_stop", stopId: "cafe", recheck: true },
    });
  });
});

describe("walking limits (R-4 defaults 30 per leg, 90 total)", () => {
  it("a leg exactly at the limit fits; one second over does not", () => {
    expect(DEFAULT_MAX_WALK_MIN).toEqual({ perLeg: 30, total: 90 });
    expect(validateItinerary(plan({ stops: [stop("a", 10)], legs: [walk(30)] })).status).toBe("feasible");
    expect(validateItinerary(plan({ stops: [stop("a", 10)], legs: [{ status: "ok", seconds: 1801, meters: 2401 }] }))).toMatchObject({
      status: "infeasible",
      failing: { code: "leg_over_max", stopId: "a", walkMin: 31, limitMin: 30 },
      suggestion: null, // nothing to drop or swap
    });
  });

  it("total walking exactly at the limit fits; one more minute does not", () => {
    const three = [stop("a", 10), stop("b", 10), stop("c", 10)];
    expect(validateItinerary(plan({ stops: three, legs: [walk(30), walk(30), walk(30)] }))).toMatchObject({ status: "feasible", totalWalkMin: 90 });
    expect(validateItinerary(plan({ stops: [...three, stop("d", 10)], legs: [walk(30), walk(30), walk(30), walk(1)] }))).toMatchObject({
      status: "infeasible",
      failing: { code: "total_walk_over_max", stopId: "d", walkMin: 91, limitMin: 90 },
      suggestion: { kind: "swap_stops", stopIds: ["c", "d"], recheck: true },
    });
  });

  it("per-outing limits override the defaults", () => {
    expect(validateItinerary(plan({ maxWalkMin: { perLeg: 10, total: 15 }, stops: [stop("a", 10)], legs: [walk(12)] }))).toMatchObject({ status: "infeasible", failing: { code: "leg_over_max", limitMin: 10 } });
  });
});

describe("an empty optional list, and other edges", () => {
  it("with no optional stops, the suggestion skips straight to shortening", () => {
    const result = validateItinerary(plan({
      window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-07T19:00" },
      stops: [stop("museum", 80), stop("cafe", 40)],
      legs: [walk(5), walk(5)], // ends 19:10
    }));
    expect(result).toMatchObject({ status: "infeasible", failing: { code: "window_overrun", stopId: "cafe", overByMin: 10 }, suggestion: { kind: "shorten_stop", stopId: "museum", byMin: 10, durationMin: 70 } });
  });

  it("a plan with no stops is trivially feasible", () => {
    expect(validateItinerary(plan({ stops: [], legs: [] }))).toMatchObject({ status: "feasible", stops: [], totalWalkMin: 0, endsAt: "2026-11-07T22:00:00.000Z" });
  });

  it("never reorders: stops come back in the order given", () => {
    const result = validateItinerary(plan({ stops: [stop("c", 10), stop("a", 10), stop("b", 10)], legs: [walk(1), walk(1), walk(1)] }));
    expect(result.status === "feasible" && result.stops.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("hours omitted are no constraint (R-5); hours explicitly unknown make it uncertain", () => {
    expect(validateItinerary(plan({ stops: [stop("a", 30)], legs: [walk(5)] })).status).toBe("feasible");
    expect(validateItinerary(plan({ stops: [stop("a", 30, { hours: "unknown" })], legs: [walk(5)] }))).toEqual({
      status: "uncertain", stopId: "a", uncertain: [{ stopId: "a", kind: "hours" }],
    });
  });

  it("is deterministic: the same input gives the same output", () => {
    const input = plan({ stops: [stop("bar", 60), stop("dinner", 90, { fixedStart: SIX_PM })], legs: [walk(10), walk(10)] });
    expect(validateItinerary(input)).toEqual(validateItinerary(structuredClone(input)));
  });

  it("rejects malformed input instead of guessing", () => {
    const ok = plan({ stops: [stop("a", 30)], legs: [walk(5)] });
    expect(() => validateItinerary({ ...ok, legs: [] })).toThrow(ItineraryInputError);
    expect(() => validateItinerary({ ...ok, timeZone: "Mars/Olympus" })).toThrow(ItineraryInputError);
    expect(() => validateItinerary({ ...ok, window: { startLocal: "2026-11-07 17:00", endLocal: "2026-11-07T23:00" } })).toThrow(ItineraryInputError);
    expect(() => validateItinerary({ ...ok, stops: [stop("a", 30, { fixedStart: "2026-11-07T18:00" })] })).toThrow(/offset/);
    expect(() => validateItinerary({ ...ok, stops: [stop("a", 30), stop("a", 10)], legs: [walk(1), walk(1)] })).toThrow(/unique/);
    expect(() => validateItinerary({ ...ok, stops: [stop("a", -5)] })).toThrow(ItineraryInputError);
    expect(() => validateItinerary({ ...ok, window: { startLocal: "2026-11-07T17:00", endLocal: "2026-11-09T23:00" } })).toThrow(/window/);
  });
});

describe("stored verdict (R-2): our verdict only, never provider numbers", () => {
  it("drops walk minutes, times, seconds and meters", () => {
    const infeasible = validateItinerary(plan({ stops: [stop("a", 10)], legs: [{ status: "ok", seconds: 2400, meters: 3123 }] }));
    const verdict = storedVerdict(infeasible, { validatedAt: "2026-11-07T15:00:00.000Z", router: "fake" });
    expect(verdict).toEqual({ status: "infeasible", failing: { code: "leg_over_max", stopId: "a" }, validated_at: "2026-11-07T15:00:00.000Z", router: "fake" });
    const feasible = storedVerdict(validateItinerary(plan({ stops: [stop("a", 10)], legs: [{ status: "ok", seconds: 437, meters: 583 }] })), { validatedAt: "x", router: "mapbox-walking" });
    expect(feasible).toEqual({ status: "feasible", validated_at: "x", router: "mapbox-walking" });
    expect(JSON.stringify(feasible)).not.toMatch(/437|583|seconds|meters|walkMin|arrive|leave/);
  });
});
