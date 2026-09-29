import { describe, it, expect } from "vitest";
import { addedLabel } from "../src/lib/utils/recent";

const NOW = Date.UTC(2026, 8, 18, 12); // Sep 18 2026, noon UTC
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("addedLabel", () => {
  it("labels today, yesterday and older days", () => {
    expect(addedLabel(daysAgo(0), NOW)).toBe("Added today");
    expect(addedLabel(daysAgo(1), NOW)).toBe("Added yesterday");
    expect(addedLabel(daysAgo(5), NOW)).toBe("Added 5 days ago");
  });
});
