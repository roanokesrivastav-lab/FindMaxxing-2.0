import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupOptions } from "node:dns";
import type { Agent } from "node:https";
import { safeAuthNext } from "../src/lib/auth/redirect";
import { isWebPushEndpoint } from "../src/lib/security/pushEndpoints";
import { isPublicPushAddress, webPushAgent } from "../src/server/notifications/pushAgent";
import { webPushSender } from "../src/server/notifications/push";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), send: vi.fn(), exchange: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("web-push", () => ({ default: { sendNotification: mocks.send } }));
vi.mock("@/lib/config", () => ({ getDataMode: () => "supabase", getSiteUrl: () => "https://findmaxxing.test" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { exchangeCodeForSession: mocks.exchange } }) }));

export const validPushEndpoints = [
  "https://fcm.googleapis.com/fcm/send/test-token",
  "https://fcm.googleapis.com:443/wp/test-token",
  "https://updates.push.services.mozilla.com/wpush/v2/test-token",
  "https://web.push.apple.com/Q/test-token",
  "https://region.web.push.apple.com/Q/test-token",
  "https://wns2-test.notify.windows.com/w/?token=test-token",
];
export const invalidPushEndpoints = [
  "https://127.0.0.1/internal", "https://2130706433/internal", "https://0x7f000001/internal",
  "https://[::1]/internal", "https://[::ffff:127.0.0.1]/internal", "https://169.254.169.254/latest",
  "https://10.1.2.3/internal", "http://fcm.googleapis.com/fcm/send/test-token",
  "https://fcm.googleapis.com:8443/fcm/send/test-token", "https://user:pass@fcm.googleapis.com/fcm/send/test-token",
  "https://fcm.googleapis.com.evil.test/a", "https://evilfcm.googleapis.com/a",
  "https://push.apple.com.evil.test/a", "https://evilpush.apple.com/a",
  "https://notify.windows.com.evil.test/a", "https://evil.test/a", "https://fcm.googleapis.com\\@evil.test/a",
  "https://fcm.googleapis.com/a#fragment", "https://fcm.googleapis.com/a\n", "https://fcm.googleapis.com/",
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "142.250.1.1", family: 4 }]);
  mocks.send.mockResolvedValue({ statusCode: 201 });
  mocks.exchange.mockResolvedValue({ error: null });
});

describe("auth redirect boundary", () => {
  it.each(["/saved", "/saved?sort=recent#lists", "/neighborhoods/Short%20North", "/saved?q=https%3A%2F%2Fexample.com"])("preserves legitimate relative destination %s", (path) => {
    expect(safeAuthNext(path)).toBe(path);
  });
  it.each(["//evil.test", "/\\evil.test", "https://evil.test", "/%5cevil.test", "/%2f%2fevil.test", "/%255cevil.test", "/%252f%252fevil.test", "/\tevil.test", "/%0devil.test", "/%00evil.test", "/%zz", null, ["/saved"]])("refuses an unsafe destination %s", (path) => {
    expect(safeAuthNext(path)).toBe("/");
    expect(safeAuthNext(path, "/welcome")).toBe("/welcome");
  });
  it("rejects dot-segment normalization into a protocol-relative-looking path", () => {
    expect(safeAuthNext("/a/..//evil.test")).toBe("/");
  });
  it("checks the actual callback Location header after successful code exchange", async () => {
    const { GET } = await import("../src/app/auth/callback/route");
    for (const next of ["/\\evil.test", "/%5cevil.test", "//evil.test", "/saved?tab=all#list"]) {
      const req = new URL("https://findmaxxing.test/auth/callback?code=test-code");
      req.searchParams.set("next", next);
      const response = await GET(new Request(req));
      expect(response.headers.get("location")).toBe(`https://findmaxxing.test${safeAuthNext(next)}`);
    }
    expect(mocks.exchange).toHaveBeenCalledWith("test-code");
  });
});

describe("push destination boundary", () => {
  it.each(validPushEndpoints)("accepts a supported provider %s", (endpoint) => expect(isWebPushEndpoint(endpoint)).toBe(true));
  it.each(invalidPushEndpoints)("rejects unsafe/unsupported endpoint %s", (endpoint) => expect(isWebPushEndpoint(endpoint)).toBe(false));
  it.each(["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.1.2.3", "255.255.255.255", "192.0.2.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "garbage"])("rejects nonpublic DNS address %s", (address) => {
    expect(isPublicPushAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "142.250.1.1", "2001:4860:4860::8888", "2606:4700::1111"])("allows public DNS address %s", (address) => expect(isPublicPushAddress(address)).toBe(true));
  it("pins DNS answers at the socket lookup, retaining the provider hostname for TLS", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "142.250.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    const agent = await webPushAgent(validPushEndpoints[0]);
    const cb = vi.fn();
    const pinnedLookup = agent.options.lookup as (host: string, options: LookupOptions, callback: typeof cb) => void;
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    pinnedLookup("fcm.googleapis.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [{ address: "142.250.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    pinnedLookup("fcm.googleapis.com", { family: 6 }, cb);
    expect(cb).toHaveBeenLastCalledWith(null, "2606:4700::1111", 6);
    pinnedLookup("evil.test", {}, cb);
    expect(cb.mock.lastCall?.[0]).toBeInstanceOf(Error);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    agent.destroy();
  });
  it("refuses a provider resolving to a private address, including mixed answers", async () => {
    for (const answers of [[], [{ address: "127.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:10.1.2.3", family: 6 }]]) {
      mocks.lookup.mockResolvedValueOnce(answers);
      await expect(webPushAgent(validPushEndpoints[0])).rejects.toThrow("Unsafe push DNS answer");
    }
  });
  it("revalidates legacy stored subscriptions before making any network request", async () => {
    const sender = (await webPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }))!;
    expect(await sender.send({ endpoint: "https://127.0.0.1/internal", p256dh: "k", auth: "a" }, "payload")).toEqual({ ok: false, gone: true });
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("refuses unsafe DNS without deleting a potentially legitimate subscription", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    const sender = (await webPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }))!;
    expect(await sender.send({ endpoint: validPushEndpoints[0], p256dh: "k", auth: "a" }, "payload")).toEqual({ ok: false, gone: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("passes the pinned agent into delivery and closes it afterwards", async () => {
    let usedAgent: Agent | undefined;
    let destroy: ReturnType<typeof vi.spyOn> | undefined;
    mocks.send.mockImplementationOnce(async (_sub, _payload, options) => {
      usedAgent = options.agent;
      destroy = vi.spyOn(usedAgent!, "destroy");
      return { statusCode: 201 };
    });
    const sender = (await webPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }))!;
    expect(await sender.send({ endpoint: validPushEndpoints[0], p256dh: "k", auth: "a" }, "payload")).toEqual({ ok: true });
    expect(usedAgent).toBeDefined();
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("does not follow redirects from a push provider", async () => {
    // web-push uses https.request and rejects non-2xx; it does not follow Location.
    mocks.send.mockRejectedValueOnce({ statusCode: 302, headers: { location: "https://127.0.0.1/internal" } });
    const sender = (await webPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }))!;
    expect(await sender.send({ endpoint: validPushEndpoints[0], p256dh: "k", auth: "a" }, "payload")).toEqual({ ok: false, gone: false });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("handles DNS outages without sending", async () => {
    mocks.lookup.mockRejectedValueOnce(new Error("DNS unavailable"));
    const sender = (await webPushSender({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" }))!;
    expect(await sender.send({ endpoint: validPushEndpoints[0], p256dh: "k", auth: "a" }, "payload")).toEqual({ ok: false, gone: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
