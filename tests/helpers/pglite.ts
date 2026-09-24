/**
 * Embedded Postgres with minimal stubs for the Supabase `auth` and `storage`
 * schemas, every migration applied in filename order, and the generated seed.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { buildSeedSql } from "../../scripts/generate-seed-sql";

export const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key,
    instance_id uuid, aud text, role text, email text unique,
    encrypted_password text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb, raw_user_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
`;

export async function createSeededDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec("create extension if not exists pgcrypto;");
  await db.exec(SUPABASE_STUBS);
  const migrationsDir = path.join(__dirname, "../../supabase/migrations");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  await db.exec(buildSeedSql());
  return db;
}

/**
 * Runs a query as `anon` (userId null) or `authenticated` with that JWT
 * subject, the way PostgREST would, so RLS applies.
 */
export async function queryAs<T>(db: PGlite, userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  const role = userId ? "authenticated" : "anon";
  await db.exec(`grant usage on schema public to ${role}; grant select, insert, update, delete on all tables in schema public to ${role};`);
  await db.exec(`set role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role;");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}
