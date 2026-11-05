"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/data/payments";
import type { TicketSummary } from "@/lib/data/types";
import { hostPayoutsAction, setEventPriceAction } from "@/server/actions/payments";

/** The host's ticket panel: price (before anyone else is going), sales, and payouts. */
export function EventPricing({ eventId, priceCents, summary, canSell, locked, demo }: {
  eventId: string; priceCents: number | null; summary: TicketSummary | null; canSell: boolean; locked: boolean; demo: boolean;
}) {
  const [price, setPrice] = useState(priceCents ? String(priceCents / 100) : "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const save = (dollars: number | null) =>
    start(async () => {
      const res = await setEventPriceAction(eventId, dollars);
      if (!res.ok) toast(res.error, "error");
      else {
        toast(dollars === null ? "The event is free" : `Tickets are ${formatPrice(Math.round(dollars * 100))}`, "success");
        router.refresh();
      }
    });
  return (
    <section className="card p-4 mt-3" aria-labelledby="tickets-heading">
      <h2 id="tickets-heading" className="font-bold">Tickets</h2>
      {summary && priceCents ? (
        <p className="text-sm text-ink-2 mt-1">
          {summary.paid} sold · {formatPrice(summary.revenueCents)}{summary.pending ? ` · ${summary.pending} checking out` : ""}{summary.refunded ? ` · ${summary.refunded} refunded` : ""}
        </p>
      ) : null}
      {!canSell ? (
        <div className="mt-2 text-sm">
          <p className="text-muted">Set up payouts with Stripe to sell tickets.</p>
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => start(async () => {
            const res = await hostPayoutsAction();
            if (res.ok) window.location.assign(res.data.url);
            else toast(res.error, "error");
          })}>Set up payouts</Button>
        </div>
      ) : locked ? (
        <p className="text-sm text-muted mt-1">The price is fixed now that people are going.</p>
      ) : (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); save(price.trim() ? Number(price) : null); }}>
          <label className="text-sm font-semibold flex flex-col gap-1">
            Price (USD)
            <input id="ticket-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Free" className="h-10 w-32 rounded-xl border border-line bg-surface px-3" />
          </label>
          <Button type="submit" variant="ink" size="sm" loading={pending}>Save price</Button>
          {priceCents ? <Button type="button" variant="ghost" size="sm" onClick={() => save(null)}>Make it free</Button> : null}
          <p className="basis-full text-xs text-muted">$1 to $500. You go free. {demo ? "Demo mode: checkout is simulated and no money moves." : "Refunds are automatic if you cancel."}</p>
        </form>
      )}
    </section>
  );
}
