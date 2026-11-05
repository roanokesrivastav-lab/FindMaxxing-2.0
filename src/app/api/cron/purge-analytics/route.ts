import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";
import { requireCronSecret } from "@/server/http/cronAuth";

export const dynamic = "force-dynamic";

/**
 * Daily retention job (vercel.json crons): deletes analytics events older than
 * 180 days, and interaction-log impressions and views older than 365. Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else
 * is refused. Idempotent: running it twice deletes nothing the second time.
 *
 * Also drops expired abuse counters (0040 purge_server_abuse). Each call is
 * bounded to ABUSE_PURGE_BATCH rows; because this job is daily, it repeats up
 * to ABUSE_PURGE_MAX_BATCHES times while full batches keep coming back.
 */
const ABUSE_PURGE_BATCH = 10_000;
const ABUSE_PURGE_MAX_BATCHES = 20;
export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return new NextResponse(null, { status: 401 });
  }
  try {
    let deleted = 0;
    let interactions = 0;
    let abuse = 0;
    if (getDataMode() === "supabase") {
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const { data, error } = await createSupabaseAdminClient().rpc("purge_analytics", { p_keep_days: 180 });
      if (error) throw new Error(error.message);
      deleted = Number(data ?? 0);
      const purged = await createSupabaseAdminClient().rpc("purge_user_interactions", { p_keep_days: 365 });
      if (purged.error) throw new Error(purged.error.message);
      interactions = Number(purged.data ?? 0);
      for (let i = 0; i < ABUSE_PURGE_MAX_BATCHES; i++) {
        const batch = await createSupabaseAdminClient().rpc("purge_server_abuse", { p_limit: ABUSE_PURGE_BATCH });
        if (batch.error) throw new Error(batch.error.message);
        const n = Number(batch.data ?? 0);
        abuse += n;
        if (n < ABUSE_PURGE_BATCH) break;
      }
    } else {
      const { getDemoStore } = await import("@/lib/data/demo/store");
      const { purgeDemoAnalytics } = await import("@/lib/data/demo/analytics");
      const { purgeDemoInteractions } = await import("@/lib/data/demo/interactions");
      const { purgeDemoAbuse } = await import("@/lib/data/demo/abuse");
      const store = getDemoStore();
      deleted = purgeDemoAnalytics(store, 180);
      interactions = purgeDemoInteractions(store.state, 365);
      if (interactions) store.persist();
      abuse = purgeDemoAbuse(store);
    }
    return NextResponse.json({ deleted, interactions, abuse });
  } catch (err) {
    reportError(err, { where: "cron:purge-analytics" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
