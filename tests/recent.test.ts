import { describe, it, expect } from "vitest";
import { addedLabel, newestWithin } from "../src/lib/utils/recent";

const NOW = Date.UTC(2026, 8, 18, 12); // Sep 18 2026, noon UTC
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("newestWithin", () => {
  it("keeps only items inside the window, newest first", () => {
    const items = [
      { id: "old", createdAt: daysAgo(8) },
      { id: "mid", createdAt: daysAgo(3) },
      { id: "fresh", createdAt: daysAgo(0) },
      { id: "edge", createdAt: daysAgo(7) },
    ];
    expect(newestWithin(items, 7, NOW).map((i) => i.id)).toEqual(["fresh", "mid", "edge"]);
  });
  it("returns [] when nothing is recent", () => {
    expect(newestWithin([{ createdAt: daysAgo(30) }], 7, NOW)).toEqual([]);
  });
});

describe("addedLabel", () => {
  it("labels today, yesterday and older days", () => {
    expect(addedLabel(daysAgo(0), NOW)).toBe("Added today");
    expect(addedLabel(daysAgo(1), NOW)).toBe("Added yesterday");
    expect(addedLabel(daysAgo(5), NOW)).toBe("Added 5 days ago");
  });
});
