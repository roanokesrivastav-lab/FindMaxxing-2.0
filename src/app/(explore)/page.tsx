import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { ExploreClient } from "@/components/explore/ExploreClient";

export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const viewerId = viewer?.id ?? null;
  const [places, events] = await Promise.all([repo.places.list({ limit: 500, viewerId }), repo.events.list({ limit: 200, viewerId })]);
  return (
    <ExploreClient
      places={places}
      events={events}
      viewer={viewer ? { displayName: viewer.profile.displayName, avatarUrl: viewer.profile.avatarUrl, interests: viewer.profile.interests } : null}
    />
  );
}
