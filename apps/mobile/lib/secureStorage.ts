/**
 * The Supabase session on phones lives in the OS keystore (expo-secure-store:
 * iOS Keychain, Android Keystore), not in AsyncStorage, which is a plain file.
 *
 * SecureStore values should stay under 2048 bytes and a session (access token,
 * refresh token, user) is larger, so each value is split into chunks. A small
 * manifest under the key itself names the chunk generation and count, and is
 * written only after every chunk of that generation is stored: a crash midway
 * leaves the previous session readable, never a half-written one.
 *
 * A session left in AsyncStorage by an earlier build is moved here on first
 * read and deleted from AsyncStorage. Removing a key (sign-out) removes both.
 *
 * Pure TypeScript with the stores passed in, so it is unit-tested without a
 * device (tests/mobile-secure-storage.test.ts).
 */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** UTF-16 code units per chunk: at most 3 UTF-8 bytes each, so ≤ 1800 bytes. */
export const CHUNK_CHARS = 600;
const MANIFEST = /^chunked:v1:([a-z0-9]{1,16}):(\d{1,4})$/;
/** SecureStore accepts only these characters in keys. */
const SAFE_KEY = /[^A-Za-z0-9._-]/g;

export function splitChunks(value: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < value.length) {
    let end = Math.min(i + size, value.length);
    // Never end a chunk between the two halves of a surrogate pair: a lone
    // surrogate does not survive the native UTF-8 round trip.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(i, end));
    i = end;
  }
  return chunks.length ? chunks : [""];
}

export function createChunkedSecureStorage(
  secure: KeyValueStore,
  options: { legacy?: KeyValueStore; newGeneration?: () => string } = {},
): KeyValueStore {
  const { legacy } = options;
  const newGeneration = options.newGeneration ?? (() => Math.random().toString(36).slice(2, 10) || "0");
  const base = (key: string) => key.replace(SAFE_KEY, "_");
  const chunkKey = (key: string, gen: string, i: number) => `${base(key)}.${gen}.${i}`;

  async function readManifest(key: string): Promise<{ gen: string; count: number } | null> {
    const m = MANIFEST.exec((await secure.getItem(base(key))) ?? "");
    return m ? { gen: m[1], count: Number(m[2]) } : null;
  }

  async function removeChunks(key: string, manifest: { gen: string; count: number } | null) {
    if (!manifest) return;
    for (let i = 0; i < manifest.count; i++) await secure.removeItem(chunkKey(key, manifest.gen, i));
  }

  async function write(key: string, value: string) {
    const previous = await readManifest(key);
    let gen = newGeneration();
    if (gen === previous?.gen) gen = `${gen}x`.slice(-16);
    const chunks = splitChunks(value);
    for (let i = 0; i < chunks.length; i++) await secure.setItem(chunkKey(key, gen, i), chunks[i]);
    await secure.setItem(base(key), `chunked:v1:${gen}:${chunks.length}`);
    await removeChunks(key, previous);
  }

  return {
    async getItem(key) {
      const manifest = await readManifest(key);
      if (manifest) {
        const parts: string[] = [];
        for (let i = 0; i < manifest.count; i++) {
          const part = await secure.getItem(chunkKey(key, manifest.gen, i));
          if (part === null) return null; // incomplete: treat as signed out rather than hand back a corrupt session
          parts.push(part);
        }
        return parts.join("");
      }
      if (!legacy) return null;
      const old = await legacy.getItem(key);
      if (old === null) return null;
      await write(key, old);
      await legacy.removeItem(key);
      return old;
    },
    async setItem(key, value) {
      await write(key, value);
      if (legacy) await legacy.removeItem(key);
    },
    async removeItem(key) {
      await removeChunks(key, await readManifest(key));
      await secure.removeItem(base(key));
      if (legacy) await legacy.removeItem(key);
    },
  };
}
