import { NextResponse } from "next/server";
import { getDataMode } from "@/lib/config";
import { reportError } from "@/lib/observability";
import { getStripe } from "@/server/payments/stripe";
import { handleStripeEvent } from "@/server/payments/webhook";
import { serviceRepository } from "@/server/serviceRepository";

export const dynamic = "force-dynamic";

/**
 * POST /api/stripe/webhook. Only with Stripe configured (404 otherwise). The
 * signature is checked against STRIPE_WEBHOOK_SECRET over the raw body before
 * anything is read. The handler retains the event ID for processing logs.
 */
export async function POST(req: Request) {
  // Turning off purchases must not disable refunds/closure of existing billing.
  if (getDataMode() !== "supabase") return new NextResponse(null, { status: 404 });
  const stripe = await getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get("stripe-signature");
  if (!stripe || !secret) return new NextResponse(null, { status: 404 });
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  const body = await req.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }
  try {
    const outcome = await handleStripeEvent(event, await serviceRepository(), stripe);
    return NextResponse.json({ received: true, outcome });
  } catch (err) {
    reportError(err, { where: "stripe-webhook", type: event.type });
    // A 500 makes Stripe deliver it again later.
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
