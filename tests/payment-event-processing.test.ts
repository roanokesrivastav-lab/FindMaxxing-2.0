import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { handleStripeEvent } from "../src/server/payments/webhook";
import { reconcileSubscription } from "../src/server/payments/reconcileSubscription";
import type { StripeLike } from "../src/server/payments/stripe";

const user = (name: string) => SEED_USERS.find((u) => u.username === name)!.id;
const [host, buyer, member, advertiser] = ["dev", "maya_r", "theo", "lena"].map(user);
const event = (id: string, type: string, object: unknown) => ({ id, type, data: { object } }) as Stripe.Event;
const sub = (id: string, status = "active", created = 1, customer = "cus_member") => ({ id, status, created, customer, metadata: { user_id: member }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } }) as unknown as Stripe.Subscription;
function remote() {
  const subs = new Map([["sub_current", sub("sub_current")]]);
  const retrieve = vi.fn(async (id: string) => structuredClone(subs.get(id)!));
  const list = vi.fn(async ({ customer }: { customer: string }) => ({ data: [...subs.values()].filter((s) => s.customer === customer).map((s) => structuredClone(s)), has_more: false }));
  const refund = vi.fn(async () => ({ id: "re_test" }));
  return { subs, retrieve, list, refund, stripe: { subscriptions: { retrieve, list }, refunds: { create: refund } } as unknown as StripeLike };
}
let h: ReturnType<typeof createIsolatedStore>;
let repo: ReturnType<typeof createDemoRepository>;
beforeEach(async () => { h = createIsolatedStore(); repo = createDemoRepository(h); await repo.payments.linkCustomer(member, "cus_member"); });

describe("subscription event reconciliation", () => {
  it("active -> canceled -> replay active stays canceled without processing the completed duplicate", async () => {
    const r = remote(), active = event("evt_active", "customer.subscription.updated", sub("sub_current"));
    expect(await handleStripeEvent(active, repo, r.stripe)).toBe("plan_active");
    r.subs.set("sub_current", sub("sub_current", "canceled"));
    expect(await handleStripeEvent(event("evt_cancel", "customer.subscription.deleted", sub("sub_current", "active")), repo, r.stripe)).toBe("plan_canceled");
    r.retrieve.mockClear();
    expect(await handleStripeEvent(active, repo, r.stripe)).toBe("duplicate:plan_active");
    expect(r.retrieve).not.toHaveBeenCalled(); expect(await repo.payments.isPlus(member)).toBe(false);
  });
  it("reversed, different-ID and same-timestamp deliveries read current remote state", async () => {
    const r = remote(); r.subs.set("sub_current", sub("sub_current", "canceled"));
    for (const id of ["evt_new", "evt_delayed", "evt_same_second"]) {
      expect(await handleStripeEvent(event(id, "customer.subscription.updated", sub("sub_current", "active")), repo, r.stripe)).toBe("plan_canceled");
    }
    expect(await repo.payments.isPlus(member)).toBe(false);
  });
  it("an old subscription's cancellation cannot displace a live replacement", async () => {
    const r = remote(); r.subs.set("sub_old", sub("sub_old", "canceled", 1)); r.subs.set("sub_current", sub("sub_current", "active", 2));
    expect(await handleStripeEvent(event("evt_old", "customer.subscription.deleted", sub("sub_old", "canceled")), repo, r.stripe)).toBe("plan_active");
    expect(h.state.entitlements.find((e) => e.userId === member)?.subscriptionId).toBe("sub_current");
  });
  it("an event from a former customer cannot overwrite the currently mapped customer's plan", async () => {
    const r = remote(); await repo.payments.setEntitlement(member, "active", null, "sub_current");
    r.subs.set("sub_old", sub("sub_old", "canceled", 1, "cus_old"));
    expect(await handleStripeEvent(event("evt_old_customer", "customer.subscription.deleted", sub("sub_old")), repo, r.stripe)).toBe("subscription_unrelated");
    expect(await repo.payments.isPlus(member)).toBe(true);
  });
  it("a stale subscription checkout cannot relink a former customer or override a replacement plan", async () => {
    const r = remote(); await repo.payments.setEntitlement(member, "active", null, "sub_current");
    r.subs.set("sub_old", sub("sub_old", "canceled", 1, "cus_old"));
    const e = event("evt_old_checkout", "checkout.session.completed", { id: "cs_old_customer", mode: "subscription", customer: "cus_old", subscription: "sub_old", metadata: { user_id: member } });
    expect(await handleStripeEvent(e, repo, r.stripe)).toBe("subscription_unrelated");
    expect(await repo.payments.customerOf(member)).toBe("cus_member"); expect(await repo.payments.isPlus(member)).toBe(true);
  });
  it("a completed subscription checkout reconciles and commits customer/plan together", async () => {
    const r = remote(); h.state.stripeCustomers = h.state.stripeCustomers.filter((c) => c.userId !== member);
    const e = event("evt_checkout", "checkout.session.completed", { id: "cs_sub", mode: "subscription", customer: "cus_member", subscription: "sub_current", metadata: { user_id: member } });
    vi.spyOn(repo.payments, "finishStripeEvent").mockRejectedValueOnce(new Error("commit failed"));
    await expect(handleStripeEvent(e, repo, r.stripe)).rejects.toThrow("commit failed");
    expect(await repo.payments.customerOf(member)).toBeNull();
    expect(await handleStripeEvent(e, repo, r.stripe)).toBe("plan_active");
    expect(await repo.payments.customerOf(member)).toBe("cus_member");
  });
  it("does not mark failed remote reads complete and retries from fresh state", async () => {
    const r = remote(); r.list.mockRejectedValueOnce(new Error("Stripe unavailable"));
    const e = event("evt_retry", "customer.subscription.updated", sub("sub_current"));
    await expect(handleStripeEvent(e, repo, r.stripe)).rejects.toThrow("Stripe unavailable");
    expect(h.state.stripeEvents.find((x) => x.id === e.id)?.state).toBe("pending");
    r.subs.set("sub_current", sub("sub_current", "canceled"));
    expect(await handleStripeEvent(e, repo, r.stripe)).toBe("plan_canceled");
  });
  it("a failure before atomic completion remains retryable, not a permanently skipped event", async () => {
    const r = remote(), e = event("evt_crash", "customer.subscription.updated", sub("sub_current"));
    vi.spyOn(repo.payments, "finishStripeEvent").mockRejectedValueOnce(new Error("commit unavailable"));
    await expect(handleStripeEvent(e, repo, r.stripe)).rejects.toThrow("commit unavailable");
    expect(h.state.stripeEvents.find((x) => x.id === e.id)?.state).toBe("pending");
    expect(await handleStripeEvent(e, repo, r.stripe)).toBe("plan_active");
    expect(r.retrieve).toHaveBeenCalledTimes(2);
  });
  it("rejects concurrent deliveries for the same user before they read remote snapshots", async () => {
    const r = remote(); let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const implementation = r.retrieve.getMockImplementation()!;
    r.retrieve.mockImplementationOnce(async (id) => { await gate; return implementation(id); });
    const first = handleStripeEvent(event("evt_first", "customer.subscription.updated", sub("sub_current")), repo, r.stripe);
    await vi.waitFor(() => expect(r.retrieve).toHaveBeenCalledOnce());
    await expect(handleStripeEvent(event("evt_second", "customer.subscription.deleted", sub("sub_current")), repo, r.stripe)).rejects.toThrow(/busy/);
    expect(r.retrieve).toHaveBeenCalledOnce(); unblock(); await first;
    r.subs.set("sub_current", sub("sub_current", "canceled"));
    expect(await handleStripeEvent(event("evt_second", "customer.subscription.deleted", sub("sub_current")), repo, r.stripe)).toBe("plan_canceled");
  });
  it("fences an expired worker after a new user-scoped worker applies a newer plan", async () => {
    const old = await repo.payments.claimStripeEvent("evt_stale", "customer.subscription.updated", "sub_current", member);
    if (old.state !== "claimed") throw new Error("test claim failed");
    h.state.stripeEvents.find((x) => x.id === "evt_stale")!.leasedUntil = new Date(0).toISOString();
    const next = await repo.payments.claimStripeEvent("evt_new", "customer.subscription.deleted", "sub_current", member);
    if (next.state !== "claimed") throw new Error("test claim failed");
    await repo.payments.finishStripeEvent("evt_new", next.token, "plan_canceled", { userId: member, status: "canceled", periodEnd: null, subscriptionId: "sub_current" });
    await expect(repo.payments.finishStripeEvent("evt_stale", old.token, "plan_active", { userId: member, status: "active", periodEnd: null, subscriptionId: "sub_current" })).rejects.toThrow(/lease lost/);
    expect(await repo.payments.isPlus(member)).toBe(false);
  });
  it("paginates all customer subscriptions before choosing the live replacement", async () => {
    const r = remote();
    r.list.mockResolvedValueOnce({ data: [sub("sub_old", "canceled")], has_more: true }).mockResolvedValueOnce({ data: [sub("sub_current", "active", 2)], has_more: false });
    expect((await reconcileSubscription(r.stripe, repo, member, "sub_current"))?.subscriptionId).toBe("sub_current");
    expect(r.list).toHaveBeenLastCalledWith({ customer: "cus_member", status: "all", limit: 100, starting_after: "sub_old" });
  });
  it("fails closed on incomplete or missing active inventory", async () => {
    const r = remote(); r.list.mockResolvedValueOnce({ data: [], has_more: true });
    await expect(reconcileSubscription(r.stripe, repo, member, "sub_current")).rejects.toThrow(/Incomplete/);
    r.list.mockResolvedValueOnce({ data: [], has_more: false });
    await expect(reconcileSubscription(r.stripe, repo, member, "sub_current")).rejects.toThrow(/missing/);
  });
});

async function heldTicket() {
  const ev = await repo.events.create({ title: "Delayed payment test", description: "Long enough test description", locationName: "Test venue", lat: 39.96, lng: -83, startsAt: new Date(Date.now() + 86400000).toISOString(), categorySlug: h.state.events[0].categorySlug, capacity: null, tags: [] }, host);
  await repo.payments.setEventPrice(host, ev.id, 1500);
  const hold = await repo.payments.reserveTicket(buyer, ev.id); await repo.payments.attachCheckout(hold.ticketId, "cs_ticket");
  return { ev, hold, session: { id: "cs_ticket", mode: "payment", payment_status: "paid", currency: "usd", amount_total: 1500, payment_intent: "pi_ticket", metadata: { ticket_id: hold.ticketId } } };
}
describe("settled checkout fulfillment", () => {
  it.each(["unpaid", "no_payment_required", undefined])("does not admit a ticket on completed/%s", async (payment_status) => {
    const { ev, session } = await heldTicket(); const r = remote();
    expect(await handleStripeEvent(event("evt_unpaid", "checkout.session.completed", { ...session, payment_status }), repo, r.stripe)).toBe("unpaid");
    expect(h.state.eventAttendees.some((a) => a.eventId === ev.id && a.userId === buyer)).toBe(false);
    expect((await repo.payments.myTickets(buyer))[0].status).toBe("pending"); expect(r.refund).not.toHaveBeenCalled();
  });
  it("completed/unpaid -> delayed success fulfills once, then failed/replayed events cannot undo it", async () => {
    const { session } = await heldTicket(); const r = remote();
    await handleStripeEvent(event("evt_wait", "checkout.session.completed", { ...session, payment_status: "unpaid" }), repo, r.stripe);
    const success = event("evt_success", "checkout.session.async_payment_succeeded", session);
    expect(await handleStripeEvent(success, repo, r.stripe)).toBe("confirmed");
    expect(await handleStripeEvent(success, repo, r.stripe)).toBe("duplicate:confirmed");
    await handleStripeEvent(event("evt_failed_late", "checkout.session.async_payment_failed", session), repo, r.stripe);
    expect((await repo.payments.myTickets(buyer))[0].status).toBe("paid");
  });
  it("delayed failure expires the hold without granting attendance", async () => {
    const { ev, session } = await heldTicket(); const r = remote();
    await handleStripeEvent(event("evt_failed", "checkout.session.async_payment_failed", { ...session, payment_status: "unpaid" }), repo, r.stripe);
    expect((await repo.payments.myTickets(buyer))[0].status).toBe("expired");
    expect(h.state.eventAttendees.some((a) => a.eventId === ev.id && a.userId === buyer)).toBe(false);
  });
  it.each(["expired", "elapsed", "canceled", "amount", "currency"])("queues late/invalid settled ticket payment for refund: %s", async (failure) => {
    const { ev, hold, session } = await heldTicket(); const r = remote();
    if (failure === "expired") await repo.payments.expireCheckout(session.id);
    if (failure === "elapsed") h.state.tickets.find((t) => t.id === hold.ticketId)!.expiresAt = new Date(0).toISOString();
    if (failure === "canceled") await repo.events.cancel(ev.id, host);
    expect(await handleStripeEvent(event(`evt_${failure}`, "checkout.session.async_payment_succeeded", { ...session, ...(failure === "amount" ? { amount_total: 1 } : {}), ...(failure === "currency" ? { currency: "eur" } : {}) }), repo, r.stripe)).toBe("refund");
    expect(await repo.payments.ticketsToRefund()).toEqual([{ ticketId: hold.ticketId, paymentIntentId: "pi_ticket" }]);
    expect(h.state.eventAttendees.some((a) => a.eventId === ev.id && a.userId === buyer)).toBe(false);
  });
  it("an unpaid campaign completion never activates; delayed success activates exactly once", async () => {
    const place = h.state.places.find((p) => p.creatorId === advertiser && p.visibility === "public" && p.status === "published")!;
    const id = await repo.ads.create(advertiser, { kind: "place", targetId: place.id, headline: "Payment test card", body: null, bounds: null, categorySlug: null, startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(), budgetCents: 2000 });
    await repo.ads.review(host, id, true, null); await repo.ads.attachCheckout(id, "cs_ad");
    const session = { id: "cs_ad", mode: "payment", payment_status: "paid", currency: "usd", amount_total: 2000, payment_intent: "pi_ad", metadata: { campaign_id: id } }; const r = remote();
    expect(await handleStripeEvent(event("evt_ad_wait", "checkout.session.completed", { ...session, payment_status: "unpaid" }), repo, r.stripe)).toBe("unpaid");
    expect((await repo.ads.mine(advertiser)).find((c) => c.id === id)?.status).toBe("awaiting_payment");
    expect(await handleStripeEvent(event("evt_ad_success", "checkout.session.async_payment_succeeded", session), repo, r.stripe)).toBe("campaign_active");
    expect(await handleStripeEvent(event("evt_ad_success", "checkout.session.async_payment_succeeded", session), repo, r.stripe)).toBe("duplicate:campaign_active");
  });
  it("does not lose a refund obligation when the refund request fails before completion", async () => {
    const { session } = await heldTicket(); const r = remote(); r.refund.mockRejectedValueOnce(new Error("refund timeout"));
    const e = event("evt_stale_session", "checkout.session.async_payment_succeeded", { ...session, id: "cs_replaced" });
    await expect(handleStripeEvent(e, repo, r.stripe)).rejects.toThrow("refund timeout");
    expect(h.state.stripeEvents.find((x) => x.id === e.id)?.state).toBe("pending");
    expect(await handleStripeEvent(e, repo, r.stripe)).toBe("unknown");
    expect(r.refund).toHaveBeenNthCalledWith(1, { payment_intent: "pi_ticket", reverse_transfer: true }, { idempotencyKey: "refund:session:cs_replaced" });
    expect(r.refund).toHaveBeenNthCalledWith(2, { payment_intent: "pi_ticket", reverse_transfer: true }, { idempotencyKey: "refund:session:cs_replaced" });
  });
});
