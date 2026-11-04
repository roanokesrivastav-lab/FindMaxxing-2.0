import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ password: vi.fn(), rpc: vi.fn(), remove: vi.fn(), authDelete: vi.fn() }));
vi.mock("@/lib/config", () => ({ getDataMode: () => "supabase", TRUSTED_PROXY_HEADERS: ["x-forwarded-for", "x-real-ip"] }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.5" }) }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseStatelessClient: () => ({ auth: { signInWithPassword: mocks.password } }),
  // The durable limiter's consume_server_abuse admits; every other RPC goes to the deletion mock.
  createSupabaseAdminClient: () => ({ rpc: (name: string, args: unknown) => name === "consume_server_abuse" ? Promise.resolve({ data: 0, error: null }) : mocks.rpc(name, args), storage: { from: () => ({ remove: mocks.remove }) }, auth: { admin: { deleteUser: mocks.authDelete } } }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ABUSE_HMAC_SECRET", "test-abuse-secret-at-least-32-characters-long");
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
});
it("requires the correct password before creating a cleanup job", async () => {
  mocks.password.mockResolvedValueOnce({ error: new Error("wrong password"), data: { user: null } });
  const { deleteAccount, WRONG_PASSWORD } = await import("../src/server/accountDeletion");
  await expect(deleteAccount("user-a", "a@example.test", "bad")).rejects.toThrow(WRONG_PASSWORD);
  expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.authDelete).not.toHaveBeenCalled();
});
it("a password for a different account cannot start the requested deletion", async () => {
  mocks.password.mockResolvedValueOnce({ error: null, data: { user: { id: "user-b" } } });
  const { deleteAccount, WRONG_PASSWORD } = await import("../src/server/accountDeletion");
  await expect(deleteAccount("user-a", "b@example.test", "correct-for-b")).rejects.toThrow(WRONG_PASSWORD);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("an inventory error cannot silently become an empty manifest and delete Auth", async () => {
  mocks.password.mockResolvedValueOnce({ error: null, data: { user: { id: "user-a" } } });
  mocks.rpc.mockResolvedValueOnce({ error: { message: "Inventory unavailable" }, data: null });
  const { deleteAccount } = await import("../src/server/accountDeletion");
  await expect(deleteAccount("user-a", "a@example.test", "correct")).rejects.toThrow(/Could not confirm/);
  expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.authDelete).not.toHaveBeenCalled();
});
