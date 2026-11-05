import { NextResponse } from "next/server";
import { featureEnabled } from "@/lib/config";
import { interestPresence } from "@/lib/explore/arrival";
import { handleDiscovery } from "../request";

/**
 * GET /api/discover/presence?bbox=&tags=&category=&kind= — per interest, how many records match here and
 * in a bigger area (roadmap 1.3, pilotFoundation). Counts come from the full authorized set.
 */
export function GET(req: Request) {
  if (!featureEnabled("pilotFoundation")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return handleDiscovery(req, async ({ query, repo, viewerId }) => {
    if (!query.bbox) return { interests: [] };
    return { interests: await interestPresence(repo, { bounds: query.bbox, tags: query.tags, category: query.category, kind: query.kind, viewerId }) };
  });
}
