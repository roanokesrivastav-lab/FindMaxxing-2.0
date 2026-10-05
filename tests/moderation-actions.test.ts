/**
 * Session 8 server actions against a real (isolated) demo repository:
 * moderation, the sign-up limiter and the home city cooldown. Only auth,
 * next/cache and the request headers are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { SIGN_UP_LIMIT } from "../src/lib/rateLimits";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const sam = user("sam_k");
const maya = user("maya_r");
const lumen = stableId("place:The Lumen Rooftop");

const ctx: { viewer: string | null; repo: DataRepository; ip: string } = { viewer: sam, repo: createDemoRepository(createIsolatedStore()), ip: "203.0.113.7" };
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => (ctx.viewer ? { id: ctx.viewer, profile: await ctx.repo.profiles.getById(ctx.viewer) } : null),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `${ctx.ip}, 10.0.0.1` }),
  cookies: async () => ({ set: () => {}, get: () => undefined, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
}));

const { resolveReportsAction, setLocalStatusAction } = await import("../src/server/actions/moderation");
const { signUpAction } = await import("../src/server/actions/auth");
const { updateProfileAction } = await import("../src/server/actions/profile");
const { limiters } = await import("../src/server/limiters");

beforeEach(() => {
  ctx.viewer = sam;
  ctx.repo = createDemoRepository(createIsolatedStore());
  ctx.ip = "203.0.113.7";
  revalidatePath.mockClear();
  limiters().signUp.reset();
});

describe("moderation actions", () => {
  it("require a signed-in moderator", async () => {
    ctx.viewer = null;
    expect(await resolveReportsAction({ targetType: "place", targetId: lumen, action: "dismiss" })).toMatchObject({ ok: false, code: "unauthenticated" });
    ctx.viewer = maya;
    expect(await resolveReportsAction({ targetType: "place", targetId: lumen, action: "dismiss" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setLocalStatusAction({ userId: maya, revoked: true, reason: "x" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("validate input before touching data", async () => {
    expect(await resolveReportsAction({ targetType: "place", targetId: "nope", action: "dismiss" })).toMatchObject({ ok: false });
    expect(await resolveReportsAction({ targetType: "place", targetId: lumen, action: "delete" as "dismiss" })).toMatchObject({ ok: false });
    expect(await setLocalStatusAction({ userId: maya, revoked: true, reason: "   " })).toMatchObject({ ok: false, fieldErrors: { reason: "Give a reason" } });
  });

  it("put a missing removal reason on the reason field", async () => {
    expect(await resolveReportsAction({ targetType: "place", targetId: lumen, action: "remove", reason: "  " })).toMatchObject({
      ok: false,
      fieldErrors: { reason: "Give a reason" },
    });
  });

  it("resolve, then refresh the queue, the target's page and discovery", async () => {
    const res = await resolveReportsAction({ targetType: "place", targetId: lumen, action: "remove", reason: "Unsafe" });
    expect(res).toEqual({ ok: true, data: { statusAfter: "removed", resolvedReports: 1 } });
    expect(revalidatePath).toHaveBeenCalledWith("/moderation", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/places/${lumen}`);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(await ctx.repo.places.get(lumen, null)).toBeNull();
    expect(await resolveReportsAction({ targetType: "place", targetId: lumen, action: "remove", reason: "Again" })).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("sign-up limit", () => {
  const form = (n: number) => {
    const f = new FormData();
    f.set("email", `new${n}@example.test`);
    f.set("password", "a-long-password");
    f.set("username", `newbie_${n}`);
    f.set("displayName", `Newbie ${n}`);
    return f;
  };

  it("allows a handful of sign-ups per network per hour, then says how long to wait", async () => {
    for (let i = 0; i < SIGN_UP_LIMIT.max; i++) {
      await expect(signUpAction(null, form(i))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    }
    const blocked = await signUpAction(null, form(99));
    expect(blocked).toMatchObject({ ok: false, code: "rate_limited", error: expect.stringMatching(/^Too many sign-ups from this network\. Try again in /) });
    // Another network is unaffected.
    ctx.ip = "198.51.100.4";
    await expect(signUpAction(null, form(100))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
});

describe("home city cooldown", () => {
  const profileForm = (homeCity: string) => {
    const f = new FormData();
    f.set("username", "maya_r");
    f.set("displayName", "Maya Reyes");
    f.set("bio", "");
    f.set("homeCity", homeCity);
    return f;
  };

  it("puts the next allowed date on the home city field", async () => {
    ctx.viewer = maya;
    await expect(updateProfileAction(null, profileForm("Dayton"))).rejects.toMatchObject({ digest: expect.stringContaining("/profile") });
    const res = await updateProfileAction(null, profileForm("Columbus"));
    expect(res).toMatchObject({ ok: false, fieldErrors: { homeCity: expect.stringMatching(/^You can change your home city again on /) } });
  });
});
