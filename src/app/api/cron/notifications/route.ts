import { NextResponse } from "next/server";
import { pushTransportReady, getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";
import { requireCronSecret } from "@/server/http/cronAuth";
import type { DataRepository } from "@/lib/data/repository";
import { combinedSender, expoPushSender, runNotificationJobs, webPushSender } from "@/server/notifications/push";

export const dynamic = "force-dynamic";

/**
 * Every 15 minutes (vercel.json crons): session decisions, event reminders, then pending pushes;
 * once a day it also applies retention. Bearer CRON_SECRET only. Safe to
 * retry: reminders are deduplicated and pushes are claimed before sending.
 */
export async function GET(req: Request) {
  if (!requireCronSecret(req)) return new NextResponse(null, { status: 401 });
  try {
    let repo: DataRepository;
    if (getDataMode() === "supabase") {
      const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
      const { createSupabaseRepository } = await import("@/lib/data/supabase/repository");
      repo = createSupabaseRepository(createSupabaseAdminClient());
    } else {
      const { createDemoRepository } = await import("@/lib/data/demo/repository");
      repo = createDemoRepository();
    }
    const now = new Date();
    // Browsers need the push flag and VAPID keys; the mobile app's devices go through Expo.
    const sender = combinedSender(pushTransportReady("web") ? await webPushSender() : null,
      pushTransportReady("expo") ? expoPushSender() : null);
    // Sessions past their decision deadline (roadmap 4.3) are decided first, so
    // the people affected are told in this same run.
    const decided = await repo.events.decideSessions(now.toISOString());
    const result = await runNotificationJobs(repo, sender, now.toISOString());
    // Retention once a day, on the first run after 04:00 UTC.
    const purged = now.getUTCHours() === 4 && now.getUTCMinutes() < 15 ? await repo.notifications.purge(now.toISOString()) : 0;
    return NextResponse.json({ ...result, decided, purged });
  } catch (err) {
    reportError(err, { where: "cron:notifications" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
