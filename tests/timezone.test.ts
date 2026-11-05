import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { combineDateTime } from "../packages/shared/src/validation";
import {
  eventHasEnded,
  formatEventDate,
  formatEventWhen,
  formatTimeRange,
  relativeDayLabel,
  toDateInputValue,
  toTimeInputValue,
} from "../src/lib/utils/format";
import {
  calendarDayDiff,
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  startOfNextDay,
  zonedTimeToUtc,
  zoneOffsetMinutes,
} from "../src/lib/utils/timezone";

const NY = { timeZone: "America/New_York" };
const LA = { timeZone: "America/Los_Angeles" };
const at = (iso: string) => Date.parse(iso);

describe("server and browser render the same date text", () => {
  // Regression for React error 418: the server ran in UTC and the browser in
  // the viewer's zone, so the same component rendered different text.
  it("renders identical HTML whatever zone the process runs in", () => {
    const render = (tz: string) =>
      execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/render-dates.tsx"], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      });
    const outputs = ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago"].map(render);
    for (const out of outputs) expect(out).toBe(outputs[0]);
    const parsed = JSON.parse(outputs[0]);
    expect(parsed.when).toBe("Thu, Oct 22 · 7:24 PM – 9:00 PM EDT");
    expect(parsed.day).toBe("Tomorrow");
    expect(parsed.input).toEqual(["2026-10-22", "19:24"]);
    expect(parsed.html).toContain("7:24 PM – 9:00 PM EDT");
    expect(parsed.html).toContain("Oct 22, 7:24 PM EDT");
  }, 60_000);

  it("formats the instant from the release notes in the zone asked for, not the runtime's", () => {
    const iso = "2026-10-22T23:24:00Z";
    expect(formatEventWhen(iso, null, NY)).toBe("Thu, Oct 22 · 7:24 PM EDT");
    expect(formatEventWhen(iso, null, LA)).toBe("Thu, Oct 22 · 4:24 PM PDT");
    expect(formatEventWhen(iso, null, { timeZone: "UTC" })).toBe("Thu, Oct 22 · 11:24 PM UTC");
    expect(formatEventDate(iso, { timeZone: "Asia/Tokyo" })).toBe("Fri, Oct 23");
  });

  it("defaults to the launch city's zone", () => {
    expect(DEFAULT_TIME_ZONE).toBe("America/New_York");
  });
});

describe("time zone labels", () => {
  it("labels standard and daylight time", () => {
    expect(formatTimeRange("2026-07-01T22:00:00Z", "2026-07-02T00:00:00Z", NY)).toBe("6:00 PM – 8:00 PM EDT");
    expect(formatTimeRange("2026-12-01T23:00:00Z", null, NY)).toBe("6:00 PM EST");
  });

  it("labels both ends when a range straddles the fall-back change", () => {
    // 1:30 AM EDT, then 1:30 AM EST an hour later on 2026-11-01.
    expect(formatTimeRange("2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", NY)).toBe("1:30 AM EDT – 1:30 AM EST");
  });

  it("handles half- and quarter-hour offsets", () => {
    expect(formatTimeRange("2026-10-22T12:00:00Z", null, { timeZone: "Asia/Kolkata" })).toBe("5:30 PM GMT+5:30");
    expect(formatTimeRange("2026-10-22T12:00:00Z", null, { timeZone: "Asia/Kathmandu" })).toBe("5:45 PM GMT+5:45");
  });
});

describe("relative day labels at midnight boundaries", () => {
  it("uses the viewer's calendar day, not the runtime's", () => {
    // 11:59 PM in New York; the event is two minutes later, just past midnight.
    const now = at("2026-10-22T03:59:00Z");
    const event = "2026-10-22T04:01:00Z";
    expect(relativeDayLabel(event, { ...NY, now })).toBe("Tomorrow");
    // Same instants in LA are 8:59 PM and 9:01 PM on the same day.
    expect(relativeDayLabel(event, { ...LA, now })).toBe("Today");
    // In Tokyo both fall on the afternoon of Oct 22.
    expect(relativeDayLabel(event, { timeZone: "Asia/Tokyo", now })).toBe("Today");
  });

  it("treats a started event earlier today as today and yesterday's as past", () => {
    const now = at("2026-10-22T16:00:00Z"); // noon in New York
    expect(relativeDayLabel("2026-10-22T13:00:00Z", { ...NY, now })).toBe("Today");
    expect(relativeDayLabel("2026-10-22T03:59:00Z", { ...NY, now })).toBe("Past");
  });

  it("counts weekdays and longer gaps in calendar days", () => {
    const now = at("2026-10-22T16:00:00Z"); // Thu
    expect(relativeDayLabel("2026-10-24T16:00:00Z", { ...NY, now })).toBe("Sat");
    expect(relativeDayLabel("2026-10-29T16:00:00Z", { ...NY, now })).toBe("In 7 days");
  });

  it("is exact across the spring-forward day (23 hours long)", () => {
    // Sat 2026-03-07 11:30 PM EST → Sun 2026-03-08 11:30 PM EDT is 23 hours.
    const now = at("2026-03-08T04:30:00Z");
    expect(relativeDayLabel("2026-03-09T03:30:00Z", { ...NY, now })).toBe("Tomorrow");
    expect(calendarDayDiff(now, at("2026-03-09T03:30:00Z"), NY.timeZone)).toBe(1);
    // Just after midnight Monday EDT is two calendar days away.
    expect(relativeDayLabel("2026-03-09T04:05:00Z", { ...NY, now })).toBe("Mon");
  });

  it("is exact across the fall-back day (25 hours long)", () => {
    // Sat 2026-10-31 12:30 AM EDT → Sun 2026-11-01 11:30 PM EST is 48 real
    // hours yet one calendar day; 12:05 AM Monday is two.
    const now = at("2026-10-31T04:30:00Z");
    expect(relativeDayLabel("2026-11-02T04:30:00Z", { ...NY, now })).toBe("Tomorrow");
    expect(relativeDayLabel("2026-11-02T05:05:00Z", { ...NY, now })).toBe("Mon");
    expect(calendarDayDiff(at("2026-10-25T16:00:00Z"), at("2026-11-08T17:00:00Z"), NY.timeZone)).toBe(14);
  });

  it("handles zones on either side of the date line", () => {
    const now = at("2026-10-22T09:30:00Z");
    // Kiritimati (UTC+14) is already on Oct 22 11:30 PM; Pago Pago (UTC-11) on Oct 21 10:30 PM.
    expect(relativeDayLabel("2026-10-22T10:30:00Z", { timeZone: "Pacific/Kiritimati", now })).toBe("Tomorrow");
    expect(relativeDayLabel("2026-10-22T10:30:00Z", { timeZone: "Pacific/Pago_Pago", now })).toBe("Today");
  });
});

describe("start of the viewer's next day", () => {
  it("finds local midnight, including on DST days", () => {
    expect(startOfNextDay(at("2026-10-22T16:00:00Z"), NY.timeZone).toISOString()).toBe("2026-10-23T04:00:00.000Z");
    expect(startOfNextDay(at("2026-03-08T16:00:00Z"), NY.timeZone).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfNextDay(at("2026-11-01T16:00:00Z"), NY.timeZone).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(startOfNextDay(at("2026-10-22T09:30:00Z"), "Pacific/Kiritimati").toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });
});

describe("event form date/time conversion", () => {
  it("converts wall-clock inputs to UTC in the given zone", () => {
    expect(zonedTimeToUtc("2026-10-22", "19:24", NY.timeZone).toISOString()).toBe("2026-10-22T23:24:00.000Z");
    expect(zonedTimeToUtc("2026-12-05", "18:00", NY.timeZone).toISOString()).toBe("2026-12-05T23:00:00.000Z");
    expect(zonedTimeToUtc("2026-10-22", "12:00", "Asia/Kathmandu").toISOString()).toBe("2026-10-22T06:15:00.000Z");
  });

  it("resolves the spring-forward gap and fall-back overlap predictably", () => {
    // 2:30 AM does not exist on 2026-03-08 in New York; it becomes 3:30 AM EDT.
    expect(zonedTimeToUtc("2026-03-08", "02:30", NY.timeZone).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 1:30 AM happens twice on 2026-11-01; the first (EDT) wins.
    expect(zonedTimeToUtc("2026-11-01", "01:30", NY.timeZone).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("sends the offset in force on the event's date, not today's", () => {
    // Created in October (EDT, 240) for a December evening (EST, 300).
    const startsAt = zonedTimeToUtc("2026-12-05", "18:00", NY.timeZone);
    const offset = zoneOffsetMinutes(startsAt, NY.timeZone);
    expect(offset).toBe(300);
    expect(zoneOffsetMinutes(at("2026-10-19T16:00:00Z"), NY.timeZone)).toBe(240);
    expect(combineDateTime("2026-12-05", "18:00", "20:00", offset).startsAt.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    // The previous behaviour (today's offset) saved it an hour early.
    expect(combineDateTime("2026-12-05", "18:00", null, 240).startsAt.toISOString()).toBe("2026-12-05T22:00:00.000Z");
  });

  it("round-trips through the input value helpers", () => {
    const iso = at("2026-11-01T05:30:00Z");
    expect([toDateInputValue(iso, NY), toTimeInputValue(iso, NY)]).toEqual(["2026-11-01", "01:30"]);
    expect([toDateInputValue(iso, LA), toTimeInputValue(iso, LA)]).toEqual(["2026-10-31", "22:30"]);
    expect([toDateInputValue(at("2026-10-22T04:00:00Z"), NY), toTimeInputValue(at("2026-10-22T04:00:00Z"), NY)]).toEqual(["2026-10-22", "00:00"]);
  });
});

describe("event end checks", () => {
  it("compares against the supplied clock", () => {
    expect(eventHasEnded("2026-10-22T20:00:00Z", "2026-10-22T22:00:00Z", at("2026-10-22T21:59:59Z"))).toBe(false);
    expect(eventHasEnded("2026-10-22T20:00:00Z", "2026-10-22T22:00:00Z", at("2026-10-22T22:00:01Z"))).toBe(true);
    expect(eventHasEnded("2026-10-22T20:00:00Z", null, at("2026-10-22T20:00:01Z"))).toBe(true);
  });
});

describe("time zone cookie validation", () => {
  it("accepts real IANA zones only", () => {
    expect(normalizeTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    for (const bad of [null, undefined, "", "Mars/Olympus", "America/New_York; Path=/", "<script>", "x".repeat(65)]) {
      expect(normalizeTimeZone(bad)).toBeNull();
    }
  });
});
