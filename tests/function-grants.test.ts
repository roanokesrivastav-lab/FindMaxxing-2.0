import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { FUNCTION_GRANT_ALLOWLIST } from "./fixtures/function-grants";

type Grant = { signature: string; anon: boolean; authenticated: boolean };
const inventorySql = `
  select p.oid::regprocedure::text as signature,
    has_function_privilege('anon', p.oid, 'execute') as anon,
    has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
`;
const sort = (rows: Grant[]) => rows.sort((a, b) => a.signature.localeCompare(b.signature));
const expected = sort(FUNCTION_GRANT_ALLOWLIST.map(({ signature, anon, authenticated }) => ({ signature, anon, authenticated })));

describe("API function privilege inventory", () => {
  let db: PGlite;
  beforeAll(async () => { db = await createSeededDb(); });
  afterAll(async () => { await db?.close(); });
  const assertInventory = async () => {
    const { rows } = await db.query<Grant>(inventorySql);
    // Read every definer, including denied ones. Any new exposed signature,
    // role expansion or accidental removal of intended access fails this check.
    expect(sort(rows.filter((r) => r.anon || r.authenticated))).toEqual(expected);
  };

  it("matches the explicitly reviewed signature and role allowlist", async () => {
    expect(new Set(expected.map((r) => r.signature)).size).toBe(expected.length);
    await assertInventory();
  });

  it("detects PUBLIC-only revocation under Supabase function defaults", async () => {
    await db.exec(`create function public.inventory_probe() returns boolean language sql security definer
      set search_path = public as 'select true';
      revoke all on function public.inventory_probe() from public;`);
    try {
      expect((await db.query<Grant>(inventorySql)).rows.find((r) => r.signature === "inventory_probe()")).toEqual({
        signature: "inventory_probe()", anon: true, authenticated: true,
      });
      await expect(assertInventory()).rejects.toThrow();
      await db.exec("revoke all on function public.inventory_probe() from anon, authenticated;");
      await assertInventory();
    } finally {
      await db.exec("drop function public.inventory_probe();");
    }
  });

  it("detects new overloads and expansion of an existing authenticated-only grant", async () => {
    await db.exec(`create function public.is_suspended(text) returns boolean language sql security definer
      set search_path = public as 'select true';`);
    try { await expect(assertInventory()).rejects.toThrow(); }
    finally { await db.exec("drop function public.is_suspended(text);"); }
    await db.exec("grant execute on function public.is_suspended(uuid) to anon;");
    try { await expect(assertInventory()).rejects.toThrow(); }
    finally { await db.exec("revoke all on function public.is_suspended(uuid) from anon;"); }
    await assertInventory();
  });
});
