/**
 * Backup and restore rehearsal: dump a FindMaxxing database, restore it into a
 * fresh one, and prove the copy is whole — every table's row count, every RLS
 * policy, RLS switched on where it was, functions and triggers, and one
 * visibility rule actually holding.
 *
 *   npx tsx scripts/backup-restore-rehearsal.ts
 *       Local rehearsal: seeds an embedded Postgres (PGlite) with every
 *       migration, dumps it with pg_dump (compiled to WASM), restores into a
 *       second PGlite with the Supabase auth/storage stubs, and compares.
 *
 *   SOURCE_DATABASE_URL=postgres://… TARGET_DATABASE_URL=postgres://… \
 *     npx tsx scripts/backup-restore-rehearsal.ts --remote
 *       Real rehearsal with the system pg_dump and psql (install the Postgres
 *       client, version ≥ the server's). TARGET must be an empty scratch
 *       database or a fresh Supabase project: the restore writes into it.
 *
 * Supabase-managed schemas (auth, storage, realtime, …) are not dumped: a
 * Supabase project has its own, and its point-in-time recovery covers them (see
 * docs/runbooks/backup-and-restore.md). Only auth.users rows are carried, as
 * data, because profiles reference them.
 *
 * Exits non-zero if anything differs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import { SUPABASE_STUBS, createSeededDb } from "../tests/helpers/pglite";

const MANAGED_SCHEMAS = ["auth", "storage", "realtime", "extensions", "graphql", "graphql_public", "pgbouncer", "pgsodium", "supabase_functions", "supabase_migrations", "vault", "net", "cron"];

/** Anything that can run a query and return rows. */
type Query = (sql: string) => Promise<Record<string, unknown>[]>;

interface Fingerprint {
  rowCounts: Record<string, number>;
  policies: string[];
  rlsEnabled: string[];
  functions: string[];
  triggers: string[];
}

async function fingerprint(query: Query): Promise<Fingerprint> {
  const tables = (await query("select tablename from pg_tables where schemaname = 'public' order by tablename")).map((r) => String(r.tablename));
  const rowCounts: Record<string, number> = {};
  for (const t of tables) rowCounts[t] = Number((await query(`select count(*)::int as n from public."${t}"`))[0].n);
  rowCounts["auth.users"] = Number((await query("select count(*)::int as n from auth.users"))[0].n);
  const list = async (sql: string) => (await query(sql)).map((r) => String(Object.values(r)[0]));
  return {
    rowCounts,
    policies: await list("select tablename || ': ' || policyname || ' (' || cmd || ')' from pg_policies where schemaname = 'public' order by 1"),
    rlsEnabled: await list("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity order by 1"),
    // Our functions only: extension-owned ones (pgcrypto) come with the extension.
    functions: await list("select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1"),
    triggers: await list("select c.relname || ': ' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal order by 1"),
  };
}

function compare(source: Fingerprint, target: Fingerprint): string[] {
  const problems: string[] = [];
  for (const [table, n] of Object.entries(source.rowCounts)) {
    if (target.rowCounts[table] !== n) problems.push(`row count ${table}: source ${n}, restored ${target.rowCounts[table] ?? "missing"}`);
  }
  for (const key of ["policies", "rlsEnabled", "functions", "triggers"] as const) {
    const missing = source[key].filter((x) => !target[key].includes(x));
    if (missing.length) problems.push(`${key} missing after restore: ${missing.join(", ")}`);
  }
  if (!source.policies.length) problems.push("source has no RLS policies: wrong database?");
  return problems;
}

/** A locals-only place must stay invisible to a non-local after the restore. */
async function visibilityHolds(db: PGlite): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    "select p.id from public.places p where p.visibility = 'locals' and p.status = 'published' limit 1",
  );
  if (!rows.length) return true;
  const { rows: visitor } = await db.query<{ id: string }>("select id from public.profiles where lower(home_city) <> 'columbus' limit 1");
  if (!visitor.length) return true;
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [visitor[0].id]);
  try {
    return (await db.query("select id from public.places where id = $1", [rows[0].id])).rows.length === 0;
  } finally {
    await db.exec("reset role");
  }
}

async function rehearseLocal(): Promise<string[]> {
  const started = Date.now();
  const source = await createSeededDb();
  const sourceQuery: Query = async (sql) => (await source.query<Record<string, unknown>>(sql)).rows;

  // public: schema + data. auth.users: data only, restored into the stub first.
  const exclude = MANAGED_SCHEMAS.flatMap((s) => ["--exclude-schema", s]);
  const publicDump = await (await pgDump({ pg: source, args: ["--no-owner", "--schema", "public", ...exclude] })).text();
  const authDump = await (await pgDump({ pg: source, args: ["--no-owner", "--data-only", "--table", "auth.users"] })).text();

  const target = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  // Supabase keeps extensions in their own schema; the trigram indexes need pg_trgm there before the restore.
  await target.exec("create extension if not exists pgcrypto; create schema if not exists extensions; create extension if not exists pg_trgm with schema extensions;");
  await target.exec(SUPABASE_STUBS);
  // A fresh Supabase database has an empty public schema; the dump recreates it.
  await target.exec("drop schema public cascade;");
  await target.exec(authDump);
  await target.exec(publicDump);
  // pg_dump scripts switch row security off and empty the search path for the
  // restoring session; put both back before using the copy as a user would.
  await target.exec("set row_security = on; reset search_path;");
  // Extensions are not part of a schema dump (Supabase installs them itself).
  await target.exec("create extension if not exists pgcrypto;");
  const targetQuery: Query = async (sql) => (await target.query<Record<string, unknown>>(sql)).rows;

  const [a, b] = [await fingerprint(sourceQuery), await fingerprint(targetQuery)];
  const problems = compare(a, b);
  if (!(await visibilityHolds(target))) problems.push("a non-local can see a locals-only place in the restored copy");
  const tables = Object.keys(a.rowCounts).length;
  const rows = Object.values(a.rowCounts).reduce((s, n) => s + n, 0);
  console.log(`dump: ${(publicDump.length / 1024).toFixed(0)} KB public + ${(authDump.length / 1024).toFixed(0)} KB auth.users`);
  console.log(`compared ${tables} tables (${rows} rows), ${a.policies.length} policies, ${a.rlsEnabled.length} RLS tables, ${a.functions.length} functions, ${a.triggers.length} triggers in ${Date.now() - started} ms`);
  return problems;
}

function rehearseRemote(): { source: Query; target: Query } {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl || !targetUrl) {
    throw new Error("--remote needs SOURCE_DATABASE_URL and TARGET_DATABASE_URL (the target must be an empty scratch database)");
  }
  for (const tool of ["pg_dump", "psql"]) {
    try {
      execFileSync(tool, ["--version"], { stdio: "ignore" });
    } catch {
      throw new Error(`${tool} is not installed. Install the PostgreSQL client tools (e.g. \`brew install libpq\`) and retry.`);
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "findmaxxing-rehearsal-"));
  const publicFile = path.join(dir, "public.sql");
  const authFile = path.join(dir, "auth-users.sql");
  const exclude = MANAGED_SCHEMAS.flatMap((s) => ["--exclude-schema", s]);
  execFileSync("pg_dump", [sourceUrl, "--no-owner", "--no-privileges", "--schema", "public", ...exclude, "--file", publicFile], { stdio: "inherit" });
  execFileSync("pg_dump", [sourceUrl, "--no-owner", "--data-only", "--table", "auth.users", "--file", authFile], { stdio: "inherit" });
  execFileSync("psql", [targetUrl, "-v", "ON_ERROR_STOP=1", "-c", "drop schema if exists public cascade;"], { stdio: "inherit" });
  execFileSync("psql", [targetUrl, "-v", "ON_ERROR_STOP=1", "-f", authFile], { stdio: "inherit" });
  execFileSync("psql", [targetUrl, "-v", "ON_ERROR_STOP=1", "-f", publicFile], { stdio: "inherit" });
  writeFileSync(path.join(dir, "README.txt"), "FindMaxxing rehearsal dumps; delete when done.\n");
  console.log(`dumps in ${dir}`);
  // The same fingerprint SQL, through psql, one JSON array per query.
  const run = (url: string): Query => async (sql) =>
    JSON.parse(execFileSync("psql", [url, "-At", "-c", `select coalesce(json_agg(t), '[]') from (${sql}) t`], { encoding: "utf8" }).trim() || "[]");
  return { source: run(sourceUrl), target: run(targetUrl) };
}

async function main() {
  const remote = process.argv.includes("--remote");
  let problems: string[];
  if (remote) {
    const { source, target } = rehearseRemote();
    problems = compare(await fingerprint(source), await fingerprint(target));
  } else {
    problems = await rehearseLocal();
  }
  if (problems.length) {
    console.error("FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("PASSED: the restored copy matches (row counts, RLS policies and flags, functions, triggers, visibility)");
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
