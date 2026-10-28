import { NextResponse } from "next/server";
import { z } from "zod";
import { featureEnabled } from "@/lib/config";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DataError } from "@/lib/data/types";
import { INTEREST_MAP } from "@/lib/data/taxonomy";
import { planTrip, type PlanEvent } from "@/server/trips/planner";

export const dynamic = "force-dynamic";
// Planning runs a multi-step agent; allow it the time it needs.
export const maxDuration = 120;

const requestSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    vibe: z.string().trim().max(300).default(""),
    interests: z.array(z.string()).max(8).default([]).transform((xs) => xs.filter((x) => x in INTEREST_MAP)),
    budget: z.enum(["free", "low", "medium", "high"]).default("low"),
    startPoint: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().max(80) }),
  })
  .refine((r) => new Date(r.end).getTime() > new Date(r.start).getTime(), { message: "The window must end after it starts" })
  .refine((r) => new Date(r.end).getTime() - new Date(r.start).getTime() <= 3 * 86_400_000, { message: "Plan up to three days at a time" });

/**
 * POST /api/trip-plan: streams the planner's progress and result as
 * newline-delimited JSON (`{"type":"status"|"plan"|"error",…}`). Signed-in
 * only, behind the tripPlanning flag (which also needs ANTHROPIC_API_KEY),
 * and limited to 10 plans a day per person.
 */
export async function POST(req: Request) {
  if (!featureEnabled("tripPlanning")) return new NextResponse(null, { status: 404 });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in to plan a trip" }, { status: 401 });
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const repo = await getRepository();
  try {
    await repo.limits.consume(viewer.id, "trip_plans");
  } catch (err) {
    if (err instanceof DataError) return NextResponse.json({ error: err.message }, { status: err.code === "rate_limited" ? 429 : 403 });
    throw err;
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: PlanEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      send({ type: "status", text: "Starting" });
      const plan = await planTrip(repo, viewer.id, parsed.data, send);
      controller.close();
      // In case they left the page while it worked (best effort).
      if (plan && featureEnabled("notifications")) await repo.notifications.tripPlanReady(viewer.id, plan.title).catch(() => {});
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
