import "server-only";
import type Stripe from "stripe";
import type { DataRepository } from "@/lib/data/repository";
import type { TicketReservation } from "@/lib/data/types";
import { DataError } from "@/lib/data/types";
import { stripeUserId } from "./metadata";

/** The part of the Stripe client this app uses (tests pass a fake). */
export type StripeLike = Pick<Stripe, "checkout" | "billingPortal" | "refunds" | "customers" | "accounts" | "accountLinks" | "webhooks" | "subscriptions">;

/** A canceled subscription stays canceled; recover a lost cancellation response by reading it. */
export async function cancelSubscription(stripe: StripeLike, id: string, userId: string, requireCurrentOwner = false): Promise<boolean> {
  const terminal = (status: string) => status === "canceled" || status === "incomplete_expired";
  const current = await stripe.subscriptions.retrieve(id);
  // Webhook snapshots can predate an ownership correction. Billing cleanup
  // from a durable customer manifest is separate from these external events.
  if (requireCurrentOwner && stripeUserId(current.metadata) !== userId) return false;
  if (terminal(current.status)) return true;
  try {
    await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }, { idempotencyKey: `account-delete:${userId}:${id}` });
  } catch (err) {
    if (!terminal((await stripe.subscriptions.retrieve(id)).status)) throw err;
  }
  return true;
}

/** Test-mode client from STRIPE_SECRET_KEY, or null without it. */
export async function getStripe(env: Record<string, string | undefined> = process.env): Promise<StripeLike | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  const { default: StripeClient } = await import("stripe");
  return new StripeClient(env.STRIPE_SECRET_KEY);
}

const unix = (ms: number) => Math.floor(ms / 1000);

/** Platform fee on tickets, in basis points (default 0 during the beta). */
export function platformFeeCents(amountCents: number, env: Record<string, string | undefined> = process.env): number {
  const bps = Math.min(Math.max(Number(env.TICKET_PLATFORM_FEE_BPS ?? 0) || 0, 0), 3000);
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * Checkout for a held ticket. The money goes to the host's connected account
 * (a destination charge); the session expires a little after the 30-minute hold.
 */
export async function createTicketCheckout(stripe: StripeLike, r: TicketReservation, opts: { userId: string; eventId: string; origin: string; email?: string | null }): Promise<{ id: string; url: string }> {
  if (!r.hostAccount) throw new Error("The host has no payout account");
  const fee = platformFeeCents(r.amountCents);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: r.currency, unit_amount: r.amountCents, product_data: { name: `Ticket: ${r.eventTitle}` } } }],
    client_reference_id: r.ticketId,
    customer_email: opts.email ?? undefined,
    metadata: { ticket_id: r.ticketId, user_id: opts.userId, event_id: opts.eventId },
    payment_intent_data: { transfer_data: { destination: r.hostAccount }, ...(fee ? { application_fee_amount: fee } : {}), metadata: { ticket_id: r.ticketId } },
    expires_at: unix(Date.now() + 31 * 60_000),
    success_url: `${opts.origin}/events/${opts.eventId}?ticket=success`,
    cancel_url: `${opts.origin}/events/${opts.eventId}?ticket=cancelled`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return { id: session.id, url: session.url };
}

/** Pays a reviewed campaign's whole budget up front. */
export async function createCampaignCheckout(stripe: StripeLike, c: { id: string; headline: string; budgetCents: number }, opts: { userId: string; origin: string; email?: string | null }): Promise<{ id: string; url: string }> {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: c.budgetCents, product_data: { name: `Sponsored card: ${c.headline}` } } }],
    customer_email: opts.email ?? undefined,
    metadata: { campaign_id: c.id, user_id: opts.userId },
    success_url: `${opts.origin}/ads?paid=1`,
    cancel_url: `${opts.origin}/ads`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return { id: session.id, url: session.url };
}

/** Plus checkout, for an existing or new Stripe customer. */
export async function createPlusCheckout(stripe: StripeLike, repo: DataRepository, opts: { userId: string; email: string | null; priceId: string; origin: string }): Promise<string> {
  if (await repo.payments.isClosing(opts.userId)) throw new DataError("Account deletion is in progress", "forbidden");
  let customer = await repo.payments.customerOf(opts.userId);
  if (!customer) {
    customer = (await stripe.customers.create({ email: opts.email ?? undefined, metadata: { user_id: opts.userId } }, { idempotencyKey: `customer:${opts.userId}` })).id;
    await repo.payments.linkCustomer(opts.userId, customer);
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: opts.priceId, quantity: 1 }],
    metadata: { user_id: opts.userId },
    subscription_data: { metadata: { user_id: opts.userId } },
    success_url: `${opts.origin}/plus?status=success`,
    cancel_url: `${opts.origin}/plus`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  if (await repo.payments.isClosing(opts.userId)) {
    await stripe.checkout.sessions.expire(session.id);
    throw new DataError("Account deletion is in progress", "forbidden");
  }
  return session.url;
}

export async function createPortal(stripe: StripeLike, customer: string, origin: string): Promise<string> {
  return (await stripe.billingPortal.sessions.create({ customer, return_url: `${origin}/plus` })).url;
}

/** Stripe Connect Express onboarding for hosts who sell tickets. */
export async function createHostOnboarding(stripe: StripeLike, repo: DataRepository, opts: { userId: string; email: string | null; origin: string }): Promise<string> {
  let account = await repo.payments.hostAccountOf(opts.userId);
  if (!account) {
    account = (await stripe.accounts.create({ type: "express", email: opts.email ?? undefined, metadata: { user_id: opts.userId } }, { idempotencyKey: `account:${opts.userId}` })).id;
    await repo.payments.setHostAccount(opts.userId, account, false);
  }
  const link = await stripe.accountLinks.create({ account, type: "account_onboarding", refresh_url: `${opts.origin}/plus?payouts=retry`, return_url: `${opts.origin}/plus?payouts=done` });
  return link.url;
}

/**
 * Asks Stripe to refund every ticket waiting for one (cancelled events,
 * payments that could not become a ticket). The idempotency key makes a
 * retry harmless; the ticket becomes refunded when charge.refunded arrives.
 */
export async function processRefunds(repo: DataRepository, stripe: StripeLike): Promise<{ requested: number; failed: number }> {
  let requested = 0;
  let failed = 0;
  for (const t of await repo.payments.ticketsToRefund()) {
    try {
      await stripe.refunds.create({ payment_intent: t.paymentIntentId, reverse_transfer: true, refund_application_fee: true }, { idempotencyKey: `refund:${t.ticketId}` });
      requested += 1;
    } catch {
      failed += 1;
    }
  }
  return { requested, failed };
}
