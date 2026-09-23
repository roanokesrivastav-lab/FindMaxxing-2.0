import { describe, it, expect } from "vitest";
import type { Place } from "../src/lib/data/types";
import { findNeighborhood, groupByNeighborhood, neighborhoodHref, neighborhoodKey } from "../src/lib/utils/neighborhoods";

function place(over: Partial<Place>): Place {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    name: "x",
    description: "",
    localTip: null,
    categorySlug: "food",
    lat: 0,
    lng: 0,
    address: null,
    neighborhood: null,
    city: "Columbus",
    creatorId: null,
    creator: null,
    ratingAvg: 0,
    ratingCount: 0,
    tags: [],
    photos: [],
    status: "published",
    visibility: "public",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
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

  it("groups places, merges spelling variants, and sorts biggest first", () => {
    const groups = groupByNeighborhood([
      place({ neighborhood: "Short North", categorySlug: "food", lat: 1, lng: 1 }),
      place({ neighborhood: "short north", categorySlug: "food", lat: 3, lng: 3 }),
      place({ neighborhood: "Short North ", categorySlug: "nightlife", lat: 2, lng: 2 }),
      place({ neighborhood: "Clintonville", categorySlug: "outdoors" }),
      place({ neighborhood: null }),
      place({ neighborhood: "   " }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Short North", "Clintonville"]);
    expect(groups[0].places).toHaveLength(3);
    expect(groups[0].topCategories).toEqual(["food", "nightlife"]);
    expect(groups[0].lat).toBe(2);
    expect(groups[0].lng).toBe(2);
  });

  it("ties on size break alphabetically", () => {
    const groups = groupByNeighborhood([place({ neighborhood: "Olde Towne East" }), place({ neighborhood: "Franklinton" })]);
    expect(groups.map((g) => g.name)).toEqual(["Franklinton", "Olde Towne East"]);
  });

  it("finds a group from a decoded url segment regardless of case", () => {
    const groups = groupByNeighborhood([place({ neighborhood: "Short North" })]);
    expect(findNeighborhood(groups, "short north")?.name).toBe("Short North");
    expect(findNeighborhood(groups, decodeURIComponent("Short%20North"))?.name).toBe("Short North");
    expect(findNeighborhood(groups, "Nowhere")).toBeNull();
  });
});
