import "server-only";
import type Stripe from "stripe";
import type { DataRepository } from "@/lib/data/repository";
import type { Entitlement } from "@/lib/data/types";
import type { StripeLike } from "./stripe";

const ENTITLEMENT_STATUSES = new Set(["active", "trialing", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]);

/** The period end, wherever this API version keeps it. */
function periodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } };
  const end = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/**
 * Applies one verified Stripe event. Every branch is idempotent, so a
 * redelivery (or two deliveries racing) changes nothing; the event id is
 * recorded in stripe_events afterwards. Returns what happened, for logs.
 */
export async function handleStripeEvent(event: Stripe.Event, repo: DataRepository, stripe: StripeLike): Promise<string> {
  let outcome = "ignored";
  let objectId: string | null = null;
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      objectId = s.id;
      if (s.mode === "payment" && s.metadata?.ticket_id) {
        const pi = idOf(s.payment_intent);
        if (!pi) break;
        outcome = await repo.payments.confirmTicket(s.id, pi, s.amount_total ?? -1);
        // A payment through a replaced checkout: give the money back.
        if (outcome === "unknown") await stripe.refunds.create({ payment_intent: pi, reverse_transfer: true }, { idempotencyKey: `refund:session:${s.id}` });
      } else if (s.mode === "subscription" && s.metadata?.user_id && s.customer) {
        await repo.payments.linkCustomer(s.metadata.user_id, idOf(s.customer)!);
        outcome = "customer_linked";
      }
      break;
    }
    case "checkout.session.expired": {
      objectId = event.data.object.id;
      await repo.payments.expireCheckout(event.data.object.id);
      outcome = "expired";
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      objectId = sub.id;
      const userId = sub.metadata?.user_id;
      if (!userId) break;
      const status = (event.type === "customer.subscription.deleted" ? "canceled" : sub.status) as Entitlement["status"];
      if (!ENTITLEMENT_STATUSES.has(status)) break;
      await repo.payments.setEntitlement(userId, status, periodEnd(sub), sub.id);
      outcome = `plan_${status}`;
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object;
      objectId = charge.id;
      const pi = idOf(charge.payment_intent);
      if (pi && charge.refunded) {
        await repo.payments.markRefunded(pi);
        outcome = "refunded";
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      objectId = account.id;
      const userId = account.metadata?.user_id;
      if (userId) {
        await repo.payments.setHostAccount(userId, account.id, !!account.charges_enabled);
        outcome = "payouts_updated";
      }
      break;
    }
  }
  const fresh = await repo.payments.recordStripeEvent(event.id, event.type, objectId);
  return fresh ? outcome : `duplicate:${outcome}`;
}
