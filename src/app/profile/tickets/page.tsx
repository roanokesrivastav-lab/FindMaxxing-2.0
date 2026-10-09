import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { paymentsMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { formatPrice } from "@/lib/data/payments";
import type { TicketStatus } from "@/lib/data/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

export const metadata: Metadata = { title: "Tickets" };
export const dynamic = "force-dynamic";

const STATUS: Record<TicketStatus, string> = {
  pending: "Checking out",
  paid: "Paid",
  expired: "Not completed",
  refund_pending: "Refund on its way",
  refunded: "Refunded",
};

export default async function TicketsPage() {
  if (!paymentsMode()) notFound();
  const viewer = await requireViewer("/profile/tickets");
  const tickets = await (await getRepository()).payments.myTickets(viewer.id);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="You" title="Tickets" />
      {tickets.length === 0 ? (
        <EmptyState emoji="🎟️" title="No tickets yet" body="Tickets you buy for events show up here." />
      ) : (
        <ul className="card divide-y divide-line" aria-label="Tickets">
          {tickets.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1 min-w-0">
                {t.eventId ? <Link href={`/events/${t.eventId}`} className="font-semibold truncate block">{t.eventTitle ?? "Event"}</Link> : <span className="font-semibold block">Event no longer listed</span>}
                <span className="text-xs text-muted">{STATUS[t.status]} · {new Date(t.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              </span>
              <span className="font-semibold">{formatPrice(t.amountCents, t.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
