import "server-only";
import { headers } from "next/headers";
import { featureEnabled } from "@/lib/config";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import type { AnalyticsEventName } from "@/lib/data/types";
import { forwardEvent, forwardingEnabled } from "@/lib/analytics/forward";
import { reportError } from "@/lib/observability";

/** Do Not Track or Global Privacy Control on this request. */
export async function browserSaysNo(): Promise<boolean> {
  try {
    const h = await headers();
    return h.get("dnt") === "1" || h.get("sec-gpc") === "1";
  } catch {
    return false;
  }
}

/**
 * Records a product event for the signed-in user, when analytics is switched
 * on and neither the browser (DNT, GPC) nor the user (settings) said no. The
 * database applies the opt-out again and rate-limits. Never throws: analytics
 * must not break the action that triggered it.
 */
export async function track(name: AnalyticsEventName, props: Record<string, string | number | boolean | null> = {}): Promise<void> {
  if (!featureEnabled("analytics")) return;
  try {
    if (await browserSaysNo()) return;
    const viewer = await getViewer();
    if (!viewer) return;
    const repo = await getRepository();
    if (await repo.analytics.optedOut(viewer.id)) return;
    await repo.analytics.track(viewer.id, name, props);
    if (forwardingEnabled()) await forwardEvent(viewer.id, name, props);
  } catch (err) {
    reportError(err, { where: "analytics", event: name });
  }
}
