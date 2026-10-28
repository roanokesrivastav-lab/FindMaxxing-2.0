import { expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { handleStripeEvent } from "../src/server/payments/webhook";
import type { StripeLike } from "../src/server/payments/stripe";

const user = (name: string) => SEED_USERS.find((u) => u.username === name)!.id;
const [closed, currentOwner] = ["theo", "maya_r"].map(user);
it.each(["customer.subscription.updated", "checkout.session.completed"])("a stale %s cannot cancel a subscription now attributed to another account", async (type) => {
  const h = createIsolatedStore(), repo = createDemoRepository(h); deleteDemoAccount(h, closed);
  const cancel = vi.fn(async () => ({ status: "canceled" }));
  const stripe = { subscriptions: { retrieve: vi.fn(async () => ({ id: "sub_reassigned", status: "active", metadata: { user_id: currentOwner } })), cancel } } as unknown as StripeLike;
  const object = type.startsWith("checkout") ? { id: "cs_stale", mode: "subscription", subscription: "sub_reassigned", metadata: { user_id: closed } }
    : { id: "sub_reassigned", status: "active", metadata: { user_id: closed } };
  expect(await handleStripeEvent({ id: `evt_${type}`, type, data: { object } } as unknown as Stripe.Event, repo, stripe)).toBe("subscription_unrelated");
  expect(cancel).not.toHaveBeenCalled();
});
it("malformed external user metadata is ignored, not passed to a UUID-only control RPC or treated as a deleted account", async () => {
  const h = createIsolatedStore(), repo = createDemoRepository(h);
  const original = repo.payments.claimStripeEvent;
  const claim = vi.spyOn(repo.payments, "claimStripeEvent").mockImplementation(async (id, type, object, userId) => {
    if (userId) throw new Error("invalid input syntax for type uuid");
    return original(id, type, object, userId);
  });
  const retrieve = vi.fn(), cancel = vi.fn(); const stripe = { subscriptions: { retrieve, cancel } } as unknown as StripeLike;
  expect(await handleStripeEvent({ id: "evt_invalid_user", type: "customer.subscription.updated", data: { object: { id: "sub_unrelated", status: "active", metadata: { user_id: "legacy-external-user" } } } } as unknown as Stripe.Event, repo, stripe)).toBe("ignored");
  expect(claim).toHaveBeenCalledWith("evt_invalid_user", "customer.subscription.updated", "sub_unrelated", null);
  expect(retrieve).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
it("canonicalizes valid uppercase UUID metadata consistently across remote ownership and database scope", async () => {
  const repo = createDemoRepository(createIsolatedStore());
  const sub = { id: "sub_uppercase", status: "active", customer: "cus_uppercase", created: 1, metadata: { user_id: currentOwner.toUpperCase() } };
  const stripe = { subscriptions: { retrieve: async () => sub, list: async () => ({ data: [sub], has_more: false }) } } as unknown as StripeLike;
  expect(await handleStripeEvent({ id: "evt_uppercase", type: "customer.subscription.updated", data: { object: sub } } as unknown as Stripe.Event, repo, stripe)).toBe("plan_active");
  expect(await repo.payments.isPlus(currentOwner)).toBe(true);
});
