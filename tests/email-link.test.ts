import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((destination: string) => { throw Object.assign(new Error("redirect"), { destination, digest: "NEXT_REDIRECT" }); }),
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  mode: "supabase" as "supabase" | "demo",
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), getAll: () => [] }) }));
vi.mock("@/lib/config", () => ({ getDataMode: () => mocks.mode, getSiteUrl: () => "https://findmaxxing.test" }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp, exchangeCodeForSession: mocks.exchangeCodeForSession } }),
}));
vi.mock("@/server/http/clientIp", () => ({ clientIp: async () => "test-ip" }));
vi.mock("@/server/limiters", () => ({ limiters: () => ({ signUp: { consume: () => null } }) }));

import { EMAIL_LINK_INVALID, parseEmailLink } from "../src/lib/auth/emailLink";

const HASH = "pkce_0123456789abcdef0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = "supabase";
  mocks.verifyOtp.mockResolvedValue({ data: {}, error: null });
});

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("parsing token-hash email links", () => {
  it("accepts confirmation links and keeps a safe destination", () => {
    expect(parseEmailLink({ tokenHash: HASH, type: "email", next: "/welcome" })).toEqual({ tokenHash: HASH, type: "email", next: "/welcome" });
    expect(parseEmailLink({ tokenHash: HASH, type: "signup", next: undefined })).toEqual({ tokenHash: HASH, type: "email", next: "/welcome" });
    expect(parseEmailLink({ tokenHash: HASH, type: "email_change", next: undefined })?.next).toBe("/");
  });

  it("sends recovery links only to the reset page", () => {
    expect(parseEmailLink({ tokenHash: HASH, type: "recovery", next: "/saved" })?.next).toBe("/auth/reset");
  });

  it.each(["//evil.test", "/\\evil.test", "https://evil.test/", "/%255cevil.test"])("never redirects off-site (next=%s)", (next) => {
    expect(parseEmailLink({ tokenHash: HASH, type: "email", next })?.next).toBe("/welcome");
  });

  it.each([
    ["missing hash", { tokenHash: undefined, type: "email" }],
    ["short hash", { tokenHash: "abc", type: "email" }],
    ["hash with markup", { tokenHash: `${HASH}<script>`, type: "email" }],
    ["array hash", { tokenHash: [HASH, HASH], type: "email" }],
    ["unsupported type", { tokenHash: HASH, type: "magiclink" }],
    ["missing type", { tokenHash: HASH, type: undefined }],
  ])("rejects %s", (_label, input) => {
    expect(parseEmailLink({ ...input, next: "/" })).toBeNull();
  });
});

describe("the auth callback hands token-hash links to the confirm page", () => {
  it("forwards without verifying, so a link scanner's GET cannot spend the token", async () => {
    const { GET } = await import("../src/app/auth/callback/route");
    const res = await GET(new Request(`https://findmaxxing.test/auth/callback?next=%2Fwelcome&token_hash=${HASH}&type=email&extra=1`));
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://findmaxxing.test");
    expect(location.pathname).toBe("/auth/confirm");
    expect(Object.fromEntries(location.searchParams)).toEqual({ token_hash: HASH, type: "email", next: "/welcome" });
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("still exchanges PKCE codes as before", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("../src/app/auth/callback/route");
    const res = await GET(new Request("https://findmaxxing.test/auth/callback?code=abc&next=%2Fwelcome"));
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(res.headers.get("location")).toBe("https://findmaxxing.test/welcome");
  });
});

describe("the confirm page", () => {
  it("does not verify when opened", async () => {
    const { default: ConfirmPage } = await import("../src/app/auth/confirm/page");
    await ConfirmPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ token_hash: HASH, type: "email", next: "/welcome" }) });
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("confirming a token-hash link", () => {
  it("verifies, signs in and continues to the destination", async () => {
    const { confirmEmailLinkAction } = await import("../src/server/actions/auth");
    await expect(confirmEmailLinkAction(null, form({ token_hash: HASH, type: "email", next: "/welcome" }))).rejects.toMatchObject({ destination: "/welcome" });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: HASH });
  });

  it("takes recovery links to the reset page whatever next says", async () => {
    const { confirmEmailLinkAction } = await import("../src/server/actions/auth");
    await expect(confirmEmailLinkAction(null, form({ token_hash: HASH, type: "recovery", next: "//evil.test" }))).rejects.toMatchObject({ destination: "/auth/reset" });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: HASH });
  });

  it("reports an expired or used link without redirecting", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: { message: "Token has expired or is invalid" } });
    const { confirmEmailLinkAction } = await import("../src/server/actions/auth");
    await expect(confirmEmailLinkAction(null, form({ token_hash: HASH, type: "email", next: "/welcome" }))).resolves.toMatchObject({ ok: false, error: EMAIL_LINK_INVALID });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("rejects malformed links before calling Supabase", async () => {
    const { confirmEmailLinkAction } = await import("../src/server/actions/auth");
    await expect(confirmEmailLinkAction(null, form({ token_hash: "x", type: "email" }))).resolves.toMatchObject({ ok: false, error: EMAIL_LINK_INVALID });
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("does nothing in demo mode", async () => {
    mocks.mode = "demo";
    const { confirmEmailLinkAction } = await import("../src/server/actions/auth");
    await expect(confirmEmailLinkAction(null, form({ token_hash: HASH, type: "email" }))).resolves.toMatchObject({ ok: false });
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });
});
