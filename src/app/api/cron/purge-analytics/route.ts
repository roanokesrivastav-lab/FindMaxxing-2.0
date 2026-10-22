import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Daily retention job (vercel.json crons): deletes analytics events older than
 * 180 days, and interaction-log impressions and views older than 365. Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else
 * is refused. Idempotent: running it twice deletes nothing the second time.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse(null, { status: 401 });
  }
  try {
    let deleted = 0;
    let interactions = 0;
    if (getDataMode() === "supabase") {
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const { data, error } = await createSupabaseAdminClient().rpc("purge_analytics", { p_keep_days: 180 });
      if (error) throw new Error(error.message);
      deleted = Number(data ?? 0);
      const purged = await createSupabaseAdminClient().rpc("purge_user_interactions", { p_keep_days: 365 });
      if (purged.error) throw new Error(purged.error.message);
      interactions = Number(purged.data ?? 0);
    } else {
      const { getDemoStore } = await import("@/lib/data/demo/store");
      const { purgeDemoAnalytics } = await import("@/lib/data/demo/analytics");
      const { purgeDemoInteractions } = await import("@/lib/data/demo/interactions");
      const store = getDemoStore();
      deleted = purgeDemoAnalytics(store, 180);
      interactions = purgeDemoInteractions(store.state, 365);
      if (interactions) store.persist();
    }
    return NextResponse.json({ deleted, interactions });
  } catch (err) {
    reportError(err, { where: "cron:purge-analytics" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
