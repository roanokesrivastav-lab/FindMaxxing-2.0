import { filtersOf, handleDiscovery } from "../request";
import { track } from "@/server/analytics";

/**
 * GET /api/discover/map?bbox=&q=&category=&tags=&kind=&limit= — compact map
 * records for places and events. Capped per kind, with a `truncated` flag
 * rather than a cursor: paging pins would make dense areas look empty.
 */
export function GET(req: Request) {
  return handleDiscovery(req, async ({ query, repo, viewerId }) => {
    const opts = { ...filtersOf(query), limit: query.limit, includePast: query.includePast, viewerId };
    const [places, events] = await Promise.all([
      query.kind === "events" ? null : repo.places.mapMarkers(opts),
      query.kind === "places" ? null : repo.events.mapMarkers(opts),
    ]);
    // Explore asks for pins once per search, so this counts each empty search once.
    if (query.q && !places?.items.length && !events?.items.length) await track("search_no_results", { kind: query.kind });
    return { places, events };
  });
}
