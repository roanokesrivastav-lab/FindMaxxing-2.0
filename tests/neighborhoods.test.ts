import { describe, it, expect } from "vitest";
import type { NeighborhoodSummary } from "../src/lib/data/types";
import { findNeighborhood, neighborhoodHref, neighborhoodKey } from "../src/lib/utils/neighborhoods";

function summary(name: string): NeighborhoodSummary {
  return { key: neighborhoodKey(name), name, city: "Columbus", placeCount: 1, topCategories: [], lat: 0, lng: 0 };
}

describe("neighborhood helpers", () => {
  it("normalises case and whitespace in keys", () => {
    expect(neighborhoodKey("  Short   North ")).toBe("short north");
    expect(neighborhoodKey("SHORT NORTH")).toBe(neighborhoodKey("short north"));
  });

  it("builds encoded hrefs", () => {
    expect(neighborhoodHref("Short North")).toBe("/neighborhoods/Short%20North");
    expect(neighborhoodHref(" German Village ")).toBe("/neighborhoods/German%20Village");
  });

  it("finds a neighborhood from a decoded url segment regardless of case", () => {
    const groups = [summary("Short North"), summary("Clintonville")];
    expect(findNeighborhood(groups, "short north")?.name).toBe("Short North");
    expect(findNeighborhood(groups, decodeURIComponent("Short%20North"))?.name).toBe("Short North");
    expect(findNeighborhood(groups, "  CLINTONVILLE ")?.name).toBe("Clintonville");
    expect(findNeighborhood(groups, "Nowhere")).toBeNull();
  });
});
