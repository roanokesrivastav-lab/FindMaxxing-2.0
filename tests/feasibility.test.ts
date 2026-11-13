/**
 * Roadmap 6.2: the deterministic feasibility validator (docs/features/6.0.md §4).
 *
 * Every case is a plan with hand-written legs, so each expected time can be
 * checked by reading it. The river and island cases use the legs a router
 * would return; the fixture-driven fake that produces them is ticket 6.1.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_WALK_MIN,
  DEFAULT_SLACK_MIN,
  FeasibilityInputError,
  afterRecalculation,
  storedValidationSchema,
  toStoredValidation,
  validate,
  type FeasibilityInput,
  type FeasibilityResult,
  type FeasibilityStop,
  type LegResult,
} from "../src/lib/trips/feasibility";

const NY = "America/New_York";
const here = { lat: 39.9612, lng: -83.0007 };
const ok = (minutes: number): LegResult => ({ status: "ok", seconds: minutes * 60, meters: Math.round(minutes * 80) });
const unknown = (reason: "timeout" | "no_route" | "provider_error" | "not_configured"): LegResult => ({ status: "unknown", reason });
const stop = (id: string, durationMin: number, over: Partial<FeasibilityStop> = {}): FeasibilityStop => ({ id, point: here, durationMin, ...over });
/** A Saturday evening in Columbus, in standard time: 16:00 local is 21:00Z. */
const plan = (stops: FeasibilityStop[], legs: LegResult[], over: Partial<FeasibilityInput> = {}): FeasibilityInput => ({
  timeZone: NY,
  window: { startLocal: "2026-11-14T16:00", endLocal: "2026-11-14T22:00" },
  startPoint: here,
  stops,
  legs,
  ...over,
});
const feasible = (r: FeasibilityResult) => {
  if (r.status !== "feasible") throw new Error(`expected feasible, got ${JSON.stringify(r)}`);
  return r;
};
const infeasible = (r: FeasibilityResult) => {
  if (r.status !== "infeasible") throw new Error(`expected infeasible, got ${JSON.stringify(r)}`);
  return r;
};
const uncertain = (r: FeasibilityResult) => {
  if (r.status !== "uncertain") throw new Error(`expected uncertain, got ${JSON.stringify(r)}`);
  return r;
};
const meta = { validatedAt: "2026-11-14T20:00:00.000Z", router: "fake" as const };

afterEach(() => vi.useRealTimers());

describe("a plan that fits", () => {
  it("gives every stop its times, on instants and in the plan's zone", () => {
    const r = feasible(validate(plan([stop("coffee", 45), stop("park", 60)], [ok(12), ok(20)])));
    expect(r.stops).toEqual([
      { id: "coffee", arrive: "2026-11-14T21:12:00.000Z", start: "2026-11-14T21:12:00.000Z", leave: "2026-11-14T21:57:00.000Z", arriveLocal: "2026-11-14T16:12", startLocal: "2026-11-14T16:12", leaveLocal: "2026-11-14T16:57", walkMin: 12, waitMin: 0, hours: "not_checked" },
      { id: "park", arrive: "2026-11-14T22:17:00.000Z", start: "2026-11-14T22:17:00.000Z", leave: "2026-11-14T23:17:00.000Z", arriveLocal: "2026-11-14T17:17", startLocal: "2026-11-14T17:17", leaveLocal: "2026-11-14T18:17", walkMin: 20, waitMin: 0, hours: "not_checked" },
    ]);
    expect(r.totalWalkMin).toBe(32);
    expect(r.endsLocal).toBe("2026-11-14T18:17");
  });

  it("uses 6.0's defaults: 30 minutes a leg, 90 in all, 5 minutes of slack", () => {
    expect(DEFAULT_MAX_WALK_MIN).toEqual({ perLeg: 30, total: 90 });
    expect(DEFAULT_SLACK_MIN).toBe(5);
  });

  it("a plan with no stops fits and ends where it starts", () => {
    expect(feasible(validate(plan([], []))).endsLocal).toBe("2026-11-14T16:00");
  });

  it("a stop at the start point is a zero-minute walk, written as 0", () => {
    const r = feasible(validate(plan([stop("here", 10)], [{ status: "ok", seconds: 0, meters: 0 }])));
    expect(Object.is(r.stops[0].walkMin, 0)).toBe(true);
    expect(Object.is(r.totalWalkMin, 0)).toBe(true);
  });

  it("walking time rounds up to whole minutes", () => {
    const r = feasible(validate(plan([stop("a", 10)], [{ status: "ok", seconds: 61, meters: 80 }])));
    expect(r.stops[0].walkMin).toBe(2);
  });
});

describe("fixed starts: a reservation or an event occurrence", () => {
  const dinner = (over: Partial<FeasibilityStop> = {}) => stop("dinner", 75, { fixedStart: "2026-11-14T23:00:00.000Z", ...over }); // 6:00 PM
  const from5 = { window: { startLocal: "2026-11-14T17:00", endLocal: "2026-11-14T22:00" } };

  it("a 6 PM reservation reached at 6:20 is infeasible, and says by how much", () => {
    // Leave at 5:00, 10 minutes to the gallery, an hour there, 10 minutes on: 6:20.
    const r = infeasible(validate(plan([stop("gallery", 60), dinner()], [ok(10), ok(10)], from5)));
    expect(r.failing).toEqual({ kind: "fixed_start_missed", stopId: "dinner", arriveLocal: "2026-11-14T18:20", fixedStartLocal: "2026-11-14T18:00", lateByMin: 25 });
    expect(r.reached.map((s) => s.id)).toEqual(["gallery"]);
  });

  it("arriving early waits; the stop starts at its fixed time and runs its full length", () => {
    const r = feasible(validate(plan([dinner()], [ok(30)], from5)));
    expect(r.stops[0]).toMatchObject({ arriveLocal: "2026-11-14T17:30", startLocal: "2026-11-14T18:00", leaveLocal: "2026-11-14T19:15", waitMin: 30, hours: "fixed" });
  });

  it("the slack boundary: exactly 5 minutes early fits, 4 does not", () => {
    const at = (startLocal: string) => validate(plan([dinner()], [ok(25)], { window: { startLocal, endLocal: "2026-11-14T22:00" } }));
    expect(feasible(at("2026-11-14T17:30")).stops[0]).toMatchObject({ arriveLocal: "2026-11-14T17:55", waitMin: 5 });
    expect(infeasible(at("2026-11-14T17:31")).failing).toMatchObject({ kind: "fixed_start_missed", lateByMin: 1 });
    // With no slack asked for, arriving on the minute is enough.
    expect(validate(plan([dinner()], [ok(25)], { window: { startLocal: "2026-11-14T17:35", endLocal: "2026-11-14T22:00" }, slackMin: 0 })).status).toBe("feasible");
  });

  it("a fixed start is an instant: the same plan in another zone is judged against the same moment", () => {
    // 6 PM in Columbus is 5 PM in Chicago. Leaving at 4:40 Chicago time with a 10 minute walk is in time; at 5:00 is not.
    const chicago = (startLocal: string) => validate(plan([dinner()], [ok(10)], { timeZone: "America/Chicago", window: { startLocal, endLocal: "2026-11-14T21:00" } }));
    expect(feasible(chicago("2026-11-14T16:40")).stops[0]).toMatchObject({ arriveLocal: "2026-11-14T16:50", startLocal: "2026-11-14T17:00" });
    expect(infeasible(chicago("2026-11-14T17:00")).failing.kind).toBe("fixed_start_missed");
  });
});

describe("walking legs from the router", () => {
  const dinner = stop("dinner", 60, { fixedStart: "2026-11-14T23:00:00.000Z" });
  const from5 = { window: { startLocal: "2026-11-14T17:20", endLocal: "2026-11-14T22:00" } };

  it("a straight line across the river would fit; the walk over the bridge does not", () => {
    // Bar to restaurant: 8 minutes as the crow flies, 26 by the nearest bridge.
    const asTheCrowFlies = validate(plan([stop("bar", 20), dinner], [ok(5), ok(8)], from5));
    const byTheBridge = validate(plan([stop("bar", 20), dinner], [ok(5), ok(26)], from5));
    expect(asTheCrowFlies.status).toBe("feasible");
    expect(infeasible(byTheBridge).failing).toMatchObject({ kind: "fixed_start_missed", stopId: "dinner", arriveLocal: "2026-11-14T18:11", lateByMin: 16 });
  });

  it("an unreachable stop makes the plan uncertain and names the stop", () => {
    const r = uncertain(validate(plan([stop("bar", 20), stop("island", 30), stop("after", 30)], [ok(5), unknown("no_route"), ok(5)])));
    expect(r).toMatchObject({ stopId: "island", reason: { kind: "leg_unknown", leg: "no_route" } });
    expect(r.reached.map((s) => s.id)).toEqual(["bar"]);
  });

  it.each(["timeout", "provider_error", "not_configured", "no_route"] as const)("a %s leg is never treated as a short walk", (reason) => {
    expect(uncertain(validate(plan([stop("a", 30)], [unknown(reason)]))).reason).toEqual({ kind: "leg_unknown", leg: reason });
  });

  it("an unknown leg anywhere in a plan that otherwise fits never yields feasible", () => {
    const stops = [stop("a", 20), stop("b", 20), stop("c", 20), stop("d", 20)];
    expect(validate(plan(stops, stops.map(() => ok(10)))).status).toBe("feasible");
    for (let i = 0; i < stops.length; i++) {
      const legs = stops.map((_, j) => (j === i ? unknown("timeout") : ok(10)));
      expect(uncertain(validate(plan(stops, legs))).stopId).toBe(stops[i].id);
    }
  });

  it("a leg that claims to be measured but is not a clean number is unknown, not zero", () => {
    for (const seconds of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const r = uncertain(validate(plan([stop("a", 30)], [{ status: "ok", seconds, meters: 100 }])));
      expect(r.reason).toEqual({ kind: "leg_unknown", leg: "provider_error" });
    }
  });

  it("a failure before the first unknown is certain; a failure after it is not", () => {
    const late = stop("dinner", 60, { fixedStart: "2026-11-14T21:05:00.000Z" }); // 4:05 PM, five minutes after the window opens
    expect(validate(plan([late, stop("x", 10)], [ok(20), unknown("timeout")])).status).toBe("infeasible");
    expect(validate(plan([stop("x", 10), late], [unknown("timeout"), ok(20)])).status).toBe("uncertain");
  });

  it("the per-leg limit: exactly 30 minutes fits, one second more does not", () => {
    expect(validate(plan([stop("a", 10)], [{ status: "ok", seconds: 1800, meters: 2400 }])).status).toBe("feasible");
    expect(infeasible(validate(plan([stop("a", 10)], [{ status: "ok", seconds: 1801, meters: 2401 }]))).failing).toEqual({ kind: "leg_over_max", stopId: "a", legMin: 31, maxMin: 30 });
  });

  it("the total limit: 90 minutes fits, 91 fails at the stop that tips it over", () => {
    const stops = [stop("a", 5), stop("b", 5), stop("c", 5), stop("d", 5)];
    expect(feasible(validate(plan(stops, [ok(30), ok(30), ok(30), ok(0)]))).totalWalkMin).toBe(90);
    expect(infeasible(validate(plan(stops, [ok(30), ok(30), ok(30), ok(1)]))).failing).toEqual({ kind: "total_walk_over_max", stopId: "d", totalMin: 91, maxMin: 90 });
  });

  it("limits can be set per plan", () => {
    expect(infeasible(validate(plan([stop("a", 10)], [ok(16)], { maxWalkMin: { perLeg: 15, total: 90 } }))).failing).toMatchObject({ kind: "leg_over_max", maxMin: 15 });
    expect(validate(plan([stop("a", 10)], [ok(45)], { maxWalkMin: { perLeg: 60, total: 120 } })).status).toBe("feasible");
  });
});

describe("the window", () => {
  it("a stop may end exactly when the window does, and not a minute later", () => {
    const sixHours = (lastMin: number) => validate(plan([stop("a", 300), stop("b", lastMin)], [ok(10), ok(10)]));
    expect(feasible(sixHours(40)).endsLocal).toBe("2026-11-14T22:00");
    expect(infeasible(sixHours(41)).failing).toEqual({ kind: "window_overrun", stopId: "b", overByMin: 1 });
  });

  it("an overnight window ends on the next local day", () => {
    const night = { window: { startLocal: "2026-11-14T21:00", endLocal: "2026-11-14T02:00" } };
    const r = feasible(validate(plan([stop("show", 150), stop("diner", 90)], [ok(15), ok(15)], night)));
    expect(r.stops[1]).toMatchObject({ arriveLocal: "2026-11-15T00:00", leaveLocal: "2026-11-15T01:30" });
    expect(infeasible(validate(plan([stop("show", 150), stop("diner", 125)], [ok(15), ok(15)], night))).failing).toEqual({ kind: "window_overrun", stopId: "diner", overByMin: 5 });
    // The same start and end time is a full day, not an empty window.
    expect(validate(plan([stop("a", 600)], [ok(10)], { window: { startLocal: "2026-11-14T21:00", endLocal: "2026-11-14T21:00" } })).status).toBe("feasible");
  });
});

describe("daylight saving, both ways", () => {
  it("autumn: the night the clocks go back is an hour longer, and the plan gets that hour", () => {
    // 11 PM to 3 AM across 2026-11-01 in New York is five real hours, not four.
    const night = { window: { startLocal: "2026-10-31T23:00", endLocal: "2026-10-31T03:00" } };
    const r = feasible(validate(plan([stop("party", 280)], [ok(10)], night)));
    expect(r.stops[0]).toMatchObject({ arrive: "2026-11-01T03:10:00.000Z", leave: "2026-11-01T07:50:00.000Z", arriveLocal: "2026-10-31T23:10", leaveLocal: "2026-11-01T02:50" });
    expect(infeasible(validate(plan([stop("party", 295)], [ok(10)], night))).failing).toEqual({ kind: "window_overrun", stopId: "party", overByMin: 5 });
  });

  it("autumn: a repeated local time takes its first instant", () => {
    // 1:30 AM happens twice on 2026-11-01. The window opens at the first one (05:30Z, still daylight time).
    const r = feasible(validate(plan([stop("a", 30)], [ok(15)], { window: { startLocal: "2026-11-01T01:30", endLocal: "2026-11-01T04:00" } })));
    expect(r.stops[0]).toMatchObject({ arrive: "2026-11-01T05:45:00.000Z", leave: "2026-11-01T06:15:00.000Z", arriveLocal: "2026-11-01T01:45", leaveLocal: "2026-11-01T01:15" });
    // A fixed start at the second 1:30 (06:30Z) is an instant, so it is an hour after the first.
    const second = validate(plan([stop("b", 20, { fixedStart: "2026-11-01T06:30:00.000Z" })], [ok(15)], { window: { startLocal: "2026-11-01T01:30", endLocal: "2026-11-01T04:00" } }));
    expect(feasible(second).stops[0]).toMatchObject({ waitMin: 45, startLocal: "2026-11-01T01:30" });
  });

  it("spring: the night the clocks go forward is an hour shorter, and the plan loses that hour", () => {
    // 1 AM to 4 AM on 2026-03-08 in New York is two real hours.
    const night = { window: { startLocal: "2026-03-08T01:00", endLocal: "2026-03-08T04:00" } };
    expect(feasible(validate(plan([stop("a", 110)], [ok(10)], night))).stops[0]).toMatchObject({ leave: "2026-03-08T08:00:00.000Z", leaveLocal: "2026-03-08T04:00" });
    expect(infeasible(validate(plan([stop("a", 140)], [ok(10)], night))).failing).toEqual({ kind: "window_overrun", stopId: "a", overByMin: 30 });
  });

  it("spring: a local time that does not exist moves forward", () => {
    // 2:30 AM is skipped; the window opens at 3:30 AM daylight time (07:30Z).
    const r = feasible(validate(plan([stop("a", 20)], [ok(10)], { window: { startLocal: "2026-03-08T02:30", endLocal: "2026-03-08T06:00" } })));
    expect(r.stops[0]).toMatchObject({ arrive: "2026-03-08T07:40:00.000Z", arriveLocal: "2026-03-08T03:40" });
  });

  it("spring: a fixed start across the change is not shifted by it", () => {
    // Leave at 1:30 AM standard time, walk 25 minutes, for something that starts at 3:00 AM daylight time (07:00Z): 5 minutes early.
    const fixed = stop("sunrise", 30, { fixedStart: "2026-03-08T07:00:00.000Z" });
    const r = feasible(validate(plan([fixed], [ok(25)], { window: { startLocal: "2026-03-08T01:30", endLocal: "2026-03-08T05:00" } })));
    expect(r.stops[0]).toMatchObject({ arriveLocal: "2026-03-08T01:55", startLocal: "2026-03-08T03:00", waitMin: 5 });
    expect(validate(plan([fixed], [ok(26)], { window: { startLocal: "2026-03-08T01:30", endLocal: "2026-03-08T05:00" } })).status).toBe("infeasible");
  });

  it("the zone is the plan's own: London changes on other dates", () => {
    // 2026-03-29 in London loses an hour; the same wall times in New York that night do not.
    const window = { startLocal: "2026-03-29T00:30", endLocal: "2026-03-29T03:30" };
    expect(validate(plan([stop("a", 150)], [ok(10)], { timeZone: "Europe/London", window })).status).toBe("infeasible");
    expect(validate(plan([stop("a", 150)], [ok(10)], { timeZone: NY, window })).status).toBe("feasible");
  });
});

describe("opening hours", () => {
  const lunch = { window: { startLocal: "2026-11-14T09:30", endLocal: "2026-11-14T15:00" } };
  const cafe = (hours: FeasibilityStop["hours"], over: Partial<FeasibilityStop> = {}) => stop("cafe", 45, { hours, ...over });

  it("left out: not part of the decision, and the result says so", () => {
    expect(feasible(validate(plan([cafe(undefined)], [ok(10)], lunch))).stops[0].hours).toBe("not_checked");
  });

  it("known and open: checked", () => {
    expect(feasible(validate(plan([cafe([{ opens: "08:00", closes: "16:00" }])], [ok(10)], lunch))).stops[0]).toMatchObject({ hours: "checked", waitMin: 0 });
  });

  it("arriving before the doors open waits for them", () => {
    expect(feasible(validate(plan([cafe([{ opens: "10:00", closes: "16:00" }])], [ok(10)], lunch))).stops[0]).toMatchObject({ arriveLocal: "2026-11-14T09:40", startLocal: "2026-11-14T10:00", waitMin: 20 });
  });

  it("closing before the visit is over is infeasible; so is closed all day, and opening too late for the window", () => {
    expect(infeasible(validate(plan([cafe([{ opens: "08:00", closes: "10:00" }])], [ok(10)], lunch))).failing).toEqual({ kind: "outside_hours", stopId: "cafe", why: "closes_too_soon", arriveLocal: "2026-11-14T09:40" });
    expect(infeasible(validate(plan([cafe([])], [ok(10)], lunch))).failing).toMatchObject({ kind: "outside_hours", why: "closed" });
    expect(infeasible(validate(plan([cafe([{ opens: "14:30", closes: "18:00" }])], [ok(10)], lunch))).failing).toMatchObject({ kind: "outside_hours", why: "opens_too_late" });
  });

  it("hours that run past midnight cover a visit after midnight", () => {
    const night = { window: { startLocal: "2026-11-14T23:30", endLocal: "2026-11-14T02:00" } };
    const bar = stop("bar", 60, { hours: [{ opens: "18:00", closes: "02:00" }] });
    expect(feasible(validate(plan([bar], [ok(40)], { ...night, maxWalkMin: { perLeg: 60, total: 90 } }))).stops[0]).toMatchObject({ startLocal: "2026-11-15T00:10", hours: "checked" });
  });

  it("unknown hours make the plan uncertain for a flexible stop, and are ignored for a fixed one", () => {
    expect(uncertain(validate(plan([stop("first", 20), cafe("unknown")], [ok(5), ok(5)], lunch)))).toMatchObject({ stopId: "cafe", reason: { kind: "hours_unknown" } });
    const booked = cafe("unknown", { fixedStart: "2026-11-14T15:00:00.000Z" }); // 10:00 AM
    expect(feasible(validate(plan([booked], [ok(10)], lunch))).stops[0].hours).toBe("fixed");
  });
});

describe("a stop that became hidden or was removed", () => {
  it("is infeasible with the stop named and the edit to drop it, whatever else is unknown", () => {
    const stops = [stop("a", 20), stop("gone", 30, { unavailable: true }), stop("c", 20)];
    const r = infeasible(validate(plan(stops, [unknown("timeout"), ok(5), ok(5)])));
    expect(r.failing).toEqual({ kind: "stop_unavailable", stopId: "gone" });
    expect(r.suggestion).toEqual({ kind: "drop_stop", stopId: "gone", verified: false });
  });
});

describe("a break on arrival (off unless asked for)", () => {
  it("delays a flexible stop and must fit before a fixed one", () => {
    expect(feasible(validate(plan([stop("a", 30)], [ok(10)], { minBreakMin: 10 }))).stops[0]).toMatchObject({ arriveLocal: "2026-11-14T16:10", startLocal: "2026-11-14T16:20", waitMin: 10 });
    // 7 minutes early clears the 5 minute slack but not a 10 minute break.
    const fixed = stop("class", 30, { fixedStart: "2026-11-14T22:00:00.000Z" }); // 5:00 PM
    const at = (minBreakMin?: number) => validate(plan([fixed], [ok(23)], { window: { startLocal: "2026-11-14T16:30", endLocal: "2026-11-14T22:00" }, minBreakMin }));
    expect(at().status).toBe("feasible");
    expect(infeasible(at(10)).failing).toEqual({ kind: "break_too_short", stopId: "class", shortByMin: 3 });
  });
});

describe("the one suggested edit, in a fixed order", () => {
  const dinner = stop("dinner", 75, { fixedStart: "2026-11-14T23:00:00.000Z" }); // 6:00 PM
  const from5 = { window: { startLocal: "2026-11-14T17:00", endLocal: "2026-11-14T22:00" } };
  const edit = (stops: FeasibilityStop[], legs: LegResult[], over: Partial<FeasibilityInput> = from5) => infeasible(validate(plan(stops, legs, over))).suggestion;

  it("first: drop the latest optional stop on the way to the failure", () => {
    const stops = [stop("a", 30, { optional: true }), stop("b", 30, { optional: true }), dinner, stop("late", 20, { optional: true })];
    expect(edit(stops, [ok(10), ok(10), ok(10), ok(5)])).toEqual({ kind: "drop_stop", stopId: "b", verified: false });
  });

  it("with no optional stop: shorten the longest flexible stop, when half of it is enough", () => {
    // Late by 25. The gallery is 60 minutes; 35 is enough and more than half remains.
    expect(edit([stop("gallery", 60), dinner], [ok(10), ok(10)])).toEqual({ kind: "shorten_stop", stopId: "gallery", fromMin: 60, toMin: 35, verified: true });
    // Of two, the longer one; of two the same length, the earlier.
    expect(edit([stop("x", 10), stop("gallery", 50), dinner], [ok(5), ok(5), ok(5)])).toEqual({ kind: "shorten_stop", stopId: "gallery", fromMin: 50, toMin: 30, verified: true });
    expect(edit([stop("x", 40), stop("y", 40), dinner], [ok(5), ok(5), ok(5)], { window: { startLocal: "2026-11-14T16:40", endLocal: "2026-11-14T22:00" } })).toEqual({ kind: "shorten_stop", stopId: "x", fromMin: 40, toMin: 20, verified: true });
  });

  it("when no stop can give up enough: start earlier, in five-minute steps", () => {
    // Late by 25, but the only flexible stop is 40 minutes (half is 20).
    expect(edit([stop("gallery", 40), dinner], [ok(20), ok(20)])).toEqual({ kind: "start_earlier", byMin: 25, startLocal: "2026-11-14T16:35", verified: true });
    // Late by 21 rounds up to 25.
    expect(edit([dinner], [ok(21)], { window: { startLocal: "2026-11-14T17:55", endLocal: "2026-11-14T22:00" } })).toMatchObject({ kind: "start_earlier", byMin: 25 });
  });

  it("an edit that would not clear the failure is not offered: time before an earlier fixed stop cannot help", () => {
    // The class at 5:15 pins the evening. Shortening the walk-up coffee, or leaving home earlier, changes nothing after it.
    const cls = stop("class", 30, { fixedStart: "2026-11-14T22:15:00.000Z" });
    expect(edit([stop("coffee", 60), cls, dinner], [ok(5), ok(5), ok(20)], { window: { startLocal: "2026-11-14T16:00", endLocal: "2026-11-14T22:00" } })).toBeNull();
  });

  it("last: swap two adjacent flexible stops, the pair nearest before the failure", () => {
    const cls = stop("class", 30, { fixedStart: "2026-11-14T22:15:00.000Z" }); // ends 5:45
    // After class: two 10-minute stops and walks make dinner 20 minutes late; half of 10 is not enough and the class pins the start.
    const stops = [cls, stop("a", 10), stop("b", 10), dinner];
    expect(edit(stops, [ok(5), ok(5), ok(5), ok(5)], { window: { startLocal: "2026-11-14T16:00", endLocal: "2026-11-14T22:00" } })).toEqual({ kind: "swap_stops", firstId: "a", secondId: "b", verified: false });
  });

  it("a walking failure is never answered with a time edit", () => {
    expect(edit([stop("far", 30, { optional: true })], [ok(40)])).toEqual({ kind: "drop_stop", stopId: "far", verified: false });
    expect(edit([stop("far", 30)], [ok(40)])).toBeNull();
    // The pair nearest the failing leg: the far stop and the one before it.
    expect(edit([stop("a", 10), stop("b", 10), stop("far", 30)], [ok(5), ok(5), ok(40)])).toEqual({ kind: "swap_stops", firstId: "b", secondId: "far", verified: false });
  });

  it("a window overrun can be answered by shortening the stop that overruns", () => {
    expect(edit([stop("long", 320)], [ok(10)])).toEqual({ kind: "shorten_stop", stopId: "long", fromMin: 320, toMin: 290, verified: true });
  });

  it("is the same answer every time, and reads no clock", () => {
    const input = plan([stop("gallery", 60), dinner], [ok(10), ok(10)], from5);
    const first = validate(input);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-06-01T12:00:00Z"));
    const later = validate(input);
    vi.setSystemTime(new Date("1999-01-01T00:00:00Z"));
    expect(validate(input)).toEqual(first);
    expect(later).toEqual(first);
  });

  it("does not change the plan it is given", () => {
    const freeze = <T,>(v: T): T => {
      if (v && typeof v === "object") Object.values(v).forEach(freeze);
      return Object.freeze(v);
    };
    const input = freeze(plan([stop("gallery", 60, { optional: true }), dinner], [ok(10), ok(10)], from5));
    const before = JSON.stringify(input);
    expect(() => validate(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("input that is not a plan", () => {
  const bad = (over: Partial<FeasibilityInput>, stops = [stop("a", 10)], legs = [ok(5)]) => () => validate(plan(stops, legs, over));
  it("is refused rather than judged", () => {
    expect(bad({ timeZone: "" })).toThrow(FeasibilityInputError);
    expect(bad({ timeZone: "Mars/Olympus" })).toThrow(/unknown time zone/);
    expect(bad({ window: { startLocal: "2026-11-14 16:00", endLocal: "2026-11-14T22:00" } })).toThrow(/window start/);
    expect(bad({ window: { startLocal: "2026-02-30T16:00", endLocal: "2026-03-01T22:00" } })).toThrow(/not a real date/);
    expect(bad({}, [stop("a", 10)], [])).toThrow(/expected 1 legs/);
    expect(bad({}, [stop("a", 10), stop("a", 10)], [ok(5), ok(5)])).toThrow(/unique/);
    expect(bad({}, [stop("a", -5)])).toThrow(/duration/);
    expect(bad({}, [stop("a", 10, { fixedStart: "2026-11-14T18:00" })])).toThrow(/not an instant/);
    expect(bad({}, [stop("a", 10, { hours: [{ opens: "9am", closes: "17:00" }] })])).toThrow(/HH:MM/);
    expect(bad({ maxWalkMin: { perLeg: -1, total: 90 } })).toThrow(/per-leg/);
  });
});

describe("what may be stored: our verdict, never the provider's numbers", () => {
  const dinner = stop("dinner", 75, { fixedStart: "2026-11-14T23:00:00.000Z" });
  const late = validate(plan([stop("gallery", 60), dinner], [ok(10), ok(10)], { window: { startLocal: "2026-11-14T17:00", endLocal: "2026-11-14T22:00" } }));
  const fits = validate(plan([stop("a", 30)], [ok(10)]));
  const timedOut = validate(plan([stop("a", 30)], [unknown("timeout")]));

  it("keeps which constraint failed, where, and our edit; drops every walking number", () => {
    expect(toStoredValidation(late, meta)).toEqual({ status: "infeasible", failing: { kind: "fixed_start_missed", stopId: "dinner" }, suggestion: { kind: "shorten_stop", stopId: "gallery", toMin: 35 }, validatedAt: meta.validatedAt, router: "fake" });
    expect(toStoredValidation(fits, meta)).toEqual({ status: "feasible", validatedAt: meta.validatedAt, router: "fake" });
    expect(toStoredValidation(timedOut, meta)).toEqual({ status: "uncertain", uncertainStopId: "a", validatedAt: meta.validatedAt, router: "fake" });
    const over = validate(plan([stop("a", 10)], [ok(31)]));
    expect(JSON.stringify(toStoredValidation(over, meta))).not.toMatch(/legMin|totalMin|lateByMin|walkMin|seconds|meters|31/);
  });

  it("the validator's own output carries no provider field either", () => {
    for (const r of [late, fits, timedOut]) expect(JSON.stringify(r)).not.toMatch(/"(seconds|meters|geometry|polyline|distance|duration)"/);
  });

  it("a stored verdict with any extra key is refused, at every level", () => {
    const good = toStoredValidation(late, meta);
    expect(storedValidationSchema.safeParse(good).success).toBe(true);
    const injected: unknown[] = [
      { ...good, seconds: 600 },
      { ...good, legs: [{ status: "ok", seconds: 600, meters: 800 }] },
      { ...good, geometry: "u{~vFvyys@fS]" },
      { ...good, failing: { ...good.failing, legMin: 31 } },
      { ...good, suggestion: { ...good.suggestion, route: { duration: 600 } } },
      { ...good, router: "google" },
      { ...good, validatedAt: "yesterday" },
    ];
    for (const value of injected) expect(storedValidationSchema.safeParse(value).success).toBe(false);
  });

  it("a recalculation that could not be made keeps the last verdict as it was, and does not call it fresh", () => {
    const saved = toStoredValidation(fits, { validatedAt: "2026-11-10T15:00:00.000Z", router: "fake" });
    const after = afterRecalculation(saved, timedOut, meta);
    expect(after).toEqual({ validation: saved, fresh: false, failed: "timeout" });
    expect(after.validation.validatedAt).toBe("2026-11-10T15:00:00.000Z");
    // The same for a provider that is not configured.
    expect(afterRecalculation(saved, validate(plan([stop("a", 30)], [unknown("not_configured")])), meta)).toMatchObject({ fresh: false, failed: "not_configured" });
  });

  it("with nothing saved before, the uncertainty itself is the verdict; a real verdict always replaces the old one", () => {
    expect(afterRecalculation(null, timedOut, meta)).toEqual({ validation: { status: "uncertain", uncertainStopId: "a", validatedAt: meta.validatedAt, router: "fake" }, fresh: true, failed: "timeout" });
    const saved = toStoredValidation(fits, { validatedAt: "2026-11-10T15:00:00.000Z", router: "fake" });
    expect(afterRecalculation(saved, late, meta)).toMatchObject({ fresh: true, failed: null, validation: { status: "infeasible", validatedAt: meta.validatedAt } });
    // Unknown opening hours are a real answer about the plan, not a failed check.
    const hours = validate(plan([stop("cafe", 30, { hours: "unknown" })], [ok(10)]));
    expect(afterRecalculation(saved, hours, meta)).toMatchObject({ fresh: true, failed: null, validation: { status: "uncertain", uncertainStopId: "cafe" } });
  });
});
