import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { featureEnabled, pushTransportReady } from "../src/lib/config";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { combinedSender, runNotificationJobs, type PushSender } from "../src/server/notifications/push";
import type { PushDevice } from "../src/lib/data/types";

const mocks = vi.hoisted(() => ({ webSend: vi.fn(), webFactory: vi.fn() }));
vi.mock("@/server/notifications/push", async (original) => {
  const real = await original<typeof import("../src/server/notifications/push")>();
  return { ...real, webPushSender: mocks.webFactory };
});
const user = (name: string) => SEED_USERS.find((u) => u.username === name)!.id;
const [member, other, actor] = ["theo", "nina", "maya_r"].map(user);
const web: PushDevice = { kind: "web", endpoint: "https://fcm.googleapis.com/fcm/send/transport-test", p256dh: "key", auth: "auth" };
const expo: PushDevice = { kind: "expo", endpoint: "ExponentPushToken[transport_test]", p256dh: null, auth: null };
async function follow(repo: ReturnType<typeof createDemoRepository>, target: string) {
  // Seed users can already follow each other; require a NEW follow to notify.
  await repo.profiles.unfollow(actor, target);
  await repo.profiles.follow(actor, target);
}
// Seed events are scheduled relative to now, and these users attend some: at
// some hours one falls in the reminder window and adds pushes these tests did
// not ask for. Reminders have their own test in notifications.test.ts.
function isolatedStore() {
  const h = createIsolatedStore();
  h.state.eventAttendees = h.state.eventAttendees.filter((a) => a.userId !== member && a.userId !== other);
  return h;
}
beforeEach(() => { vi.clearAllMocks(); }); afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("transport readiness", () => {
  it("Expo opt-in does not require VAPID, but browser opt-in still requires both keys", () => {
    const env = { NEXT_PUBLIC_FEATURES: "notifications,push" };
    expect(featureEnabled("push", env)).toBe(true);
    expect(pushTransportReady("expo", env)).toBe(true); expect(pushTransportReady("web", env)).toBe(false);
    expect(pushTransportReady("web", { ...env, VAPID_PUBLIC_KEY: "pub" })).toBe(false);
    expect(pushTransportReady("web", { ...env, VAPID_PRIVATE_KEY: "priv" })).toBe(false);
    expect(pushTransportReady("web", { ...env, VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" })).toBe(true);
  });
  it("disabled push overrides every credential; all opts both transports in", () => {
    const keys = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", EXPO_ACCESS_TOKEN: "secret" };
    expect(pushTransportReady("expo", { ...keys, NEXT_PUBLIC_FEATURES: "notifications" })).toBe(false);
    expect(pushTransportReady("web", { ...keys, NEXT_PUBLIC_FEATURES: "notifications" })).toBe(false);
    expect(pushTransportReady("expo", { NEXT_PUBLIC_FEATURES: "all" })).toBe(true);
  });
});

describe("ready-only queue consumption", () => {
  it("Expo-only sender leaves browser-only work pending, then web readiness delivers it", async () => {
    const h = isolatedStore(), repo = createDemoRepository(h); const send = vi.fn(async () => ({ ok: true as const }));
    await repo.notifications.addDevice(member, web); await repo.notifications.addDevice(other, expo);
    await follow(repo, member); await follow(repo, other);
    expect(await runNotificationJobs(repo, combinedSender(null, { send }))).toMatchObject({ claimed: 1, sent: 1 });
    expect(h.state.notifications.find((n) => n.userId === member)?.pushState).toBe("pending");
    expect(h.state.notifications.find((n) => n.userId === other)?.pushState).toBe("sent");
    expect(await runNotificationJobs(repo, combinedSender({ send }, null))).toMatchObject({ claimed: 1, sent: 1 });
  });
  it("mixed devices receive the ready kind first and delayed kind later, without duplicate sends or cap charges", async () => {
    const h = isolatedStore(), repo = createDemoRepository(h);
    await repo.notifications.addDevice(member, web); await repo.notifications.addDevice(member, expo); await follow(repo, member);
    const expoSend = vi.fn(async () => ({ ok: true as const })), webSend = vi.fn(async () => ({ ok: true as const }));
    expect(await runNotificationJobs(repo, combinedSender(null, { send: expoSend }))).toMatchObject({ claimed: 1, sent: 1 });
    const n = h.state.notifications.find((x) => x.userId === member)!;
    expect(n.pushState).toBe("pending"); expect(n.pushClaimedKinds).toEqual(["expo"]);
    expect(await runNotificationJobs(repo, combinedSender(null, { send: expoSend }))).toMatchObject({ claimed: 0, sent: 0 });
    expect(await runNotificationJobs(repo, combinedSender({ send: webSend }, { send: expoSend }))).toMatchObject({ claimed: 1, sent: 1 });
    expect(n.pushState).toBe("sent"); expect(expoSend).toHaveBeenCalledOnce(); expect(webSend).toHaveBeenCalledOnce();
    expect(h.state.pushLog.filter((l) => l.notificationId === n.id)).toHaveLength(1);
  });
  it("missing/empty readiness does not claim work", async () => {
    const h = isolatedStore(), repo = createDemoRepository(h); await repo.notifications.addDevice(member, web); await follow(repo, member);
    const claim = vi.spyOn(repo.notifications, "claimPushes");
    expect(await runNotificationJobs(repo, null)).toMatchObject({ claimed: 0 });
    expect(await runNotificationJobs(repo, { supportedKinds: [], send: vi.fn() })).toMatchObject({ claimed: 0 });
    expect(claim).not.toHaveBeenCalled(); expect(h.state.notifications.find((n) => n.userId === member)?.pushState).toBe("pending");
  });
  it("an unsendable oldest notification does not starve another transport behind a small batch limit", async () => {
    const h = isolatedStore(), repo = createDemoRepository(h);
    await repo.notifications.addDevice(member, web); await repo.notifications.addDevice(other, expo);
    await follow(repo, member); await follow(repo, other);
    const browser = h.state.notifications.find((n) => n.userId === member)!; browser.createdAt = new Date(Date.now() - 60000).toISOString();
    expect((await repo.notifications.claimPushes(new Date().toISOString(), 1, ["expo"])).map((c) => c.userId)).toEqual([other]);
    expect(browser.pushState).toBe("pending");
  });
  it("a ready transport failure is reported, but does not consume the unready transport", async () => {
    const h = isolatedStore(), repo = createDemoRepository(h);
    await repo.notifications.addDevice(member, web); await repo.notifications.addDevice(member, expo); await follow(repo, member);
    const sender: PushSender = { supportedKinds: ["expo"], send: vi.fn(async () => ({ ok: false, gone: false })) };
    expect(await runNotificationJobs(repo, sender)).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(h.state.notifications.find((n) => n.userId === member)).toMatchObject({ pushState: "pending", pushClaimedKinds: ["expo"] });
    expect((await repo.notifications.claimPushes(new Date().toISOString(), 100, ["web"]))[0].devices).toEqual([web]);
  });
});

describe("actual notification cron configuration", () => {
  async function setup(features: string, vapid = false) {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", features); vi.stubEnv("CRON_SECRET", "test-cron");
    vi.stubEnv("VAPID_PUBLIC_KEY", vapid ? "pub" : ""); vi.stubEnv("VAPID_PRIVATE_KEY", vapid ? "priv" : "");
    globalThis.__findmaxxingDemoStore = isolatedStore(); const repo = createDemoRepository(globalThis.__findmaxxingDemoStore);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { status: "ok", id: "mock_receipt" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher); mocks.webSend.mockResolvedValue({ ok: true });
    mocks.webFactory.mockResolvedValue({ supportedKinds: ["web"], send: mocks.webSend });
    const { GET } = await import("../src/app/api/cron/notifications/route");
    const run = async (authorized = true) => GET(new Request("https://example.test/api/cron/notifications", { headers: authorized ? { authorization: "Bearer test-cron" } : {} }));
    return { repo, run, fetcher, h: globalThis.__findmaxxingDemoStore };
  }
  it("Expo-only configuration sends through the real Expo adapter without VAPID and defers browser work", async () => {
    const s = await setup("notifications,push");
    await s.repo.notifications.addDevice(member, expo); await s.repo.notifications.addDevice(other, web);
    await follow(s.repo, member); await follow(s.repo, other);
    expect(await (await s.run()).json()).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(mocks.webFactory).not.toHaveBeenCalled(); expect(s.fetcher).toHaveBeenCalledOnce();
    expect(s.fetcher).toHaveBeenCalledWith("https://exp.host/--/api/v2/push/send", expect.objectContaining({ method: "POST", body: expect.stringContaining(expo.endpoint) }));
    expect(s.h.state.notifications.find((n) => n.userId === other)?.pushState).toBe("pending");
  });
  it("browser-only devices use only browser delivery when VAPID is configured", async () => {
    const s = await setup("notifications,push", true); await s.repo.notifications.addDevice(member, web); await follow(s.repo, member);
    expect(await (await s.run()).json()).toMatchObject({ claimed: 1, sent: 1 });
    expect(mocks.webSend).toHaveBeenCalledOnce(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("mixed configuration sends both kinds exactly once", async () => {
    const s = await setup("notifications,push", true);
    await s.repo.notifications.addDevice(member, web); await s.repo.notifications.addDevice(member, expo); await follow(s.repo, member);
    expect(await (await s.run()).json()).toMatchObject({ claimed: 1, sent: 2 });
    expect(await (await s.run()).json()).toMatchObject({ claimed: 0, sent: 0 });
    expect(mocks.webSend).toHaveBeenCalledOnce(); expect(s.fetcher).toHaveBeenCalledOnce();
  });
  it("disabled push and missing cron authorization perform no delivery or claims", async () => {
    const s = await setup("notifications", true);
    await s.repo.notifications.addDevice(member, expo); await s.repo.notifications.addDevice(member, web); await follow(s.repo, member);
    expect((await s.run(false)).status).toBe(401);
    expect(await (await s.run()).json()).toMatchObject({ claimed: 0, sent: 0 });
    expect(s.fetcher).not.toHaveBeenCalled(); expect(mocks.webFactory).not.toHaveBeenCalled();
    expect(s.h.state.notifications.find((n) => n.userId === member)?.pushState).toBe("pending");
  });
  it("mixed devices recover the unready browser kind when credentials return, through the cron itself", async () => {
    const s = await setup("notifications,push");
    await s.repo.notifications.addDevice(member, web); await s.repo.notifications.addDevice(member, expo); await follow(s.repo, member);
    expect(await (await s.run()).json()).toMatchObject({ claimed: 1, sent: 1 });
    expect(s.h.state.notifications.find((n) => n.userId === member)?.pushState).toBe("pending");
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub"); vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(await (await s.run()).json()).toMatchObject({ claimed: 1, sent: 1 });
    expect(s.fetcher).toHaveBeenCalledOnce(); expect(mocks.webSend).toHaveBeenCalledOnce();
    expect(s.h.state.notifications.find((n) => n.userId === member)?.pushState).toBe("sent");
  });
});
