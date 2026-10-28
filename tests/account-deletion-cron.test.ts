import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resume: vi.fn(), refund: vi.fn(), handler: vi.fn(), construct: vi.fn(), endAds: vi.fn() }));
vi.mock("@/lib/config", () => ({ getDataMode: () => "supabase", paymentsMode: () => null }));
vi.mock("@/server/accountDeletionJobs", () => ({ resumeAccountDeletions: mocks.resume }));
vi.mock("@/server/serviceRepository", () => ({ serviceRepository: async () => ({ ads: { endFinished: mocks.endAds } }) }));
vi.mock("@/server/payments/stripe", () => ({ getStripe: async () => ({ webhooks: { constructEvent: mocks.construct } }), processRefunds: mocks.refund }));
vi.mock("@/server/payments/webhook", () => ({ handleStripeEvent: mocks.handler }));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "test-cron"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-webhook");
  mocks.resume.mockResolvedValue({ completed: 1, failed: 0 }); mocks.refund.mockResolvedValue({ requested: 2, failed: 0 });
  mocks.handler.mockResolvedValue("account_closed"); mocks.construct.mockReturnValue({ id: "evt_late", type: "customer.subscription.deleted" });
});
afterEach(() => vi.unstubAllEnvs());
it("resumes deletion and refunds even with purchases disabled", async () => {
  const { GET } = await import("../src/app/api/cron/payments/route");
  const response = await GET(new Request("https://example.test/api/cron/payments", { headers: { authorization: "Bearer test-cron" } }));
  expect(await response.json()).toEqual({ requested: 2, failed: 0, deletions: { completed: 1, failed: 0 } });
  expect(mocks.resume).toHaveBeenCalledOnce(); expect(mocks.refund).toHaveBeenCalledOnce();
});
it("requires cron authorization before doing external cleanup", async () => {
  const { GET } = await import("../src/app/api/cron/payments/route");
  expect((await GET(new Request("https://example.test/api/cron/payments"))).status).toBe(401);
  expect(mocks.resume).not.toHaveBeenCalled(); expect(mocks.refund).not.toHaveBeenCalled();
});
it("acknowledges a signed late webhook while new purchases are disabled", async () => {
  const { POST } = await import("../src/app/api/stripe/webhook/route");
  const response = await POST(new Request("https://example.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "signed" }, body: "raw-body" }));
  expect(await response.json()).toEqual({ received: true, outcome: "account_closed" });
  expect(mocks.construct).toHaveBeenCalledWith("raw-body", "signed", "test-webhook");
});
it("rejects a forged late webhook before invoking the handler", async () => {
  const { POST } = await import("../src/app/api/stripe/webhook/route");
  mocks.construct.mockImplementationOnce(() => { throw new Error("bad signature"); });
  expect((await POST(new Request("https://example.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "forged" }, body: "raw-body" }))).status).toBe(400);
  expect(mocks.handler).not.toHaveBeenCalled();
});
