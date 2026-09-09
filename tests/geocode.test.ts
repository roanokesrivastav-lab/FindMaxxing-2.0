import { describe, it, expect } from "vitest";
import {
  bboxFromNominatim,
  buildAddressQuery,
  mapMapbox,
  mapNominatim,
  shortLabel,
  zoomForBbox,
} from "../src/lib/map/geocode";

describe("buildAddressQuery", () => {
  it("joins the parts that are present and drops the rest", () => {
    expect(buildAddressQuery(["1210 Oak St", null, "Columbus"])).toBe("1210 Oak St, Columbus");
    expect(buildAddressQuery([" ", undefined, ""])).toBe("");
    expect(buildAddressQuery(["  Oak St  ", "Columbus"])).toBe("Oak St, Columbus");
  });
});

describe("mapNominatim", () => {
  // Shape captured from a real response for "1210 Oak St, Columbus, Ohio".
  const row = {
    lat: "39.9626937",
    lon: "-82.9681181",
    display_name: "1210, Oak Street, Olde Towne East, Columbus, Franklin County, Ohio, 43205, United States",
    boundingbox: ["39.9626437", "39.9627438", "-82.9681681", "-82.9680681"],
  };

  it("maps a house-number match, converting the bounding box order", () => {
    const [result] = mapNominatim([row]);
    expect(result.lat).toBeCloseTo(39.9626937, 6);
    expect(result.lng).toBeCloseTo(-82.9681181, 6);
    // Nominatim gives [south, north, west, east]; we use [west, south, east, north].
    expect(result.bbox).toEqual([-82.9681681, 39.9626437, -82.9680681, 39.9627438]);
  });

  it("skips rows without usable coordinates and tolerates junk", () => {
    expect(mapNominatim([{ lat: "abc", lon: "1" }, row])).toHaveLength(1);
    expect(mapNominatim([])).toEqual([]);
    expect(mapNominatim(null)).toEqual([]);
    expect(mapNominatim({ nope: true })).toEqual([]);
  });

  it("returns a null bbox when the field is malformed", () => {
    expect(bboxFromNominatim(["1", "2"])).toBeNull();
    expect(bboxFromNominatim("nope")).toBeNull();
    expect(bboxFromNominatim(undefined)).toBeNull();
  });
});

describe("mapMapbox", () => {
  it("maps features and their optional bbox", () => {
    const body = {
      features: [
        { center: [-82.97, 39.96], place_name: "1210 Oak St, Columbus", bbox: [-83, 39.9, -82.9, 40] },
        { center: [-83.01, 40.03], place_name: "Clintonville, Columbus" },
        { place_name: "no center" },
      ],
    };
    const results = mapMapbox(body);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ lat: 39.96, lng: -82.97, bbox: [-83, 39.9, -82.9, 40] });
    expect(results[1].bbox).toBeNull();
  });

  it("tolerates a body with no features", () => {
    expect(mapMapbox({})).toEqual([]);
    expect(mapMapbox(null)).toEqual([]);
  });
});

describe("zoomForBbox", () => {
  it("zooms close for a street address and stays wide for a neighborhood", () => {
    // Real bounding boxes: a house is ~0.0001 deg across, Clintonville ~0.06.
    const house = zoomForBbox([-82.9681681, 39.9626437, -82.9680681, 39.9627438]);
    const neighborhood = zoomForBbox([-83.0349443, 40.0180576, -82.9968077, 40.0769684]);
    expect(house).toBeGreaterThan(neighborhood);
    expect(house).toBe(17);
    expect(neighborhood).toBeLessThanOrEqual(14);
  });

  it("falls back to a usable zoom with no bbox", () => {
    expect(zoomForBbox(null)).toBe(16);
  });
});

describe("shortLabel", () => {
  it("trims a long provider label to its first segments", () => {
    expect(
      shortLabel("1210, Oak Street, Olde Towne East, Columbus, Franklin County, Ohio, 43205, United States"),
    ).toBe("1210, Oak Street, Olde Towne East");
    expect(shortLabel("Columbus")).toBe("Columbus");
  });
});
