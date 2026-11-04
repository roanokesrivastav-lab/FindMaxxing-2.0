/**
 * Real PostgreSQL for race tests (roadmap 4.pre; security brief 0.1 D2). PGlite is one connection, so
 * it cannot show what two transactions do at once; this harness can.
 *
 * - TEST_DATABASE_URL must point at a LOCAL server (localhost / 127.0.0.1 / ::1); anything else is
 *   refused, so a test run can never touch a hosted database.
 * - Each suite gets a fresh throwaway database (fm_test_<random>), the same Supabase stubs as the PGlite
 *   helper, and every migration applied in filename order. It is dropped afterwards.
 * - Two independent connections (`a`, `b`) are opened to it.
 * - Unset TEST_DATABASE_URL: suites skip with a loud message. In CI (CI is set) unset is a failure.
 *
 * Local setup and the CI variable are documented in the README "Testing" section.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { SUPABASE_STUBS } from "./pglite";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Throws unless the URL is a postgres:// URL on the local machine. */
export function assertLocalDatabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("TEST_DATABASE_URL must be a postgres:// URL");
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`TEST_DATABASE_URL must point at localhost, not ${url.hostname}`);
  return url;
}

/** The URL to use, or null (with a loud message) when unset outside CI. */
export function testDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.TEST_DATABASE_URL;
  if (!raw) {
    if (env.CI) throw new Error("TEST_DATABASE_URL is required in CI: the two-connection race tests must run there.");
    console.warn(
      "\n[postgres] TEST_DATABASE_URL is not set: SKIPPING the real-PostgreSQL race tests. " +
      "These are NOT passing; they did not run. See README \"Testing\".\n",
    );
    return null;
  }
  assertLocalDatabaseUrl(raw);
  return raw;
}

/** Roles are cluster-wide, so the stubs must not fail when an earlier suite already created them. */
function idempotentStubs(sql: string): string {
  return sql.replace(/create role (\w+) ([^;]*);/g, (_m, role: string, opts: string) =>
    `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} ${opts}; end if; end $$;`);
}

export interface TestDatabase {
  name: string;
  a: Client;
  b: Client;
  /** Opens one more independent connection (closed by drop()). */
  connect(): Promise<Client>;
  drop(): Promise<void>;
}

export async function createTestDatabase(rawUrl: string): Promise<TestDatabase> {
  const base = assertLocalDatabaseUrl(rawUrl);
  const name = `fm_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const dbUrl = new URL(base.toString());
  dbUrl.pathname = `/${name}`;
  const clients: Client[] = [];
  const connect = async () => {
    const c = new Client({ connectionString: dbUrl.toString() });
    await c.connect();
    clients.push(c);
    return c;
  };
  const drop = async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
  try {
    const setup = await connect();
    await setup.query("create extension if not exists pgcrypto;");
    await setup.query(idempotentStubs(SUPABASE_STUBS));
    const dir = path.join(__dirname, "../../supabase/migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      try {
        await setup.query(readFileSync(path.join(dir, file), "utf8"));
      } catch (err) {
        throw new Error(`migration ${file} failed on PostgreSQL: ${err instanceof Error ? err.message : err}`);
      }
    }
    const [a, b] = [await connect(), await connect()];
    return { name, a, b, connect, drop };
  } catch (err) {
    await drop();
    throw err;
  }
}
