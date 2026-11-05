import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { paymentsMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { PLUS_MONTHLY_PRICE, formatPrice } from "@/lib/data/payments";
import { DemoCheckout } from "@/components/payments/DemoCheckout";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "Demo checkout" };
export const dynamic = "force-dynamic";

/** The fake checkout of demo mode. It exists only there, and says so. */
export default async function DemoCheckoutPage({ searchParams }: PageProps<"/checkout/demo">) {
  if (paymentsMode() !== "demo") notFound();
  const sp = await searchParams;
  const viewer = await requireViewer("/checkout/demo");
  const ticketId = typeof sp.ticket === "string" ? sp.ticket : null;
  const plan = sp.plan === "plus" || sp.plan === "manage" ? sp.plan : null;
  const repo = await getRepository();
  const ticket = ticketId ? (await repo.payments.myTickets(viewer.id)).find((t) => t.id === ticketId && t.status === "pending") : null;
  const campaign = typeof sp.campaign === "string" ? (await repo.ads.mine(viewer.id)).find((c) => c.id === sp.campaign && c.status === "awaiting_payment") : null;
  if (campaign) {
    return (
      <div className="max-w-md mx-auto px-4 pt-8 pb-nav md:pb-10">
        <div role="note" className="rounded-2xl border-2 border-dashed border-pulse bg-pulse-50 px-4 py-3 text-sm flex gap-2">
          <FlaskConical size={18} className="text-pulse shrink-0 mt-0.5" />
          <span><b>Demo checkout.</b> This is demo mode: nothing is charged and no money moves. With Stripe set up, this step is Stripe Checkout.</span>
        </div>
        <div className="card p-5 mt-4">
          <h1 className="text-xl font-bold">Sponsored card: {campaign.headline}</h1>
          <p className="text-2xl font-bold mt-2">{formatPrice(campaign.budgetCents)}</p>
          <p className="text-sm text-muted mt-1">About {campaign.impressionBudget.toLocaleString("en-US")} views.</p>
          <DemoCheckout kind="campaign" campaignId={campaign.id} />
        </div>
      </div>
    );
  }
  if (!ticket && !plan) notFound();
  return (
    <div className="max-w-md mx-auto px-4 pt-8 pb-nav md:pb-10">
      <div role="note" className="rounded-2xl border-2 border-dashed border-pulse bg-pulse-50 px-4 py-3 text-sm flex gap-2">
        <FlaskConical size={18} className="text-pulse shrink-0 mt-0.5" />
        <span><b>Demo checkout.</b> This is demo mode: nothing is charged, no card is asked for, and no money moves. With Stripe set up, this step is Stripe Checkout.</span>
      </div>
      <div className="card p-5 mt-4">
        <h1 className="text-xl font-bold">{ticket ? `Ticket: ${ticket.eventTitle ?? "Event"}` : plan === "plus" ? "FindMaxxing Plus" : "Your Plus plan"}</h1>
        <p className="text-2xl font-bold mt-2">{ticket ? formatPrice(ticket.amountCents, ticket.currency) : `${PLUS_MONTHLY_PRICE} a month`}</p>
        {ticket ? <p className="text-sm text-muted mt-1">Your spot is held until <LocalDate value={ticket.expiresAt} format={{ hour: "numeric", minute: "2-digit" }} zone />.</p> : null}
        <DemoCheckout kind={ticket ? "ticket" : plan!} ticketId={ticket?.id} eventId={ticket?.eventId} />
      </div>
    </div>
  );
}
