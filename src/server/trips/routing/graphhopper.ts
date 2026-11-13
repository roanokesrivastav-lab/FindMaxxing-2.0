/**
 * GraphHopper (foot profile), the named fallback in 6.0 decision R-1.
 *
 * A stub on purpose. Self-hosting it is an owner decision (a server, map data, upkeep), and nothing
 * deploys or calls one. Until that exists this router answers "not configured" for every leg, so a
 * setting that selects it can never make a plan look checked.
 */
import { unknownLegs, type WalkingRouter } from "./types";

export function createGraphhopperFootRouter(): WalkingRouter {
  return { id: "graphhopper-foot", legs: async (points) => unknownLegs(points.length - 1, "not_configured") };
}
