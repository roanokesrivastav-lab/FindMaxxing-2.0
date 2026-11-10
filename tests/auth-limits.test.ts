/**
 * Security batch 1, part 0.1a (F3): the real sign-in, sign-up, password-reset and account-deletion
 * actions in Supabase mode, limited by the real 0040 SQL (consume_server_abuse in PGlite, called as
 * service_role through the admin client). Only the Supabase Auth provider calls are spies, so each
 * test can assert that a denied attempt never reaches the provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { abuseRows, pgliteRpc, type RpcCall } from "./helpers/abuseRpc";

const h = vi.hoisted(() => ({
  ip: "203.0.113.10" as string | null,
  rpc: null as null | ((name: string, args?: Record<string, unknown>) => Promise<unknown>),
  adminThrows: false,
  viewer: { id: "00000000-0000-4000-8000-0000000000a1", email: "Del@Example.test" },
  signIn: vi.fn(), signUp: vi.fn(), reset: vi.fn(), statelessSignIn: vi.fn(), signOut: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.ip ? { "x-real-ip": h.ip } : {}),
  cookies: async () => ({ set: () => {}, get: () => undefined, delete: () => {}, getAll: () => [] }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithPassword: h.signIn, signUp: h.signUp, resetPasswordForEmail: h.reset, signOut: h.signOut } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    if (h.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return { rpc: (name: string, args?: Record<string, unknown>) => h.rpc!(name, args) };
  },
  createSupabaseStatelessClient: () => ({ auth: { signInWithPassword: h.statelessSignIn } }),
}));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => h.viewer }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn(), log: vi.fn() }));

const SECRET = "test-abuse-secret-at-least-32-characters-long";
let db: PGlite;
let calls: RpcCall[];
const { signInAction, signUpAction } = await import("../src/server/actions/auth");
const { requestPasswordResetAction, deleteAccountAction } = await import("../src/server/actions/account");

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const signIn = (email: string) => signInAction(null, form({ email, password: "wrong-password-1" }));
const signUp = (n: number | string, email = `new${n}@example.test`) =>
  signUpAction(null, form({ email, password: "a-long-password", username: `newbie_${n}`, displayName: `Newbie ${n}` }));
const reset = (email: string) => requestPasswordResetAction(null, form({ email }));
const del = () => deleteAccountAction(null, form({ password: "wrong-password-1" }));

beforeAll(async () => { db = await createSeededDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("ABUSE_HMAC_SECRET", SECRET);
  vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
  await db.exec("delete from public.server_abuse_counters;");
  calls = [];
  h.rpc = pgliteRpc(db, calls);
  h.adminThrows = false;
  h.ip = "203.0.113.10";
  h.signIn.mockResolvedValue({ error: { message: "Invalid login credentials" } });
  h.signUp.mockResolvedValue({ data: { session: null }, error: null });
  h.reset.mockResolvedValue({ error: null });
  h.statelessSignIn.mockResolvedValue({ error: { message: "Invalid login credentials" }, data: { user: null } });
});

describe("sign-in (5 / email / 15 min, 20 / IP / 15 min)", () => {
  it("reserves before the provider: attempt 6 for one email is rate-limited with zero provider calls", async () => {
    for (let i = 0; i < 5; i++) expect(await signIn("Maya@Example.test")).toMatchObject({ ok: false, error: "Incorrect email or password" });
    expect(h.signIn).toHaveBeenCalledTimes(5);
    h.signIn.mockClear();
    // Normalized: case and surrounding space do not make a new email.
    expect(await signIn("  maya@example.TEST ")).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/^Too many sign-in attempts\. Try again in (a minute|\d+ minutes?)\.$/) });
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("counts successful attempts too", async () => {
    h.signIn.mockResolvedValue({ error: null });
    for (let i = 0; i < 5; i++) await expect(signIn("ok@example.test")).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(await signIn("ok@example.test")).toMatchObject({ code: "rate_limited" });
    expect(h.signIn).toHaveBeenCalledTimes(5);
  });

  it("follows the same email across IPs, keeps distinct email+IP pairs independent, and caps one IP at 20", async () => {
    for (let i = 0; i < 5; i++) { h.ip = `198.51.100.${i + 1}`; await signIn("shared@example.test"); }
    h.ip = "198.51.100.99";
    expect(await signIn("shared@example.test")).toMatchObject({ code: "rate_limited" });
    // Another email from another IP is untouched.
    h.ip = "192.0.2.1";
    expect(await signIn("other@example.test")).toMatchObject({ error: "Incorrect email or password" });
    // One IP, 20 different emails, then the IP cap holds for a fresh email (the email cap did not spend it).
    h.ip = "192.0.2.50";
    for (let i = 0; i < 20; i++) expect(await signIn(`spray${i}@example.test`)).toMatchObject({ error: "Incorrect email or password" });
    h.signIn.mockClear();
    expect(await signIn("fresh@example.test")).toMatchObject({ code: "rate_limited" });
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("D1: with no trusted client IP, only the email key applies, so no shared bucket gates every sign-in", async () => {
    h.ip = null;
    for (let i = 0; i < 30; i++) expect(await signIn(`nobody${i}@example.test`)).toMatchObject({ error: "Incorrect email or password" });
    for (let i = 0; i < 4; i++) await signIn("nobody0@example.test");
    expect(await signIn("nobody0@example.test")).toMatchObject({ code: "rate_limited" });
    expect(new Set((await abuseRows(db)).map((r) => r.action))).toEqual(new Set(["signin_email"]));
    // A configured header that is a chain is just as unknown.
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-real-ip");
    h.ip = "203.0.113.1, 10.0.0.1";
    expect(await signIn("chain@example.test")).toMatchObject({ error: "Incorrect email or password" });
    expect((await abuseRows(db)).some((r) => r.action === "signin_ip")).toBe(false);
  });
});

describe("sign-up and reset (no looser than before: 5 / hour per IP and per email)", () => {
  it("sign-up: 5 per IP, then rate-limited with zero provider calls; the email cap follows across IPs", async () => {
    for (let i = 0; i < 5; i++) expect(await signUp(i)).toEqual({ ok: true, data: undefined });
    h.signUp.mockClear();
    expect(await signUp(99)).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/^Too many sign-ups from this network\./) });
    expect(h.signUp).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) { h.ip = `198.51.100.${i + 1}`; await signUp(`e${i}`, "same@example.test"); }
    h.ip = "198.51.100.77";
    expect(await signUp("e9", "same@example.test")).toMatchObject({ code: "rate_limited" });
  });

  it("sign-up D1: unknown clients share a deliberately generous bucket (50 / hour), never per-request free", async () => {
    h.ip = null;
    for (let i = 0; i < 50; i++) expect(await signUp(`u${i}`)).toMatchObject({ ok: true });
    h.signUp.mockClear();
    expect(await signUp("u50")).toMatchObject({ code: "rate_limited" });
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it("reset: identical generic answer for existing and unknown accounts; 6th from one IP denied before any email", async () => {
    const known = await reset("maya@example.com");
    const unknown = await reset("nobody@example.com");
    expect(known).toEqual(unknown);
    expect(known).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) await reset(`x${i}@example.com`);
    h.reset.mockClear();
    expect(await reset("y@example.com")).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/^Too many reset requests\./) });
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("reset: the email cap follows across IPs; D1 unknown clients are limited by email only", async () => {
    for (let i = 0; i < 5; i++) { h.ip = `198.51.100.${i + 1}`; expect(await reset("target@example.com")).toMatchObject({ ok: true }); }
    h.ip = "198.51.100.200";
    expect(await reset("target@example.com")).toMatchObject({ code: "rate_limited" });
    h.ip = null;
    for (let i = 0; i < 8; i++) expect(await reset(`anon${i}@example.com`)).toMatchObject({ ok: true });
  });
});

describe("account deletion password check", () => {
  it("shares the sign-in budget and makes zero provider or deletion calls when denied", async () => {
    for (let i = 0; i < 5; i++) expect(await del()).toMatchObject({ ok: false, fieldErrors: { password: "That password isn't right" } });
    expect(h.statelessSignIn).toHaveBeenCalledTimes(5);
    h.statelessSignIn.mockClear();
    expect(await del()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(h.statelessSignIn).not.toHaveBeenCalled();
    // Deletion ordering: nothing but the limiter ran — no prepare_account_deletion, storage or Auth work.
    expect(new Set(calls.map((c) => c.name))).toEqual(new Set(["consume_server_abuse"]));
    // Same budget as sign-in for that (normalized) email.
    h.signIn.mockClear();
    expect(await signIn("del@example.test")).toMatchObject({ code: "rate_limited" });
    expect(h.signIn).not.toHaveBeenCalled();
  });
});

describe("limiter unavailable: controlled answer, provider never reached, no memory fallback", () => {
  const all = async () => [await signIn("a@example.test"), await signUp(1), await reset("a@example.test"), await del()];
  const expectUnavailable = (results: unknown[]) => {
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "unavailable", error: "Request protection is unavailable. Try again later." });
    for (const spy of [h.signIn, h.signUp, h.reset, h.statelessSignIn]) expect(spy).not.toHaveBeenCalled();
  };

  it("when the RPC returns an error", async () => {
    h.rpc = async () => ({ data: null, error: { message: "connection refused" } });
    expectUnavailable(await all());
  });
  it("when the RPC returns the wrong type", async () => {
    h.rpc = async () => ({ data: "0", error: null });
    expectUnavailable(await all());
  });
  it("when the RPC throws", async () => {
    h.rpc = async () => { throw new Error("socket hang up"); };
    expectUnavailable(await all());
  });
  it("when ABUSE_HMAC_SECRET is missing or short in Supabase mode", async () => {
    vi.stubEnv("ABUSE_HMAC_SECRET", "");
    expectUnavailable(await all());
    vi.stubEnv("ABUSE_HMAC_SECRET", "too-short");
    expectUnavailable(await all());
    expect(calls).toEqual([]);
  });
  it("when the service-role client cannot be built", async () => {
    h.adminThrows = true;
    expectUnavailable(await all());
  });
});

describe("storage", () => {
  it("holds only 64-hex HMAC keys: no raw IP or email in any row", async () => {
    h.ip = "203.0.113.77";
    await signIn("Secret.Person@example.test");
    await signUp(5, "signup.person@example.test");
    await reset("reset.person@example.test");
    const rows = await abuseRows(db);
    expect(rows.map((r) => r.action).sort()).toEqual(["reset_email", "reset_ip", "signin_email", "signin_ip", "signup_email", "signup_ip"]);
    for (const r of rows) {
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.row).not.toMatch(/@|example|203\.0\.113|person/i);
    }
  });
});
