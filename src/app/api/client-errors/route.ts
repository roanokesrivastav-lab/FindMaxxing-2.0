import { NextResponse } from "next/server";
import { z } from "zod";
import { reportError } from "@/lib/observability";
import { createMemoryLimiter } from "@/lib/rateLimits";
import { clientIp } from "@/server/http/clientIp";

// A broken page can loop; one client may report at most 30 errors a minute.
const limiter = createMemoryLimiter({ max: 30, windowSeconds: 60 });

const reportSchema = z.object({
  message: z.string().max(500),
  digest: z.string().max(100).nullable().optional(),
  path: z.string().max(300),
});

/** Receives error-boundary reports from the browser. */
export async function POST(request: Request) {
  if (limiter.consume(await clientIp()) !== null) return new NextResponse(null, { status: 429 });
  const parsed = reportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const { message, digest, path } = parsed.data;
  reportError(Object.assign(new Error(message), { name: "ClientError" }), { where: "client", digest: digest ?? undefined, path: path.split("?")[0] });
  return new NextResponse(null, { status: 204 });
}
