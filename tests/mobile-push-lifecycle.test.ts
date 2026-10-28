import { describe, expect, it } from "vitest";
import { createPushLifecycle, type PushLifecycleDeps } from "../apps/mobile/lib/pushLifecycle";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const TOKEN = "ExponentPushToken[phone_1]";

/** A fake phone and server that record what happened, in order. */
function phone(overrides: Partial<PushLifecycleDeps> = {}) {
  const log: string[] = [];
  const server = new Set<string>();
  let remembered: string | null = null;
  let signedIn = true;
  const deps: PushLifecycleDeps = {
    obtainToken: async () => TOKEN,
    currentToken: async () => remembered,
    saveServerToken: async (t) => {
      log.push("save");
      server.add(t);
    },
    removeServerToken: async (t) => {
      if (!signedIn) throw new Error("Authentication required");
      log.push("remove");
      server.delete(t);
    },
    unregisterDevice: async () => {
      log.push("unregister");
    },
    rememberToken: async (t) => {
      remembered = t;
    },
    forgetToken: async () => {
      remembered = null;
    },
    signOut: async () => {
      log.push("signOut");
      signedIn = false;
    },
    ...overrides,
  };
  return { deps, log, server, remembered: () => remembered, signedIn: () => signedIn };
}

describe("mobile push token on sign-out", () => {
  it("removes the token on the server and unregisters the device before the session ends", async () => {
    const p = phone();
    const push = createPushLifecycle(p.deps);
    expect(await push.register()).toBe(TOKEN);
    expect(p.server.has(TOKEN)).toBe(true);
    expect(await push.signOut()).toEqual({ serverRemoved: true, deviceUnregistered: true });
    expect(p.log).toEqual(["save", "remove", "unregister", "signOut"]);
    expect(p.server.size).toBe(0);
    expect(p.remembered()).toBeNull();
  });

  it("still unregisters locally and signs out when the server cannot be reached", async () => {
    const p = phone({ removeServerToken: async () => { throw new Error("Network request failed"); } });
    const push = createPushLifecycle(p.deps);
    await push.register();
    expect(await push.signOut()).toEqual({ serverRemoved: false, deviceUnregistered: true });
    expect(p.log).toEqual(["save", "unregister", "signOut"]);
    expect(p.signedIn()).toBe(false);
  });

  it("signs out even when unregistering and forgetting the token fail", async () => {
    const p = phone({
      unregisterDevice: async () => { throw new Error("native error"); },
      forgetToken: async () => { throw new Error("keystore error"); },
    });
    const push = createPushLifecycle(p.deps);
    await push.register();
    expect(await push.signOut()).toEqual({ serverRemoved: true, deviceUnregistered: false });
    expect(p.signedIn()).toBe(false);
  });

  it("with no token on this device, only signs out", async () => {
    const p = phone();
    const push = createPushLifecycle(p.deps);
    await push.signOut();
    expect(p.log).toEqual(["signOut"]);
  });

  it("a registration in flight is awaited and cannot add the token once sign-out began", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = phone({
      obtainToken: async () => {
        await gate;
        return TOKEN;
      },
    });
    const push = createPushLifecycle(p.deps);
    const registering = push.register();
    const signingOut = push.signOut();
    release();
    await Promise.all([registering, signingOut]);
    // The registration finishes after sign-out began, so it never saves the token.
    expect(await registering).toBeNull();
    expect(p.server.size).toBe(0);
    expect(p.log).toEqual(["signOut"]);
  });

  it("does not register while signing out, and registers again for the next account", async () => {
    let release!: () => void;
    const p = phone({ signOut: () => new Promise<void>((r) => (release = r)) });
    const push = createPushLifecycle(p.deps);
    await push.register();
    const out = push.signOut();
    await Promise.resolve();
    expect(await push.register()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await out;
    expect(await push.register()).toBe(TOKEN);
    expect(p.remembered()).toBe(TOKEN);
  });

  it("propagates a sign-out failure so the screen can say so", async () => {
    const p = phone({ signOut: async () => { throw new Error("offline"); } });
    await expect(createPushLifecycle(p.deps).signOut()).rejects.toThrow(/offline/);
  });

  it("shares one registration between concurrent calls", async () => {
    const p = phone();
    const push = createPushLifecycle(p.deps);
    await Promise.all([push.register(), push.register()]);
    expect(p.log.filter((x) => x === "save")).toHaveLength(1);
  });
});

describe("removing an Expo push token under RLS (what removePushToken sends)", () => {
  const theo = SEED_USERS.find((u) => u.username === "theo")!.id;
  const nina = SEED_USERS.find((u) => u.username === "nina")!.id;

  it("a user deletes their own device's token and cannot delete anyone else's", async () => {
    const db = await createSeededDb();
    const theirs = "ExponentPushToken[nina_phone]";
    await queryAs(db, theo, "select public.save_expo_push_token($1)", [TOKEN]);
    await queryAs(db, nina, "select public.save_expo_push_token($1)", [theirs]);

    await queryAs(db, theo, "delete from public.push_subscriptions where kind = 'expo' and endpoint = $1", [theirs]);
    await queryAs(db, null, "delete from public.push_subscriptions where endpoint = $1", [theirs]).catch(() => {});
    expect((await db.query("select user_id from public.push_subscriptions where endpoint = $1", [theirs])).rows).toEqual([{ user_id: nina }]);

    await queryAs(db, theo, "delete from public.push_subscriptions where kind = 'expo' and endpoint = $1", [TOKEN]);
    expect((await db.query("select 1 from public.push_subscriptions where endpoint = $1", [TOKEN])).rows).toEqual([]);
  });
});
