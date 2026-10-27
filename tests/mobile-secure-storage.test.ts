import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, createChunkedSecureStorage, splitChunks, type KeyValueStore } from "../apps/mobile/lib/secureStorage";

/** An in-memory store that, like SecureStore, refuses values over 2048 UTF-8 bytes and unsafe keys. */
function memory(opts: { limitBytes?: number; failOnSet?: (key: string) => boolean } = {}) {
  const data = new Map<string, string>();
  const store: KeyValueStore = {
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`invalid key ${key}`);
      if (opts.limitBytes && Buffer.byteLength(value, "utf8") > opts.limitBytes) throw new Error("value too large");
      if (opts.failOnSet?.(key)) throw new Error("keystore unavailable");
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  return { store, data };
}

const KEY = "sb-abcdefghijklmnop-auth-token";
const session = (extra = "") =>
  JSON.stringify({ access_token: "a".repeat(1100), refresh_token: "r".repeat(40), user: { id: "u1", user_metadata: { name: `Zoë 🍜 ${extra}` } } });

describe("mobile session storage in the OS keystore", () => {
  it("round-trips a session larger than one SecureStore value, every chunk under 2048 bytes", async () => {
    const secure = memory({ limitBytes: 2048 });
    const storage = createChunkedSecureStorage(secure.store);
    const value = session("x".repeat(3000));
    await storage.setItem(KEY, value);
    expect(await storage.getItem(KEY)).toBe(value);
    expect(secure.data.size).toBeGreaterThan(2);
    for (const v of secure.data.values()) expect(Buffer.byteLength(v, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("keeps multi-byte text intact, never splitting a surrogate pair", async () => {
    const emoji = "🍜".repeat(CHUNK_CHARS); // every code point is two UTF-16 units, four UTF-8 bytes
    const chunks = splitChunks(`a${emoji}`);
    expect(chunks.join("")).toBe(`a${emoji}`);
    for (const c of chunks) {
      expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(2048);
      expect(/[\ud800-\udbff]$/.test(c)).toBe(false);
    }
    const storage = createChunkedSecureStorage(memory({ limitBytes: 2048 }).store);
    await storage.setItem(KEY, emoji);
    expect(await storage.getItem(KEY)).toBe(emoji);
  });

  it("sanitizes keys to what SecureStore accepts", async () => {
    const storage = createChunkedSecureStorage(memory().store);
    await storage.setItem("sb:odd key/with@chars", "v");
    expect(await storage.getItem("sb:odd key/with@chars")).toBe("v");
  });

  it("replaces a session without leaving the previous chunks behind", async () => {
    const secure = memory();
    const storage = createChunkedSecureStorage(secure.store);
    await storage.setItem(KEY, session("first".repeat(400)));
    await storage.setItem(KEY, session("second"));
    expect(await storage.getItem(KEY)).toBe(session("second"));
    const chunkCount = splitChunks(session("second")).length;
    expect(secure.data.size).toBe(chunkCount + 1); // chunks plus the manifest
  });

  it("keeps the previous session readable when a write fails midway", async () => {
    let failing = false;
    const secure = memory({ failOnSet: (key) => failing && key.endsWith(".1") });
    let gen = 0;
    const storage = createChunkedSecureStorage(secure.store, { newGeneration: () => `g${gen++}` });
    await storage.setItem(KEY, session("old"));
    failing = true;
    await expect(storage.setItem(KEY, session("new"))).rejects.toThrow(/keystore unavailable/);
    expect(await storage.getItem(KEY)).toBe(session("old"));
  });

  it("reads a missing chunk as no session rather than a corrupt one", async () => {
    const secure = memory();
    const storage = createChunkedSecureStorage(secure.store);
    await storage.setItem(KEY, session());
    const chunk = [...secure.data.keys()].find((k) => k.endsWith(".1"))!;
    secure.data.delete(chunk);
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("moves a session left in AsyncStorage by an older build into the keystore", async () => {
    const secure = memory();
    const legacy = memory();
    legacy.data.set(KEY, session("legacy"));
    legacy.data.set("unrelated", "kept");
    const storage = createChunkedSecureStorage(secure.store, { legacy: legacy.store });
    expect(await storage.getItem(KEY)).toBe(session("legacy"));
    expect(legacy.data.has(KEY)).toBe(false);
    expect(legacy.data.get("unrelated")).toBe("kept");
    // Read again from the keystore alone.
    expect(await createChunkedSecureStorage(secure.store).getItem(KEY)).toBe(session("legacy"));
  });

  it("leaves the legacy copy in place if the keystore write fails, so nobody is signed out by the upgrade", async () => {
    const legacy = memory();
    legacy.data.set(KEY, session("legacy"));
    const storage = createChunkedSecureStorage(memory({ failOnSet: () => true }).store, { legacy: legacy.store });
    await expect(storage.getItem(KEY)).rejects.toThrow();
    expect(legacy.data.get(KEY)).toBe(session("legacy"));
  });

  it("prefers the keystore over a stale legacy copy, and new writes delete the legacy copy", async () => {
    const secure = memory();
    const legacy = memory();
    const storage = createChunkedSecureStorage(secure.store, { legacy: legacy.store });
    await storage.setItem(KEY, session("current"));
    legacy.data.set(KEY, session("stale"));
    expect(await storage.getItem(KEY)).toBe(session("current"));
    await storage.setItem(KEY, session("refreshed"));
    expect(legacy.data.has(KEY)).toBe(false);
  });

  it("sign-out removes every chunk, the manifest and any legacy copy", async () => {
    const secure = memory();
    const legacy = memory();
    const storage = createChunkedSecureStorage(secure.store, { legacy: legacy.store });
    await storage.setItem(KEY, session("x".repeat(2000)));
    legacy.data.set(KEY, session("stale"));
    await storage.removeItem(KEY);
    expect(secure.data.size).toBe(0);
    expect(legacy.data.size).toBe(0);
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("stores an empty string", async () => {
    const storage = createChunkedSecureStorage(memory().store);
    await storage.setItem(KEY, "");
    expect(await storage.getItem(KEY)).toBe("");
  });
});
