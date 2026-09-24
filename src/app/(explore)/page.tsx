import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { DEFAULT_CENTER } from "@/lib/config";
import { ExploreClient } from "@/components/explore/ExploreClient";
import { EVENT_PAGE, PLACE_PAGE, type DiscoveryRequest } from "@/components/explore/discoveryRequest";

export const dynamic = "force-dynamic";

// Roughly the default viewport at DEFAULT_ZOOM. It only seeds the first paint;
// the client re-queries with the real bounds as soon as the map loads.
const INITIAL_REQUEST: DiscoveryRequest = {
  bounds: { north: DEFAULT_CENTER.lat + 0.07, south: DEFAULT_CENTER.lat - 0.07, east: DEFAULT_CENTER.lng + 0.12, west: DEFAULT_CENTER.lng - 0.12 },
  text: "",
  category: null,
  tags: [],
  kind: "all",
};

export default async function ExplorePage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const viewerId = viewer?.id ?? null;
  const filters = { bounds: INITIAL_REQUEST.bounds, viewerId };
  const [placeMarkers, eventMarkers, places, events] = await Promise.all([
    repo.places.mapMarkers(filters),
    repo.events.mapMarkers(filters),
    repo.places.search({ ...filters, limit: PLACE_PAGE }),
    repo.events.search({ ...filters, limit: EVENT_PAGE }),
  ]);
  return (
    <ExploreClient
      initial={{ placeMarkers, eventMarkers, places, events }}
      initialRequest={INITIAL_REQUEST}
      viewer={viewer ? { displayName: viewer.profile.displayName, avatarUrl: viewer.profile.avatarUrl, interests: viewer.profile.interests } : null}
    />
  );
}
