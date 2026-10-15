import { NextResponse } from "next/server";
import { getDataMode, paymentsMode } from "@/lib/config";
import { reportError } from "@/lib/observability";
import { getStripe, processRefunds } from "@/server/payments/stripe";
import { serviceRepository } from "@/server/serviceRepository";
import { resumeAccountDeletions } from "@/server/accountDeletionJobs";

export const dynamic = "force-dynamic";

/**
 * Every 15 minutes (vercel.json crons): asks Stripe to refund tickets waiting
 * for one. Bearer CRON_SECRET only; safe to retry (idempotency keys). In demo
 * mode the "refund" is recorded at once: no money ever moved.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new NextResponse(null, { status: 401 });
  const mode = paymentsMode();
  try {
    const deletions = await resumeAccountDeletions();
    if (!mode && getDataMode() !== "supabase") return NextResponse.json({ requested: 0, failed: 0, deletions });
    const repo = await serviceRepository();
    await repo.ads.endFinished();
    if (mode === "demo") {
      const due = await repo.payments.ticketsToRefund();
      for (const t of due) await repo.payments.markRefunded(t.paymentIntentId);
      return NextResponse.json({ requested: due.length, failed: 0, deletions });
    }
    const stripe = await getStripe();
    if (!stripe) return NextResponse.json({ requested: 0, failed: (await repo.payments.ticketsToRefund()).length, deletions });
    return NextResponse.json({ ...await processRefunds(repo, stripe), deletions });
  } catch (err) {
    reportError(err, { where: "cron:payments" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
