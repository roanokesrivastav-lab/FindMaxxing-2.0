import { redirect } from "next/navigation";
import { forYouPlaces } from "@/server/recommendations";
import { ForYouRail } from "@/components/recommendations/ForYouRail";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { INTEREST_MAP } from "@/lib/data/taxonomy";
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

export default async function ExplorePage({ searchParams }: PageProps<"/">) {
  const [repo, viewer, sp] = await Promise.all([getRepository(), getViewer(), searchParams]);
  // First run happens once, before the map.
  if (viewer && !viewer.profile.onboardedAt) redirect("/welcome");
  const viewerId = viewer?.id ?? null;
  // Onboarding lands here with the chosen interests as the starting filter.
  const tags = typeof sp.tags === "string" ? sp.tags.split(",").filter((t) => t in INTEREST_MAP).slice(0, 8) : [];
  const request: DiscoveryRequest = { ...INITIAL_REQUEST, tags };
  const filters = { bounds: request.bounds, tags, viewerId };
  const [placeMarkers, eventMarkers, places, events, forYou] = await Promise.all([
    repo.places.mapMarkers(filters),
    repo.events.mapMarkers(filters),
    repo.places.search({ ...filters, limit: PLACE_PAGE }),
    repo.events.search({ ...filters, limit: EVENT_PAGE }),
    forYouPlaces(repo, viewer),
  ]);
  return (
    <ExploreClient
      initial={{ placeMarkers, eventMarkers, places, events }}
      initialRequest={request}
      welcome={sp.welcome === "1" && !!viewer}
      forYou={<ForYouRail places={forYou} />}
      viewer={viewer ? { displayName: viewer.profile.displayName, avatarUrl: viewer.profile.avatarUrl, interests: viewer.profile.interests } : null}
    />
  );
}
