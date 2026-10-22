import "server-only";
import { after } from "next/server";
import { featureEnabled } from "@/lib/config";
import { getViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import type { InteractionInput } from "@/lib/data/types";
import { reportError } from "@/lib/observability";
import { browserSaysNo } from "./analytics";

/**
 * Appends rows to the signed-in viewer's private interaction log
 * (0031_user_interactions.sql), for the recommender to learn from later.
 *
 * Only while recommendations are on, and never when the browser (DNT, GPC) or
 * the person (the analytics opt-out) said no; the database applies the
 * opt-out again. "hide" is not passive tracking but the person's own choice,
 * so Not interested goes through hideItemAction instead of this.
 *
 * The write runs after the response is sent, so logging never slows the
 * action down, and it never throws.
 */
export async function recordInteractions(rows: InteractionInput[]): Promise<void> {
  const passive = rows.filter((r) => r.action !== "hide");
  if (!passive.length || !featureEnabled("recommendations")) return;
  try {
    if (await browserSaysNo()) return;
    const viewer = await getViewer();
    if (!viewer) return;
    const repo = await getRepository();
    if (await repo.analytics.optedOut(viewer.id)) return;
    const write = async () => {
      try {
        await repo.interactions.log(viewer.id, passive);
      } catch (err) {
        reportError(err, { where: "interactions", count: passive.length });
      }
    };
    try {
      after(write);
    } catch {
      // Outside a request (scripts, tests): write now.
      await write();
    }
  } catch (err) {
    reportError(err, { where: "interactions", count: passive.length });
  }
}
