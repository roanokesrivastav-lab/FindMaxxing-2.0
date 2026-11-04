/**
 * A Supabase-shaped `rpc` for the 0040 limiter functions, backed by a real database (PGlite here),
 * run as service_role the way the server's admin client calls them. Tests hand it to a mocked
 * createSupabaseAdminClient so actions and routes exercise the real SQL, not a stub.
 */
import type { PGlite } from "@electric-sql/pglite";

export type RpcCall = { name: string; args?: Record<string, unknown> };
export type RpcResult = { data: unknown; error: { message: string } | null };

// PGlite is one connection: concurrent callers must not interleave their `set role` / query / `reset role`.
// Calls on the same database are queued (like a single pooled connection). Real concurrency is proven
// with two PostgreSQL connections in tests/abuse-limits-pg.test.ts.
const queues = new WeakMap<PGlite, Promise<unknown>>();

export function pgliteRpc(db: PGlite, calls: RpcCall[] = []) {
  return (name: string, args: Record<string, unknown> = {}): Promise<RpcResult> => {
    calls.push({ name, args });
    const run = (queues.get(db) ?? Promise.resolve()).then(() => call(db, name, args));
    queues.set(db, run.catch(() => undefined));
    return run;
  };
}

async function call(db: PGlite, name: string, args: Record<string, unknown>): Promise<RpcResult> {
    try {
      await db.exec("set role service_role;");
      if (name === "consume_server_abuse") {
        const r = await db.query<{ r: number }>("select public.consume_server_abuse($1::jsonb) as r", [JSON.stringify(args.p_keys)]);
        return { data: r.rows[0].r, error: null };
      }
      if (name === "claim_geocode_provider") {
        const r = await db.query<{ r: boolean }>("select public.claim_geocode_provider() as r");
        return { data: r.rows[0].r, error: null };
      }
      if (name === "purge_server_abuse") {
        const r = await db.query<{ r: number }>("select public.purge_server_abuse($1) as r", [args.p_limit ?? 10000]);
        return { data: r.rows[0].r, error: null };
      }
      return { data: null, error: { message: `rpc ${name} is not part of this test` } };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
    } finally {
      await db.exec("reset role;");
    }
}

/** Every stored limiter row, for asserting that nothing raw (IP, email) was persisted. */
export async function abuseRows(db: PGlite) {
  return (await db.query<{ action: string; key_hash: string; count: number; row: string }>(
    "select action, key_hash, count, c::text as row from public.server_abuse_counters c order by action, key_hash",
  )).rows;
}
