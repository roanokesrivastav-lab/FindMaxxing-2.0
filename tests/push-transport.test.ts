import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import type { Agent, RequestOptions } from "node:https";
import type { LookupAddress } from "node:dns";
import { afterEach, expect, it, vi } from "vitest";
import { webPushSender } from "../src/server/notifications/push";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
afterEach(() => vi.restoreAllMocks());

it("the real web-push library uses the pinned agent and does not follow a redirect", async () => {
  const require = createRequire(import.meta.url);
  const https = require("node:https") as typeof import("node:https");
  const push = require("web-push") as typeof import("web-push");
  const vapid = push.generateVAPIDKeys();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  mocks.lookup.mockResolvedValue([{ address: "142.250.1.1", family: 4 }]);
  const lookups: unknown[][] = [];
  const request = vi.spyOn(https, "request").mockImplementation(((options: RequestOptions, callback: (response: EventEmitter) => void) => {
    expect(options.hostname).toBe("fcm.googleapis.com");
    expect(options.agent).toBeInstanceOf(https.Agent);
    if (options.agent && typeof options.agent === "object") {
      (options.agent as Agent).options.lookup!("fcm.googleapis.com", { all: true }, (...args: [NodeJS.ErrnoException | null, string | LookupAddress[], number?]) => lookups.push(args));
    }
    const req = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end() {
        const res = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: "https://127.0.0.1/internal" } });
        callback(res);
        res.emit("end");
      },
    });
    return req;
  }) as unknown as typeof https.request);
  const sender = (await webPushSender({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: "mailto:test@example.test" }))!;
  expect(await sender.send({ endpoint: "https://fcm.googleapis.com/fcm/send/test-token", p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }, "encrypted payload")).toEqual({ ok: false, gone: false });
  expect(request).toHaveBeenCalledTimes(1);
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
  expect(lookups).toEqual([[null, [{ address: "142.250.1.1", family: 4 }]]]);
});
