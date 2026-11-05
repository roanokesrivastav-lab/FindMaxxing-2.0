import { redirect } from "next/navigation";
import { forYouPlaces } from "@/server/recommendations";
import { ForYouRail } from "@/components/recommendations/ForYouRail";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { INTEREST_MAP } from "@/lib/data/taxonomy";
import { DEFAULT_CENTER, featureEnabled } from "@/lib/config";
import { ExploreClient } from "@/components/explore/ExploreClient";
import { MAP_INTEREST_LIMIT } from "@/lib/onboarding/interests";
import { interestPresence } from "@/lib/explore/arrival";
import { approximateBounds, parseExploreState } from "@/lib/explore/urlState";
import { DEFAULT_ZOOM } from "@/lib/config";
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
  const tags = typeof sp.tags === "string" ? sp.tags.split(",").filter((t) => t in INTEREST_MAP).slice(0, MAP_INTEREST_LIMIT) : [];
  const pilotExplore = featureEnabled("pilotExplore");
  // Roadmap 2.2: camera, filters, selection and view come back from the URL (pilotExplore only).
  const urlState = pilotExplore ? parseExploreState(sp) : null;
  const request: DiscoveryRequest = urlState
    ? {
        bounds: urlState.q ? null : urlState.camera ? approximateBounds(urlState.camera, DEFAULT_ZOOM) : INITIAL_REQUEST.bounds,
        text: urlState.q,
        category: urlState.category,
        tags: urlState.tags,
        kind: urlState.kind,
      }
    : { ...INITIAL_REQUEST, tags };
  const filters = urlState
    ? { bounds: request.bounds, text: request.text || null, category: request.category, tags: request.tags, viewerId }
    : { bounds: request.bounds, tags, viewerId };
  const selectedQuery = urlState?.sel
    ? urlState.sel.kind === "place"
      ? repo.places.get(urlState.sel.id, viewerId).then((item) => (item ? { kind: "place" as const, item } : null))
      : repo.events.get(urlState.sel.id, viewerId).then((item) => (item ? { kind: "event" as const, item } : null))
    : null;
  const welcome = sp.welcome === "1" && !!viewer;
  const pilotFoundation = featureEnabled("pilotFoundation");
  // Roadmap 1.3: the first visit after onboarding gets per-interest counts for its first area.
  const arrivalQuery = welcome && pilotFoundation && tags.length && request.bounds
    ? interestPresence(repo, { bounds: request.bounds, tags, category: null, kind: "all", viewerId })
    : null;
  const kind = request.kind;
  const [placeMarkers, eventMarkers, places, events, forYou, arrival, initialSelected] = await Promise.all([
    kind === "events" ? null : repo.places.mapMarkers(filters),
    kind === "places" ? null : repo.events.mapMarkers(filters),
    kind === "events" ? { items: [], nextCursor: null } : repo.places.search({ ...filters, limit: PLACE_PAGE }),
    kind === "places" ? { items: [], nextCursor: null } : repo.events.search({ ...filters, limit: EVENT_PAGE }),
    forYouPlaces(repo, viewer),
    arrivalQuery,
    selectedQuery,
  ]);
  return (
    <ExploreClient
      initial={{ placeMarkers, eventMarkers, places, events }}
      initialRequest={request}
      welcome={welcome}
      pilotFoundation={pilotFoundation}
      pilotExplore={pilotExplore}
      urlState={urlState}
      initialSelected={initialSelected}
      arrival={arrival}
      forYou={<ForYouRail places={forYou} />}
      logImpressions={!!viewer && featureEnabled("recommendations")}
      ads={featureEnabled("ads") && !(viewer && (await repo.payments.isPlus(viewer.id)))}
      viewer={viewer ? { displayName: viewer.profile.displayName, avatarUrl: viewer.profile.avatarUrl, interests: viewer.profile.interests } : null}
    />
  );
}
