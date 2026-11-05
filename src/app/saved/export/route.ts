import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, getSiteUrl } from "@/lib/config";
import { exportRows, toCsv } from "@/lib/places/library";

export const dynamic = "force-dynamic";

/**
 * Roadmap 3.2: export the viewer's own library as CSV or JSON. Owner only: it reads
 * the signed-in viewer's saves and nobody else's; there is no user parameter.
 */
export async function GET(request: Request) {
  if (!featureEnabled("pilotLibrary")) return new Response("Not found", { status: 404 });
  const viewer = await getViewer();
  if (!viewer) return new Response("Sign in to export your saves", { status: 401 });
  const format = new URL(request.url).searchParams.get("format") === "json" ? "json" : "csv";
  const repo = await getRepository();
  const [items, lists] = await Promise.all([repo.saves.library(viewer.id), repo.savedLists.list(viewer.id)]);
  const rows = exportRows(items, new Map(lists.map((l) => [l.id, l.name])), getSiteUrl());
  const day = new Date().toISOString().slice(0, 10);
  const headers = {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="findmaxxing-saves-${day}.${format}"`,
    "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
  };
  return new Response(format === "json" ? JSON.stringify({ exportedAt: new Date().toISOString(), saves: rows }, null, 2) : toCsv(rows), { headers });
}
