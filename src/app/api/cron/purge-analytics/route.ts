import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Daily retention job (vercel.json crons): deletes analytics events older than
 * 180 days. Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else
 * is refused. Idempotent: running it twice deletes nothing the second time.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }
  try {
    let deleted = 0;
    if (getDataMode() === "supabase") {
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const { data, error } = await createSupabaseAdminClient().rpc("purge_analytics", { p_keep_days: 180 });
      if (error) throw new Error(error.message);
      deleted = Number(data ?? 0);
    } else {
      const { getDemoStore } = await import("@/lib/data/demo/store");
      const { purgeDemoAnalytics } = await import("@/lib/data/demo/analytics");
      deleted = purgeDemoAnalytics(getDemoStore(), 180);
    }
    return NextResponse.json({ deleted });
  } catch (err) {
    reportError(err, { where: "cron:purge-analytics" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
