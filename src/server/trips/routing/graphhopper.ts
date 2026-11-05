import { notConfiguredRouter } from "./adapter";

/**
 * Self-hosted GraphHopper foot profile: the named fallback of decision R-1. A stub: no client is
 * written until the owner chooses it and provides hosting, so every leg is "not_configured" and
 * nothing ever claims a plan fits on it.
 */
export const graphHopperFootRouter = notConfiguredRouter("graphhopper-foot");
