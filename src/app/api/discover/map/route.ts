import { filtersOf, handleDiscovery } from "../request";

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
    return { places, events };
  });
}
