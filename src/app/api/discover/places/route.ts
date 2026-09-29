import { filtersOf, handleDiscovery } from "../request";

/** GET /api/discover/places?bbox=&q=&category=&tags=&neighborhood=&createdAfter=&limit=&cursor= — a page of full place records. */
export function GET(req: Request) {
  return handleDiscovery(req, ({ query, repo, viewerId }) =>
    repo.places.search({ ...filtersOf(query), limit: query.limit, cursor: query.cursor, viewerId }),
  );
}
