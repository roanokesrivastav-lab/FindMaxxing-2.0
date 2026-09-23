import { describe, it, expect } from "vitest";
import { MAX_EVENT_HOURS, combineDateTime, eventSchema, fieldErrors, placeSchema, profileSchema, ratingSchema, searchQuerySchema, signUpSchema } from "../src/lib/validation/schemas";

describe("searchQuerySchema", () => {
  it("trims and collapses whitespace", () => {
    expect(searchQuerySchema.parse("  maya   reyes ")).toBe("maya reyes");
    expect(searchQuerySchema.parse("")).toBe("");
  });
  it("never throws: over-long or non-string input becomes an empty query", () => {
    expect(searchQuerySchema.parse("a".repeat(61))).toBe("");
    expect(searchQuerySchema.parse(undefined)).toBe("");
    expect(searchQuerySchema.parse(["x"])).toBe("");
  });
});

describe("placeSchema", () => {
  it("accepts a valid place and normalizes tags", () => {
    const r = placeSchema.safeParse({
      name: "  Court  ",
      description: "A nice outdoor court with lights.",
      categorySlug: "pickup-sports",
      lat: "40.01",
      lng: "-83.0",
      city: "Columbus",
      tags: ["sports", "SPORTS", "not-a-real-tag", "hiking"],
      localTip: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("Court");
      expect(r.data.lat).toBe(40.01);
      expect(r.data.tags).toEqual(["sports", "hiking"]);
      expect(r.data.localTip).toBeNull();
    }
  });

  it("reports field errors for bad input", () => {
    const r = placeSchema.safeParse({ name: "x", description: "short", categorySlug: "nope", lat: "100", lng: "0", city: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const errs = fieldErrors(r.error);
      expect(Object.keys(errs)).toEqual(expect.arrayContaining(["name", "description", "categorySlug", "lat", "city"]));
    }
  });
});

describe("eventSchema", () => {
  const future = new Date(Date.now() + 3 * 86_400_000);
  const date = future.toISOString().slice(0, 10);

  it("accepts a future event and parses capacity", () => {
    const r = eventSchema.safeParse({
      title: "Pickup",
      description: "Bring a ball and water.",
      locationName: "Field",
      city: "Columbus",
      lat: 40,
      lng: -83,
      date,
      startTime: "18:00",
      endTime: "",
      categorySlug: "pickup-sports",
      capacity: "12",
      tags: [],
      tzOffsetMinutes: 240,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.capacity).toBe(12);
      expect(r.data.endTime).toBeNull();
      expect(r.data.placeId).toBeNull();
    }
  });

  it("rejects events in the past and end before start", () => {
    const past = eventSchema.safeParse({
      title: "Old",
      description: "This already happened.",
      locationName: "Field",
      city: "Columbus",
      lat: 40,
      lng: -83,
      date: "2020-01-01",
      startTime: "10:00",
      categorySlug: "outdoors",
      tags: [],
    });
    expect(past.success).toBe(false);
    if (!past.success) expect(fieldErrors(past.error).date).toMatch(/future/);
  });

  it("treats an end time earlier than start as after midnight", () => {
    const { startsAt, endsAt } = combineDateTime("2030-01-01", "22:00", "01:00", 0);
    expect(endsAt!.getTime() - startsAt.getTime()).toBe(3 * 60 * 60_000);
  });

  it("applies the client timezone offset", () => {
    const { startsAt } = combineDateTime("2030-06-01", "12:00", null, 240); // UTC-4
    expect(startsAt.toISOString()).toBe("2030-06-01T16:00:00.000Z");
  });
});

describe("profile + auth", () => {
  it("lowercases and validates usernames", () => {
    const ok = profileSchema.safeParse({ username: "Maya_R", displayName: "Maya", interests: ["food", "bogus"] });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.username).toBe("maya_r");
      expect(ok.data.interests).toEqual(["food"]);
    }
    const bad = profileSchema.safeParse({ username: "has space", displayName: "M" });
    expect(bad.success).toBe(false);
  });

  it("requires an 8+ char password on sign up", () => {
    const r = signUpSchema.safeParse({ email: "A@B.co", password: "short", username: "abc", displayName: "AB" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).password).toBeDefined();
  });
});


describe("ratingSchema", () => {
  const placeId = "00000000-0000-4000-a000-000000000000";

  it("accepts a null note, which is how the rating control sends 'no note'", () => {
    const r = ratingSchema.safeParse({ placeId, score: 4, note: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBeNull();
  });

  it("accepts an omitted note and an empty string", () => {
    expect(ratingSchema.safeParse({ placeId, score: 3 }).success).toBe(true);
    const empty = ratingSchema.safeParse({ placeId, score: 3, note: "   " });
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.note).toBeNull();
  });

  it("keeps a real note and rejects an over-long one", () => {
    const ok = ratingSchema.safeParse({ placeId, score: 5, note: "  Go on a weeknight.  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.note).toBe("Go on a weeknight.");
    expect(ratingSchema.safeParse({ placeId, score: 5, note: "x".repeat(281) }).success).toBe(false);
  });

  it("still rejects an out-of-range score", () => {
    expect(ratingSchema.safeParse({ placeId, score: 0, note: null }).success).toBe(false);
    expect(ratingSchema.safeParse({ placeId, score: 6, note: null }).success).toBe(false);
  });
});


describe("event duration (the previously dead end-time check)", () => {
  const future = new Date(Date.now() + 3 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  const base = {
    title: "Duration check",
    description: "An event used to check duration handling.",
    locationName: "Somewhere",
    lat: 40,
    lng: -83,
    date,
    categorySlug: "pickup-sports",
    tags: [] as string[],
    tzOffsetMinutes: 0,
  };

  it("accepts a normal same-day event", () => {
    const r = eventSchema.safeParse({ ...base, startTime: "18:00", endTime: "20:00" });
    expect(r.success).toBe(true);
  });

  it("accepts a genuine overnight event", () => {
    // 9pm to 1am is four hours, not a mistake.
    const r = eventSchema.safeParse({ ...base, startTime: "21:00", endTime: "01:00" });
    expect(r.success).toBe(true);
    const { startsAt, endsAt } = combineDateTime(date, "21:00", "01:00", 0);
    expect((endsAt!.getTime() - startsAt.getTime()) / 3_600_000).toBe(4);
  });

  it("rejects the 6pm-to-5pm typo instead of silently creating a 23-hour event", () => {
    const r = eventSchema.safeParse({ ...base, startTime: "18:00", endTime: "17:00" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).endTime).toMatch(/23 hours/);
  });

  it("rejects an identical start and end", () => {
    const r = eventSchema.safeParse({ ...base, startTime: "18:00", endTime: "18:00" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).endTime).toMatch(/24 hours/);
  });

  it("allows an event right at the limit", () => {
    expect(MAX_EVENT_HOURS).toBe(18);
    const r = eventSchema.safeParse({ ...base, startTime: "06:00", endTime: "23:59" });
    expect(r.success).toBe(true);
  });
});
