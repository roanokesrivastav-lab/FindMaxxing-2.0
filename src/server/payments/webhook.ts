import "server-only";
import type Stripe from "stripe";
import type { DataRepository, StripePlanSnapshot } from "@/lib/data/repository";
import type { StripeLike } from "./stripe";
import { cancelSubscription } from "./stripe";
import { reconcileSubscription } from "./reconcileSubscription";
import { stripeUserId } from "./metadata";

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/**
 * Claims a verified delivery before processing. Completed duplicates do no work;
 * busy/failed work throws so Stripe retries. Subscription reads are serialized
 * by user, with fenced plan application and event completion in one transaction.
 */
export async function handleStripeEvent(event: Stripe.Event, repo: DataRepository, stripe: StripeLike): Promise<string> {
  const object = event.data.object as unknown as { id: string; mode?: string; metadata?: { user_id?: string } };
  const subscriptionWork = event.type.startsWith("customer.subscription.")
    || (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && object.mode === "subscription");
  const scopedUser = subscriptionWork ? stripeUserId(object.metadata) ?? null : null;
  const claim = await repo.payments.claimStripeEvent(event.id, event.type, object.id ?? null, scopedUser);
  if (claim.state === "complete") return `duplicate:${claim.outcome}`;
  if (claim.state === "busy") throw new Error("Stripe event processing is busy; retry delivery");
  try {
    const result = await applyStripeEvent(event, repo, stripe);
    await repo.payments.finishStripeEvent(event.id, claim.token, result.outcome, result.plan);
    return result.outcome;
  } catch (err) {
    await repo.payments.releaseStripeEvent(event.id, claim.token).catch(() => undefined);
    throw err;
  }
}

async function applyStripeEvent(event: Stripe.Event, repo: DataRepository, stripe: StripeLike): Promise<{ outcome: string; plan?: StripePlanSnapshot }> {
  let outcome = "ignored";
  const object = event.data.object as unknown as { id: string; metadata?: { user_id?: string }; subscription?: string | { id: string } | null; status?: string };
  const userId = stripeUserId(object.metadata);
  if (userId && ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "account.updated", "checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
      && await repo.payments.isClosing(userId)) {
    if (event.type.startsWith("customer.subscription.") && event.type !== "customer.subscription.deleted"
      && !await cancelSubscription(stripe, object.id, userId, true)) return { outcome: "subscription_unrelated" };
    const subscriptionId = event.type.startsWith("checkout.session.") ? idOf(object.subscription) : null;
    if (subscriptionId && !await cancelSubscription(stripe, subscriptionId, userId, true)) return { outcome: "subscription_unrelated" };
    // Payment-mode ticket/campaign completions still need their refund path.
    const paymentCompletion = event.type.startsWith("checkout.session.") && (event.data.object as { mode?: string }).mode === "payment";
    if (!paymentCompletion) {
      return { outcome: "account_closed" };
    }
  }
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object;
      // Checkout completion is not payment settlement. These products require
      // a positive payment; no_payment_required is not valid fulfillment here.
      if (s.mode === "payment" && s.payment_status !== "paid") return { outcome: "unpaid" };
      const amount = s.currency === "usd" ? s.amount_total ?? -1 : -1;
      if (s.mode === "payment" && s.metadata?.campaign_id) {
        if (!idOf(s.payment_intent)) throw new Error("Paid campaign checkout has no payment intent");
        outcome = `campaign_${await repo.ads.activate(s.id, amount)}`;
        const pi = idOf(s.payment_intent);
        // Paid for something that cannot run (a replaced checkout, a different amount): refund it.
        if (pi && (outcome === "campaign_unknown" || outcome === "campaign_mismatch")) {
          await stripe.refunds.create({ payment_intent: pi }, { idempotencyKey: `refund:campaign:${s.id}` });
        }
      } else if (s.mode === "payment" && s.metadata?.ticket_id) {
        const pi = idOf(s.payment_intent);
        if (!pi) throw new Error("Paid ticket checkout has no payment intent");
        outcome = await repo.payments.confirmTicket(s.id, pi, amount);
        // A payment through a replaced checkout: give the money back.
        if (outcome === "unknown") await stripe.refunds.create({ payment_intent: pi, reverse_transfer: true }, { idempotencyKey: `refund:session:${s.id}` });
      } else if (s.mode === "subscription" && userId) {
        const subscriptionId = idOf(s.subscription);
        if (!subscriptionId) throw new Error("Completed subscription checkout has no subscription");
        const plan = await reconcileSubscription(stripe, repo, userId, subscriptionId);
        return plan ? { outcome: `plan_${plan.status}`, plan } : { outcome: "subscription_unrelated" };
      }
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      await repo.payments.expireCheckout(event.data.object.id);
      outcome = "expired";
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      if (!userId) break;
      const plan = await reconcileSubscription(stripe, repo, userId, sub.id);
      return plan ? { outcome: `plan_${plan.status}`, plan } : { outcome: "subscription_unrelated" };
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const pi = idOf(charge.payment_intent);
      if (pi && charge.refunded) {
        await repo.payments.markRefunded(pi);
        outcome = "refunded";
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      if (userId) {
        await repo.payments.setHostAccount(userId, account.id, !!account.charges_enabled);
        outcome = "payouts_updated";
      }
      break;
    }
  }
  return { outcome };
}
