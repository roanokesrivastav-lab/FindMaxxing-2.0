import "server-only";
import type Stripe from "stripe";
import type { DataRepository, StripePlanSnapshot } from "@/lib/data/repository";
import type { StripeLike } from "./stripe";
import { stripeUserId } from "./metadata";

const STATUSES = new Set(["active", "trialing", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]);
const idOf = (v: string | { id: string }) => typeof v === "string" ? v : v.id;
function periodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as unknown as { current_period_end?: number; items?: { data?: { current_period_end?: number }[] } };
  const end = s.current_period_end ?? s.items?.data?.[0]?.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

/** Called only while holding the user's event lease, never from event snapshots. */
export async function reconcileSubscription(stripe: StripeLike, repo: DataRepository, userId: string, subscriptionId: string): Promise<StripePlanSnapshot | null> {
  const current = await stripe.subscriptions.retrieve(subscriptionId);
  if (stripeUserId(current.metadata) !== userId) return null;
  const customer = idOf(current.customer);
  const mapped = await repo.payments.customerOf(userId);
  // An old customer's event cannot replace the current customer's plan.
  if (mapped && mapped !== customer) return null;
  const subscriptions: Stripe.Subscription[] = [];
  let after: string | undefined;
  do {
    const page: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({ customer, status: "all", limit: 100, ...(after ? { starting_after: after } : {}) });
    subscriptions.push(...page.data.filter((s) => stripeUserId(s.metadata) === userId && idOf(s.customer) === customer));
    after = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !after) throw new Error("Incomplete subscription reconciliation");
  } while (after);
  if (!subscriptions.length) {
    // Canceled subscriptions can outlive a deleted customer. Never grant access
    // from an active retrieve result missing from the inventory.
    if (!["canceled", "incomplete_expired"].includes(current.status)) throw new Error("Subscription missing from customer inventory");
    subscriptions.push(current);
  }
  const grants = (sub: Stripe.Subscription) => ["active", "trialing", "past_due"].includes(sub.status)
    && (!periodEnd(sub) || Date.parse(periodEnd(sub)!) > Date.now());
  // A canceled/old subscription's event must not displace a live replacement.
  // Within the same access class use a stable current-customer choice, not the
  // event's timestamp (which can tie and can arrive out of order).
  subscriptions.sort((a, b) => Number(grants(b)) - Number(grants(a)) || b.created - a.created || b.id.localeCompare(a.id));
  const chosen = subscriptions[0];
  if (!STATUSES.has(chosen.status)) throw new Error(`Unsupported subscription status: ${chosen.status}`);
  return { userId, status: chosen.status as StripePlanSnapshot["status"], periodEnd: periodEnd(chosen), subscriptionId: chosen.id, customerId: customer };
}
