import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

/** Hourly (vercel.json crons): recomputes every reputation level. Bearer CRON_SECRET only. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new NextResponse(null, { status: 401 });
  try {
    let refreshed = 0;
    if (getDataMode() === "supabase") {
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const { data, error } = await createSupabaseAdminClient().rpc("refresh_all_reputation");
      if (error) throw new Error(error.message);
      refreshed = Number(data ?? 0);
    } else {
      const { createDemoRepository } = await import("@/lib/data/demo/repository");
      refreshed = await createDemoRepository().reputation.refreshAll();
    }
    return NextResponse.json({ refreshed });
  } catch (err) {
    reportError(err, { where: "cron:refresh-reputation" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
