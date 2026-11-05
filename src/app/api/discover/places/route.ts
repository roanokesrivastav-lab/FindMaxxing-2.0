import { filtersOf, handleDiscovery } from "../request";

/**
 * GET /api/discover/places?bbox=&q=&category=&tags=&neighborhood=&createdAfter=&near=lat,lng&limit=&cursor=
 * — a page of full place records, newest first, or nearest first with `near`.
 */
export function GET(req: Request) {
  return handleDiscovery(req, ({ query, repo, viewerId }) =>
    repo.places.search({ ...filtersOf(query), near: query.near, limit: query.limit, cursor: query.cursor, viewerId }),
  );
}
