import { filtersOf, handleDiscovery } from "../request";

/** GET /api/discover/events?bbox=&q=&category=&tags=&includePast=&limit=&cursor= — a page of full event records. */
export function GET(req: Request) {
  return handleDiscovery(req, ({ query, repo, viewerId }) =>
    repo.events.search({ ...filtersOf(query), includePast: query.includePast, limit: query.limit, cursor: query.cursor, viewerId }),
  );
}
