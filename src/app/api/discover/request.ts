import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/server";
import { getRepository, DataError, type DataRepository } from "@/lib/data";
import { discoveryQuerySchema, type DiscoveryQuery } from "@/lib/validation/schemas";

// Results depend on who is asking (locals-only places), so never share them.
const HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Shared plumbing for the discovery endpoints: parse the query string, resolve
 * the viewer and repository, and turn validation failures into 400s.
 */
export async function handleDiscovery(
  req: Request,
  run: (ctx: { query: DiscoveryQuery; repo: DataRepository; viewerId: string | null }) => Promise<unknown>,
) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = discoveryQuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400, headers: HEADERS });
  }
  try {
    const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
    const body = await run({ query: parsed.data, repo, viewerId: viewer?.id ?? null });
    return NextResponse.json(body, { headers: HEADERS });
  } catch (err) {
    if (err instanceof DataError && err.code === "invalid") {
      return NextResponse.json({ error: err.message }, { status: 400, headers: HEADERS });
    }
    throw err;
  }
}

export function filtersOf(query: DiscoveryQuery) {
  return { bounds: query.bbox, text: query.q, category: query.category, tags: query.tags };
}
