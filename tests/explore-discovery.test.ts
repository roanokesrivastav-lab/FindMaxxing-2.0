import { describe, it, expect } from "vitest";
import { bboxParam, normalizeViewportBounds, sameBounds } from "../src/lib/map/bounds";
import { discoveryQuery, requestKey, type DiscoveryRequest } from "../src/components/explore/discoveryRequest";
import { validateBounds } from "../src/lib/data/discovery";
import { discoveryQuerySchema } from "../src/lib/validation/schemas";

describe("viewport bounds", () => {
  it("passes an ordinary viewport through, rounded", () => {
    expect(normalizeViewportBounds({ north: 40.0412345, south: 39.9, east: -82.9, west: -83.1 })).toEqual({
      north: 40.0412, south: 39.9, east: -82.9, west: -83.1,
    });
  });

  it("wraps longitudes from a repeated world into an antimeridian box", () => {
    const b = normalizeViewportBounds({ north: 10, south: -10, east: 190, west: 170 });
    expect(b).toEqual({ north: 10, south: -10, east: -170, west: 170 });
    expect(validateBounds(b)).toEqual(b);
  });

  it("covers the world when the viewport is wider than it", () => {
    expect(normalizeViewportBounds({ north: 85, south: -85, east: 400, west: -300 })).toEqual({ north: 85, south: -85, east: 180, west: -180 });
  });

  it("always produces bounds the API accepts", () => {
    for (const [west, east] of [[-540, -500], [179.99, 180.01], [-180.5, -179.5], [0, 359.9], [-200, 10]]) {
      const b = normalizeViewportBounds({ north: 91, south: -91, east, west });
      expect(() => validateBounds(b), `${west},${east}`).not.toThrow();
      expect(discoveryQuerySchema.safeParse({ bbox: bboxParam(b) }).success).toBe(true);
    }
  });

  it("treats sub-rounding jitter as the same viewport", () => {
    const a = normalizeViewportBounds({ north: 40.000001, south: 39.9, east: -82.9, west: -83.1 });
    const b = normalizeViewportBounds({ north: 40.000002, south: 39.9, east: -82.9, west: -83.1 });
    expect(sameBounds(a, b)).toBe(true);
  });
});

describe("discovery request", () => {
  const base: DiscoveryRequest = { bounds: { north: 1, south: 0, east: 1, west: 0 }, text: "tacos", category: null, tags: ["food", "coffee"], kind: "all" };

  it("keys equivalent requests identically, so they do not refetch", () => {
    expect(requestKey({ ...base, text: " tacos ", tags: ["coffee", "food"] })).toBe(requestKey(base));
    expect(requestKey({ ...base, bounds: null })).not.toBe(requestKey(base));
  });

  it("builds a query string the endpoint schema accepts", () => {
    const params = Object.fromEntries(new URLSearchParams(discoveryQuery(base, { limit: 30, cursor: null })));
    expect(params).toEqual({ bbox: "0,0,1,1", q: "tacos", tags: "food,coffee", limit: "30" });
    expect(discoveryQuerySchema.safeParse(params).success).toBe(true);
  });

  it("accepts createdAfter, startsBefore and neighborhood, and rejects malformed ones", () => {
    const parsed = discoveryQuerySchema.safeParse({
      neighborhood: " Short North ",
      createdAfter: "2026-09-21T00:00:00.000Z",
      startsBefore: "2026-10-01T04:00:00.000Z",
    });
    expect(parsed.success && parsed.data.neighborhood).toBe("Short North");
    for (const key of ["createdAfter", "startsBefore"]) {
      for (const bad of ["yesterday", "2026-02-30T00:00:00Z", "2026-13-01", "1e9", "2026-09-21T00:00:00Z'; drop table places; --"]) {
        expect(discoveryQuerySchema.safeParse({ [key]: bad }).success, `${key}=${bad}`).toBe(false);
      }
    }
    expect(discoveryQuerySchema.safeParse({ neighborhood: "x".repeat(81) }).success).toBe(false);
  });
});
