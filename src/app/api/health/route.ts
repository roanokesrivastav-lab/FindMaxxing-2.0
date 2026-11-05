import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";

export const dynamic = "force-dynamic";

/**
 * Liveness and database reachability for uptime checks. Says only "ok" or
 * "unavailable": no versions, hosts, timings or error text.
 */
export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    if (getDataMode() === "supabase") {
      const { createSupabaseStatelessClient } = await import("@/lib/supabase/admin");
      // A one-row read of a public reference table, as anon, with a timeout.
      const { error } = await createSupabaseStatelessClient()
        .from("categories")
        .select("slug", { head: true, count: "exact" })
        .limit(1)
        .abortSignal(AbortSignal.timeout(3000));
      if (error) throw new Error(error.message);
    } else {
      const { getDemoStore } = await import("@/lib/data/demo/store");
      if (!Array.isArray(getDemoStore().state.places)) throw new Error("demo store unreadable");
    }
    return NextResponse.json({ status: "ok" }, { headers });
  } catch (err) {
    reportError(err, { where: "health" });
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  }
}
