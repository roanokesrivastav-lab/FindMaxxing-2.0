import { expect, it, vi } from "vitest";
import { cleanupStaging, stagingPreflight } from "../scripts/lib/staging-preflight";
import { e2eTargetError } from "../scripts/lib/e2e-target.mjs";
const env = { STAGING_PROJECT_REF: "disposablestage", STAGING_DATABASE_URL: "postgresql://postgres:never-log-this@db.disposablestage.supabase.co:5432/postgres", STAGING_SUPABASE_URL: "https://disposablestage.supabase.co", STAGING_SUPABASE_ANON_KEY: "anon", STAGING_SUPABASE_SERVICE_ROLE_KEY: "secret", STAGING_APP_URL: "https://staging.example.test" };
const allowed = new Set(["--allow-staging-writes"]);
it("refuses incomplete credentials and requires an explicit disposable-write acknowledgment", () => {
  expect(stagingPreflight({}, allowed)).toMatch(/Missing/);
  expect(stagingPreflight(env, new Set())).toMatch(/acknowledgment/);
  expect(stagingPreflight(env, allowed)).toBeNull();
});
it.each([
  { STAGING_SUPABASE_URL: "https://production.supabase.co" },
  { STAGING_DATABASE_URL: "postgres://postgres:secret@db.production.supabase.co/postgres" },
  { STAGING_SUPABASE_URL: "https://disposablestage.supabase.co.evil.test" },
  { STAGING_SUPABASE_URL: "https://user:secret@disposablestage.supabase.co" },
  { STAGING_APP_URL: "http://production.example.test" },
])("refuses mismatched or unsafe staging identities without echoing secrets: %j", (patch) => {
  const error = stagingPreflight({ ...env, ...patch }, allowed);
  expect(error).toBeTruthy(); expect(error).not.toContain("secret"); expect(error).not.toContain("never-log-this");
});
it("validates pooler usernames against the same staging project", () => {
  expect(stagingPreflight({ ...env, STAGING_DATABASE_URL: "postgres://postgres.disposablestage:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres" }, allowed)).toBeNull();
  expect(stagingPreflight({ ...env, STAGING_DATABASE_URL: "postgres://postgres.production:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres" }, allowed)).toMatch(/does not match/);
});
it("an absent app target requires explicit partial-run mode and unknown flags are rejected", () => {
  expect(stagingPreflight({ ...env, STAGING_APP_URL: "" }, allowed)).toMatch(/Missing STAGING_APP_URL/);
  expect(stagingPreflight({ ...env, STAGING_APP_URL: "" }, new Set([...allowed, "--skip-e2e"]))).toBeNull();
  expect(stagingPreflight(env, new Set([...allowed, "--skip-e2es"]))).toMatch(/Unknown/);
});
it("removes recorded Storage paths before Auth and counts response errors instead of claiming cleanup", async () => {
  const order: string[] = [];
  const remove = vi.fn(async () => { order.push("storage"); return { error: null }; });
  const deleteUser = vi.fn(async (id: string) => { order.push(id); return { error: id === "b" ? new Error("failed") : null }; });
  const result = await cleanupStaging({ storage: { from: () => ({ remove }) }, auth: { admin: { deleteUser } } }, ["a", "b"], ["a/photo.webp"]);
  expect(order).toEqual(["storage", "a", "b"]); expect(result).toEqual({ storageClean: true, removed: 1 });
});
it.each(["returned", "thrown"])("a %s Storage error preserves check users for recovery", async (kind) => {
  const remove = vi.fn(async () => { if (kind === "thrown") throw new Error("network failed"); return { error: new Error("failed") }; });
  const deleteUser = vi.fn();
  expect(await cleanupStaging({ storage: { from: () => ({ remove }) }, auth: { admin: { deleteUser } } }, ["a"], ["a/photo.webp"])).toEqual({ storageClean: false, removed: 0 });
  expect(deleteUser).not.toHaveBeenCalled();
});
it("cleanup refuses paths outside this invocation's recorded user IDs", async () => {
  const remove = vi.fn(), deleteUser = vi.fn();
  expect(await cleanupStaging({ storage: { from: () => ({ remove }) }, auth: { admin: { deleteUser } } }, ["a"], ["unrelated/photo.webp"])).toEqual({ storageClean: false, removed: 0 });
  expect(remove).not.toHaveBeenCalled(); expect(deleteUser).not.toHaveBeenCalled();
});
it("external browser writes require an explicit, exact disposable target acknowledgment", () => {
  expect(e2eTargetError({})).toBeNull();
  expect(e2eTargetError({ E2E_BASE_URL: "https://production.example.test" })).toMatch(/requires/);
  expect(e2eTargetError({ E2E_BASE_URL: "https://production.example.test", E2E_STAGING_BASE_URL: "https://staging.example.test", E2E_ALLOW_STAGING_WRITES: "1" })).toMatch(/requires/);
  expect(e2eTargetError({ E2E_BASE_URL: "https://staging.example.test", E2E_STAGING_BASE_URL: "https://staging.example.test", E2E_ALLOW_STAGING_WRITES: "1" })).toBeNull();
});
it("external browser targets cannot use credentials or non-HTTPS schemes", () => {
  for (const url of ["http://staging.example.test", "https://user:secret@staging.example.test", "https://staging.example.test/path"]) {
    expect(e2eTargetError({ E2E_BASE_URL: url, E2E_STAGING_BASE_URL: url, E2E_ALLOW_STAGING_WRITES: "1" })).toMatch(/HTTPS staging origin/);
  }
});
