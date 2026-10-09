import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { paymentsMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { PLUS_MONTHLY_PRICE, formatPrice } from "@/lib/data/payments";
import { DemoCheckout } from "@/components/payments/DemoCheckout";

export const metadata: Metadata = { title: "Demo checkout" };
export const dynamic = "force-dynamic";

/** The fake checkout of demo mode. It exists only there, and says so. */
export default async function DemoCheckoutPage({ searchParams }: PageProps<"/checkout/demo">) {
  if (paymentsMode() !== "demo") notFound();
  const sp = await searchParams;
  const viewer = await requireViewer("/checkout/demo");
  const ticketId = typeof sp.ticket === "string" ? sp.ticket : null;
  const plan = sp.plan === "plus" || sp.plan === "manage" ? sp.plan : null;
  const ticket = ticketId ? (await (await getRepository()).payments.myTickets(viewer.id)).find((t) => t.id === ticketId && t.status === "pending") : null;
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
        {ticket ? <p className="text-sm text-muted mt-1">Your spot is held until {new Date(ticket.expiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.</p> : null}
        <DemoCheckout kind={ticket ? "ticket" : plan!} ticketId={ticket?.id} eventId={ticket?.eventId} />
      </div>
    </div>
  );
}
