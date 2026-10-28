import { describe, expect, it, vi } from "vitest";
import { closeAccountBilling, runAccountDeletion, supabaseDeletionPort, type DeletionJob, type DeletionPort } from "../src/server/accountDeletionJobs";
import { cancelSubscription, createPlusCheckout, type StripeLike } from "../src/server/payments/stripe";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import { handleStripeEvent } from "../src/server/payments/webhook";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import type { SupabaseClient } from "@supabase/supabase-js";

const user = (name: string) => SEED_USERS.find((u) => u.username === name)!.id;
const [host, buyer] = ["dev", "maya_r"].map(user);
function harness(paths = 1) {
  const journal: DeletionJob = { user_id: host, storage_paths: Array.from({ length: paths }, (_, i) => ({ bucket: i % 2 ? "avatars" : "place-photos", path: `${host}/${i}.webp` })), stripe_customer_id: "cus_host", stripe_subscription_ids: ["sub_host"], billing_complete: false, storage_complete: false, lease_token: "lease" };
  let completed = false;
  const order: string[] = [];
  const port: DeletionPort = {
    claim: vi.fn(async () => { order.push("claim"); return completed ? null : structuredClone(journal); }),
    save: vi.fn(async (_, patch) => { order.push(`save:${Object.keys(patch).join(",")}`); if (patch.billing) journal.billing_complete = true; if (patch.storage) journal.storage_complete = true; if (patch.removed) journal.removed_storage_paths = [...(journal.removed_storage_paths ?? []), ...patch.removed]; if (patch.complete) completed = true; }),
    closeBilling: vi.fn(async () => { order.push("billing"); }),
    remove: vi.fn(async () => { order.push("remove"); }),
    deleteAuth: vi.fn(async () => { order.push("auth"); }),
  };
  return { journal, order, port, completed: () => completed };
}

describe("durable deletion failure paths", () => {
  it("cleans billing and Storage before deleting Auth, then records completion", async () => {
    const h = harness();
    expect(await runAccountDeletion(host, h.port)).toBe(true);
    expect(h.order).toEqual(["claim", "billing", "save:billing", "remove", "save:removed", "save:storage", "auth", "save:complete", "save:release"]);
    expect(h.completed()).toBe(true);
  });
  it("does not remove objects or Auth when billing fails; preserves the journal for retry", async () => {
    const h = harness();
    vi.mocked(h.port.closeBilling).mockRejectedValueOnce(new Error("Stripe timeout"));
    await expect(runAccountDeletion(host, h.port)).rejects.toThrow("Stripe timeout");
    expect(h.port.remove).not.toHaveBeenCalled(); expect(h.port.deleteAuth).not.toHaveBeenCalled();
    expect(h.journal.stripe_subscription_ids).toEqual(["sub_host"]);
    expect(h.port.save).toHaveBeenLastCalledWith(expect.anything(), { release: true });
    expect(await runAccountDeletion(host, h.port)).toBe(true);
  });
  it("does not delete Auth after partial object-removal failure and resumes unfinished paths", async () => {
    const h = harness(202);
    vi.mocked(h.port.remove).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(runAccountDeletion(host, h.port)).rejects.toThrow("Storage unavailable");
    expect(h.port.deleteAuth).not.toHaveBeenCalled(); expect(h.journal.storage_complete).toBe(false);
    expect(h.journal.storage_paths).toHaveLength(202);
    expect(h.journal.removed_storage_paths).toHaveLength(100);
    expect(await runAccountDeletion(host, h.port)).toBe(true);
    expect(h.port.closeBilling).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.port.remove).mock.calls.every(([, paths]) => paths.length <= 100)).toBe(true);
    expect(vi.mocked(h.port.remove).mock.calls.filter(([, paths]) => paths.includes(`${host}/0.webp`))).toHaveLength(1);
  });
  it("handles more than a list API page of objects in bounded removal batches", async () => {
    const h = harness(1105);
    await runAccountDeletion(host, h.port);
    const calls = vi.mocked(h.port.remove).mock.calls;
    expect(calls.reduce((n, [, paths]) => n + paths.length, 0)).toBe(1105);
    expect(calls.every(([, paths]) => paths.length <= 100)).toBe(true);
  });
  it("does not repeat completed billing/storage steps after an Auth failure", async () => {
    const h = harness(); vi.mocked(h.port.deleteAuth).mockRejectedValueOnce(new Error("Auth unavailable"));
    await expect(runAccountDeletion(host, h.port)).rejects.toThrow("Auth unavailable");
    expect(h.completed()).toBe(false);
    await runAccountDeletion(host, h.port);
    expect(h.port.remove).toHaveBeenCalledTimes(1); expect(h.port.closeBilling).toHaveBeenCalledTimes(1);
    expect(h.port.deleteAuth).toHaveBeenCalledTimes(2);
  });
  it("leaves cleanup retryable when persisting completion fails after Auth deletion", async () => {
    const h = harness();
    const implementation = vi.mocked(h.port.save).getMockImplementation()!;
    let failCompletion = true;
    // Inject only the completion persistence failure, keeping prior durable steps.
    vi.mocked(h.port.save).mockImplementation(async (job, patch) => {
      if (patch.complete && failCompletion) { failCompletion = false; throw new Error("Database timeout"); }
      await implementation(job, patch);
    });
    await expect(runAccountDeletion(host, h.port)).rejects.toThrow("Database timeout");
    await runAccountDeletion(host, h.port);
    expect(h.port.closeBilling).toHaveBeenCalledTimes(1); expect(h.port.remove).toHaveBeenCalledTimes(1);
  });
  it("does no external cleanup when inventory/claim fails or another worker owns the lease", async () => {
    const h = harness(); vi.mocked(h.port.claim).mockRejectedValueOnce(new Error("Inventory unavailable"));
    await expect(runAccountDeletion(host, h.port)).rejects.toThrow("Inventory unavailable");
    vi.mocked(h.port.claim).mockResolvedValueOnce(null);
    expect(await runAccountDeletion(host, h.port)).toBe(false);
    expect(h.port.closeBilling).not.toHaveBeenCalled(); expect(h.port.remove).not.toHaveBeenCalled(); expect(h.port.deleteAuth).not.toHaveBeenCalled();
  });
  it("the service adapter recognizes a lost successful Auth response on retry", async () => {
    const getUser = vi.fn(async () => ({ error: { code: "user_not_found" } }));
    const deleteUser = vi.fn();
    const port = supabaseDeletionPort({ auth: { admin: { getUserById: getUser, deleteUser } } } as unknown as SupabaseClient);
    await expect(port.deleteAuth(host)).resolves.toBeUndefined();
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("does not mistake a service error for a deleted user", async () => {
    const deleteUser = vi.fn(); const port = supabaseDeletionPort({ auth: { admin: { getUserById: async () => ({ error: { code: "unexpected_failure" } }), deleteUser } } } as unknown as SupabaseClient);
    await expect(port.deleteAuth(host)).rejects.toMatchObject({ code: "unexpected_failure" }); expect(deleteUser).not.toHaveBeenCalled();
  });
});

function stripeHarness() {
  const status = new Map([["sub_host", "active"], ["sub_duplicate", "active"], ["sub_done", "canceled"]]);
  const cancel = vi.fn(async (id: string) => { status.set(id, "canceled"); return { id, status: "canceled" }; });
  const stripe = {
    subscriptions: { retrieve: vi.fn(async (id: string) => ({ id, status: status.get(id), metadata: { user_id: host } })), cancel,
      list: vi.fn(async () => ({ data: [...status.keys()].map((id) => ({ id })), has_more: false })) },
    checkout: { sessions: { list: vi.fn(async () => ({ data: [{ id: "cs_open", mode: "subscription" }], has_more: false })), expire: vi.fn(async () => ({})) } },
  };
  return { stripe: stripe as unknown as StripeLike, raw: stripe, status, cancel };
}

describe("billing closure and late events", () => {
  it("refuses a new subscription checkout for an already closed account", async () => {
    const h = createIsolatedStore(); const repo = createDemoRepository(h);
    deleteDemoAccount(h, host);
    const create = vi.fn(); const stripe = { checkout: { sessions: { create } } } as unknown as StripeLike;
    await expect(createPlusCheckout(stripe, repo, { userId: host, email: null, priceId: "price_test", origin: "https://example.test" })).rejects.toThrow("Account deletion is in progress");
    expect(create).not.toHaveBeenCalled();
  });
  it("expires a subscription checkout if deletion starts during its creation", async () => {
    const h = createIsolatedStore(); const repo = createDemoRepository(h);
    await repo.payments.linkCustomer(host, "cus_host");
    const create = vi.fn(async () => { deleteDemoAccount(h, host); return { id: "cs_racing", url: "https://checkout.stripe.com/test" }; });
    const expire = vi.fn(); const stripe = { checkout: { sessions: { create, expire } } } as unknown as StripeLike;
    await expect(createPlusCheckout(stripe, repo, { userId: host, email: null, priceId: "price_test", origin: "https://example.test" })).rejects.toThrow("Account deletion is in progress");
    expect(expire).toHaveBeenCalledWith("cs_racing");
  });
  it("expires open checkouts and cancels all customer subscriptions, including duplicate subscriptions", async () => {
    const { stripe, raw, cancel } = stripeHarness(); const persist = vi.fn();
    await closeAccountBilling(harness().journal, stripe, persist);
    expect(raw.checkout.sessions.expire).toHaveBeenCalledWith("cs_open");
    expect(persist).toHaveBeenCalledWith(["sub_host", "sub_duplicate", "sub_done"]);
    expect(cancel.mock.calls.map(([id]) => id)).toEqual(["sub_host", "sub_duplicate"]);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0]);
  });
  it("preserves subscription IDs before a cancellation timeout and safely resumes", async () => {
    const { stripe, cancel, status } = stripeHarness(); const persist = vi.fn();
    cancel.mockImplementationOnce(async () => { throw new Error("timeout"); });
    await expect(closeAccountBilling(harness().journal, stripe, persist)).rejects.toThrow("timeout");
    expect(persist).toHaveBeenCalled(); expect(status.get("sub_host")).toBe("active");
    await closeAccountBilling(harness().journal, stripe, persist);
    expect(status.get("sub_host")).toBe("canceled");
  });
  it("does not cancel twice after a timeout whose remote cancellation succeeded", async () => {
    const { stripe, cancel, status } = stripeHarness();
    cancel.mockImplementationOnce(async (id) => { status.set(id, "canceled"); throw new Error("response lost"); });
    await cancelSubscription(stripe, "sub_host", host);
    await cancelSubscription(stripe, "sub_host", host);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("paginates billing inventory before canceling subscriptions", async () => {
    const { stripe, raw, cancel } = stripeHarness();
    raw.subscriptions.list.mockResolvedValueOnce({ data: [{ id: "sub_host" }], has_more: true }).mockResolvedValueOnce({ data: [{ id: "sub_duplicate" }], has_more: false });
    const persist = vi.fn();
    await closeAccountBilling(harness().journal, stripe, persist);
    expect(raw.subscriptions.list).toHaveBeenLastCalledWith({ customer: "cus_host", status: "all", limit: 100, starting_after: "sub_host" });
    expect(persist).toHaveBeenCalledWith(["sub_host", "sub_duplicate"]);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("refuses an incomplete billing inventory without deleting identifiers or canceling only a subset", async () => {
    const { stripe, raw, cancel } = stripeHarness();
    raw.subscriptions.list.mockResolvedValueOnce({ data: [], has_more: true });
    const persist = vi.fn();
    await expect(closeAccountBilling(harness().journal, stripe, persist)).rejects.toThrow("Incomplete subscription inventory");
    expect(cancel).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it("checkpoints each cancellation and skips it after a later cancellation fails", async () => {
    const { stripe, cancel, raw } = stripeHarness(); const job = harness().journal;
    const checkpoint = vi.fn(async (id: string) => { job.canceled_subscription_ids = [...(job.canceled_subscription_ids ?? []), id]; });
    cancel.mockResolvedValueOnce({ id: "sub_host", status: "canceled" }).mockRejectedValueOnce(new Error("second cancellation failed"));
    await expect(closeAccountBilling(job, stripe, vi.fn(), checkpoint)).rejects.toThrow("second cancellation failed");
    expect(job.canceled_subscription_ids).toEqual(["sub_host"]);
    raw.subscriptions.retrieve.mockClear();
    await closeAccountBilling(job, stripe, vi.fn(), checkpoint);
    expect(raw.subscriptions.retrieve.mock.calls.map(([id]) => id)).not.toContain("sub_host");
  });
  it("acknowledges late subscription/customer/payout events without restoring a deleted profile", async () => {
    const h = createIsolatedStore(); const repo = createDemoRepository(h); const { stripe, status } = stripeHarness();
    deleteDemoAccount(h, host);
    for (const [type, object] of [
      ["customer.subscription.updated", { id: "sub_host", status: "active", metadata: { user_id: host } }],
      ["customer.subscription.deleted", { id: "sub_host", metadata: { user_id: host } }],
      ["checkout.session.completed", { id: "cs_late", mode: "subscription", customer: "cus_host", subscription: "sub_duplicate", metadata: { user_id: host } }],
      ["account.updated", { id: "acct_late", charges_enabled: true, metadata: { user_id: host } }],
    ] as const) expect(await handleStripeEvent({ id: `evt_${type}`, type, data: { object } } as never, repo, stripe)).toBe("account_closed");
    expect(status.get("sub_host")).toBe("canceled"); expect(status.get("sub_duplicate")).toBe("canceled");
    expect(h.state.entitlements.some((e) => e.userId === host)).toBe(false);
    expect(h.state.stripeCustomers.some((e) => e.userId === host)).toBe(false);
    expect(h.state.hostAccounts.some((e) => e.userId === host)).toBe(false);
    expect(await handleStripeEvent({ id: "evt_late_invoice", type: "invoice.paid", data: { object: { id: "in_late", metadata: { user_id: host } } } } as never, repo, stripe)).toBe("ignored");
    expect(h.state.entitlements.some((e) => e.userId === host)).toBe(false);
  });
  it("queues demo future-host refunds while keeping historical paid tickets", async () => {
    const h = createIsolatedStore(), repo = createDemoRepository(h);
    const make = async () => {
      const ev = await repo.events.create({ title: "Deletion ticket test", description: "Long enough test description", locationName: "Test location", lat: 39.96, lng: -83, startsAt: new Date(Date.now() + 86400000).toISOString(), categorySlug: h.state.events[0].categorySlug, capacity: null, tags: [] }, host);
      await repo.payments.setEventPrice(host, ev.id, 1500);
      const hold = await repo.payments.reserveTicket(buyer, ev.id);
      await repo.payments.attachCheckout(hold.ticketId, `cs_${ev.id}`); await repo.payments.confirmTicket(`cs_${ev.id}`, `pi_${ev.id}`, 1500);
      return ev.id;
    };
    const future = await make(), past = await make();
    h.state.events.find((e) => e.id === past)!.startsAt = new Date(Date.now() - 86400000).toISOString();
    deleteDemoAccount(h, host);
    expect((await repo.payments.ticketsToRefund()).map((t) => t.paymentIntentId)).toEqual([`pi_${future}`]);
    expect(h.state.tickets.find((t) => t.paymentIntentId === `pi_${past}`)?.status).toBe("paid");
  });
});
