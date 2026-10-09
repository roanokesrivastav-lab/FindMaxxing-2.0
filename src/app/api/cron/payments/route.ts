import { NextResponse } from "next/server";
import { paymentsMode } from "@/lib/config";
import { reportError } from "@/lib/observability";
import { getStripe, processRefunds } from "@/server/payments/stripe";
import { serviceRepository } from "@/server/serviceRepository";

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
  if (!mode) return NextResponse.json({ requested: 0, failed: 0 });
  try {
    const repo = await serviceRepository();
    if (mode === "demo") {
      const due = await repo.payments.ticketsToRefund();
      for (const t of due) await repo.payments.markRefunded(t.paymentIntentId);
      return NextResponse.json({ requested: due.length, failed: 0 });
    }
    const stripe = await getStripe();
    if (!stripe) return NextResponse.json({ requested: 0, failed: 0 });
    return NextResponse.json(await processRefunds(repo, stripe));
  } catch (err) {
    reportError(err, { where: "cron:payments" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
