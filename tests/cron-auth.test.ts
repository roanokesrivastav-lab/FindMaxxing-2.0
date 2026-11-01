import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), rpc: vi.fn(), repository: vi.fn(), service: vi.fn(),
  resume: vi.fn(), endAds: vi.fn(), stripe: vi.fn(), refunds: vi.fn(),
  jobs: vi.fn(), purge: vi.fn(), web: vi.fn(), expo: vi.fn(), combined: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ getDataMode: () => "supabase", paymentsMode: () => "test", pushTransportReady: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/data/supabase/repository", () => ({ createSupabaseRepository: mocks.repository }));
vi.mock("@/server/serviceRepository", () => ({ serviceRepository: mocks.service }));
vi.mock("@/server/accountDeletionJobs", () => ({ resumeAccountDeletions: mocks.resume }));
vi.mock("@/server/payments/stripe", () => ({ getStripe: mocks.stripe, processRefunds: mocks.refunds }));
vi.mock("@/server/notifications/push", () => ({
  runNotificationJobs: mocks.jobs, webPushSender: mocks.web, expoPushSender: mocks.expo, combinedSender: mocks.combined,
}));

import { GET as payments } from "../src/app/api/cron/payments/route";
import { GET as notifications } from "../src/app/api/cron/notifications/route";
import { GET as purge } from "../src/app/api/cron/purge-analytics/route";
import { GET as reputation } from "../src/app/api/cron/refresh-reputation/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T04:05:00Z"));
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ data: 2, error: null });
  mocks.repository.mockReturnValue({ notifications: { purge: mocks.purge } });
  mocks.service.mockResolvedValue({ ads: { endFinished: mocks.endAds } });
  mocks.resume.mockResolvedValue({ completed: 0, failed: 0 });
  mocks.stripe.mockResolvedValue({});
  mocks.refunds.mockResolvedValue({ requested: 0, failed: 0 });
  mocks.jobs.mockResolvedValue({ sent: 1 });
  mocks.purge.mockResolvedValue(0);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe.each([
  { name: "payments", get: payments, work: mocks.refunds },
  { name: "notifications", get: notifications, work: mocks.jobs },
  { name: "purge-analytics", get: purge, work: mocks.rpc },
  { name: "refresh-reputation", get: reputation, work: mocks.rpc },
])("$name cron authorization", ({ name, get, work }) => {
  const request = (authorization?: string) => new Request(`https://example.test/api/cron/${name}`, {
    headers: authorization === undefined ? {} : { authorization },
  });
  it.each([
    undefined, "Bearer wrong-cron-secret", "Bearer x", "Bearer test-cron-secret-extra",
    "Basic test-cron-secret", "bearer test-cron-secret", "Bearer tést-cron-secret", "Bearer",
  ])("rejects %s without constructing clients or doing work", async (header) => {
    expect((await get(request(header))).status).toBe(401);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("rejects an unset/empty secret (%s)", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    expect((await get(request("Bearer test-cron-secret"))).status).toBe(401);
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("runs the actual route with a correct secret", async () => {
    expect((await get(request("Bearer test-cron-secret"))).status).toBe(200);
    expect(work).toHaveBeenCalled();
    if (name === "purge-analytics") {
      expect(mocks.rpc).toHaveBeenCalledWith("purge_analytics", { p_keep_days: 180 });
      expect(mocks.rpc).toHaveBeenCalledWith("purge_user_interactions", { p_keep_days: 365 });
    }
    if (name === "refresh-reputation") expect(mocks.rpc).toHaveBeenCalledWith("refresh_all_reputation");
  });
});
