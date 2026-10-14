import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ redirect: vi.fn((destination: string) => { throw Object.assign(new Error("redirect"), { destination, digest: "NEXT_REDIRECT" }); }), cookie: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookie }) }));
vi.mock("@/lib/config", () => ({ getDataMode: () => "demo", getSiteUrl: () => "https://findmaxxing.test" }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ({ id: "viewer" }) }));
vi.mock("@/server/http/clientIp", () => ({ clientIp: async () => "test-ip" }));
vi.mock("@/server/limiters", () => ({ limiters: () => ({ signUp: { consume: () => null } }) }));
vi.mock("@/lib/data/demo/auth", () => ({ DEMO_SESSION_COOKIE: "test-session", demoSignIn: () => ({ userId: "viewer" }), demoSignUp: () => ({ userId: "viewer" }) }));

beforeEach(() => vi.clearAllMocks());

function form(next: string) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ next, email: "test@example.test", password: "test-password-123", username: "test_user", displayName: "Test User" })) data.set(key, value);
  return data;
}

describe("auth entry points use the same redirect boundary", () => {
  it.each(["/\\evil.test", "/%255cevil.test", "//evil.test"])("validates submitted next=%s in every auth action", async (next) => {
    const { signInAction, signUpAction, demoQuickSignInAction } = await import("../src/server/actions/auth");
    await expect(signInAction(null, form(next))).rejects.toMatchObject({ destination: "/" });
    await expect(signUpAction(null, form(next))).rejects.toMatchObject({ destination: "/welcome" });
    await expect(demoQuickSignInAction(form(next))).rejects.toMatchObject({ destination: "/" });
  });
  it.each(["/\\evil.test", "/%255cevil.test", "//evil.test"])("validates next=%s on already-signed-in auth pages", async (next) => {
    const { default: SignIn } = await import("../src/app/auth/sign-in/page");
    const { default: SignUp } = await import("../src/app/auth/sign-up/page");
    await expect(SignIn({ params: Promise.resolve({}), searchParams: Promise.resolve({ next }) })).rejects.toMatchObject({ destination: "/" });
    await expect(SignUp({ params: Promise.resolve({}), searchParams: Promise.resolve({ next }) })).rejects.toMatchObject({ destination: "/welcome" });
  });
  it("retains legitimate destinations for submitted forms and signed-in pages", async () => {
    const next = "/saved?view=all#lists";
    const { signInAction, signUpAction, demoQuickSignInAction } = await import("../src/server/actions/auth");
    for (const action of [() => signInAction(null, form(next)), () => signUpAction(null, form(next)), () => demoQuickSignInAction(form(next))]) await expect(action()).rejects.toMatchObject({ destination: next });
    const { default: SignIn } = await import("../src/app/auth/sign-in/page");
    const { default: SignUp } = await import("../src/app/auth/sign-up/page");
    await expect(SignIn({ params: Promise.resolve({}), searchParams: Promise.resolve({ next }) })).rejects.toMatchObject({ destination: next });
    await expect(SignUp({ params: Promise.resolve({}), searchParams: Promise.resolve({ next }) })).rejects.toMatchObject({ destination: next });
  });
});
