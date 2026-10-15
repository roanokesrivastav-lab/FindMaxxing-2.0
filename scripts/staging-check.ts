/**
 * Staging gate: run before opening a release to the public.
 *
 *   STAGING_DATABASE_URL=postgres://…            (direct connection, for migrations)
 *   STAGING_PROJECT_REF=…                        (explicit disposable project)
 *   STAGING_SUPABASE_URL=https://xyz.supabase.co
 *   STAGING_SUPABASE_ANON_KEY=…
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY=…          (creates and deletes the check users)
 *   STAGING_APP_URL=https://staging.example.com  (required for the complete gate)
 *   E2E_MOD_EMAIL=… / E2E_MOD_PASSWORD=…         (disposable staging moderator)
 *   npx tsx scripts/staging-check.ts --allow-staging-writes [--skip-migrations] [--skip-e2e]
 *
 * 1. Applies every migration with `supabase db push` (Supabase CLI required).
 * 2. Runs RLS checks over HTTP as real users: anon, two fresh users, and a
 *    moderator. Cross-user access, locals-only visibility, lists, photos,
 *    moderation and rate limits. The users are created with the admin API and
 *    deleted at the end, whatever happens.
 * 3. Runs the image migration in --dry-run mode against staging.
 * 4. Runs `npm run e2e` against STAGING_APP_URL (demo-only steps are skipped there).
 *
 * Exits 2 when credentials are missing (nothing was checked), 1 on any failed
 * check, 0 only when every step ran and passed.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanupStaging, stagingPreflight, STAGING_REQUIRED } from "./lib/staging-preflight";

const REQUIRED = STAGING_REQUIRED;
const args = new Set(process.argv.slice(2));
const preflight = stagingPreflight(process.env, args);
if (preflight) {
  console.error(`staging-check: NOT RUN. ${preflight}.`);
  console.error("Set them for a staging Supabase project (never production) and re-run. See docs/beta-gate.md.");
  process.exit(2);
}

const env = Object.fromEntries(REQUIRED.map((k) => [k, process.env[k]!])) as Record<(typeof REQUIRED)[number], string>;
const results: { name: string; pass: boolean; detail?: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const admin = createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = () => createClient(env.STAGING_SUPABASE_URL, env.STAGING_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

interface CheckUser { id: string; email: string; client: SupabaseClient }
const created: string[] = [];
const storagePaths: string[] = [];

async function makeUser(label: string, opts: { homeCity?: string; ageDays?: number; moderator?: boolean } = {}): Promise<CheckUser> {
  const email = `staging-check+${label}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { username: `chk_${label}_${randomUUID().slice(0, 6)}`.toLowerCase().slice(0, 24), display_name: `Check ${label}` },
  });
  if (error || !data.user) throw new Error(`could not create ${label}: ${error?.message}`);
  created.push(data.user.id);
  // The service role is not limited by the trust-column trigger (no auth.uid()).
  const patch: Record<string, unknown> = {};
  if (opts.homeCity) patch.home_city = opts.homeCity;
  if (opts.ageDays) patch.created_at = new Date(Date.now() - opts.ageDays * 86_400_000).toISOString();
  if (Object.keys(patch).length) {
    const { error: e } = await admin.from("profiles").update(patch).eq("id", data.user.id);
    if (e) throw new Error(`could not age ${label}: ${e.message}`);
  }
  if (opts.moderator) {
    const { error: e } = await admin.from("moderators").insert({ user_id: data.user.id });
    if (e) throw new Error(`could not make ${label} a moderator: ${e.message}`);
  }
  const client = anon();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`could not sign in ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client };
}

const placeRow = (name: string, visibility = "public") => ({
  p_name: name, p_description: "Created by the staging check; deleted at the end.", p_local_tip: null,
  p_category_slug: "food", p_lat: 39.96, p_lng: -83.0, p_address: null, p_neighborhood: "Staging", p_city: "Columbus",
  p_visibility: visibility, p_tags: [], p_photos: [],
});

async function rlsChecks() {
  const visitor = anon();
  const a = await makeUser("a", { homeCity: "Columbus", ageDays: 30 });
  const b = await makeUser("b", { homeCity: "Cleveland", ageDays: 30 });
  const fresh = await makeUser("fresh", { homeCity: "Columbus" });
  const mod = await makeUser("mod", { homeCity: "Columbus", ageDays: 30, moderator: true });

  // Places and the locals tier
  const pub = await a.client.rpc("create_place_with_details", placeRow("Staging public place"));
  const loc = await a.client.rpc("create_place_with_details", placeRow("Staging locals place", "locals"));
  check("a user can create places", !pub.error && !loc.error, pub.error?.message ?? loc.error?.message ?? "");
  const pubId = pub.data as string;
  const locId = loc.data as string;
  if (pub.error || loc.error) return;
  const sees = async (c: SupabaseClient, id: string) => {
    const res = await c.from("places").select("id").eq("id", id);
    if (res.error) throw new Error("Visibility query failed; absence was not verified");
    return (res.data ?? []).length === 1;
  };
  check("anon sees a public place", await sees(visitor, pubId));
  check("anon cannot see a locals-only place", !(await sees(visitor, locId)));
  check("a non-local cannot see a locals-only place", !(await sees(b.client, locId)));
  check("a 7-day-old local can", await sees(mod.client, locId));
  check("an account under 7 days old cannot, whatever its home city", !(await sees(fresh.client, locId)));

  // Cross-user writes
  const hijack = await b.client.from("places").update({ name: "Hijacked" }).eq("id", pubId).select("id");
  check("another user cannot edit a place", !hijack.error && (hijack.data ?? []).length === 0);
  const backdate = await b.client.from("profiles").update({ created_at: "2020-01-01" }).eq("id", b.id);
  check("nobody can backdate their own account", !!backdate.error);
  const selfMod = await b.client.from("moderators").insert({ user_id: b.id });
  check("nobody can make themselves a moderator", !!selfMod.error);

  // Lists and saves
  const list = await a.client.from("saved_lists").insert({ owner_id: a.id, name: "Staging list" }).select("id").single();
  check("a user can create a list", !list.error);
  const theirs = await b.client.from("saved_lists").select("id").eq("id", list.data?.id ?? "");
  check("another user cannot read it", !theirs.error && (theirs.data ?? []).length === 0);
  const sneak = await b.client.rpc("add_to_saved_list", { p_list_id: list.data?.id, p_place_id: pubId });
  check("another user cannot add to it", !!sneak.error);
  const anonSaves = await visitor.from("saved_places").select("user_id").limit(1);
  check("anon reads no bookmarks", !anonSaves.error && (anonSaves.data ?? []).length === 0);

  // Photos: the bucket is private and follows place visibility
  const objectPath = `${a.id}/staging-check.webp`;
  storagePaths.push(objectPath, `${a.id}/intruder.webp`);
  const up = await a.client.storage.from("place-photos").upload(objectPath, new Uint8Array([82, 73, 70, 70]), { contentType: "image/webp" });
  check("a user can upload to their own folder", !up.error, up.error?.message ?? "");
  const photo = await a.client.from("place_photos").insert({ place_id: locId, url: `storage:place-photos/${objectPath}`, storage_path: objectPath, uploader_id: a.id });
  check("photo is attached before testing visibility", !photo.error);
  const asB = await b.client.storage.from("place-photos").download(objectPath);
  check("a non-local cannot download a locals-only place's photo", !!asB.error);
  const intoTheirs = await b.client.storage.from("place-photos").upload(`${a.id}/intruder.webp`, new Uint8Array([1]), { contentType: "image/webp" });
  check("nobody can upload into someone else's folder", !!intoTheirs.error);

  // Moderation
  await b.client.from("reports").insert({ reporter_id: b.id, target_type: "place", target_id: pubId, reason: "spam" });
  const queueB = await b.client.rpc("moderation_queue");
  check("non-moderators get an empty queue", !queueB.error && (queueB.data ?? []).length === 0);
  const queueMod = await mod.client.rpc("moderation_queue", { p_limit: 101 });
  check("the moderator sees the report", ((queueMod.data ?? []) as { target_id: string }[]).some((r) => r.target_id === pubId));
  const notMod = await b.client.rpc("moderate_target", { p_target_type: "place", p_target_id: pubId, p_action: "remove", p_reason: "x" });
  check("non-moderators cannot resolve reports", !!notMod.error);
  const removed = await mod.client.rpc("moderate_target", { p_target_type: "place", p_target_id: pubId, p_action: "remove", p_reason: "Staging check" });
  check("the moderator can remove content", !removed.error, removed.error?.message ?? "");
  check("removed content is gone for its owner", !(await sees(a.client, pubId)));
  check("…and for everyone else", !(await sees(visitor, pubId)));
  const history = await b.client.from("moderation_actions").select("id").eq("target_id", pubId);
  check("non-moderators cannot read moderation history", !history.error && (history.data ?? []).length === 0);

  // Rate limits (lists: 30 a day)
  let limited = "";
  for (let i = 0; i < 31 && !limited; i++) {
    const r = await b.client.from("saved_lists").insert({ owner_id: b.id, name: `Limit ${i}` });
    if (r.error) limited = `${r.error.code} ${r.error.message}`;
  }
  check("the list rate limit refuses the 31st list of the day", /FM429|rate_limited:lists/.test(limited), limited);
  const otherUser = await a.client.from("saved_lists").insert({ owner_id: a.id, name: "Still fine" });
  check("…for that user only", !otherUser.error);

}

function run(cmd: string, argv: string[], extraEnv: Record<string, string> = {}, suppressOutput = false) {
  execFileSync(cmd, argv, { stdio: suppressOutput ? "pipe" : "inherit", env: { ...process.env, ...extraEnv } });
}

async function main() {
  if (!args.has("--skip-migrations")) {
    try {
      run("supabase", ["db", "push", "--db-url", env.STAGING_DATABASE_URL, "--include-all"], {}, true);
      check("migrations applied with supabase db push", true);
    } catch {
      // A command exception includes argv, which contains the database secret.
      check("migrations applied with supabase db push", false, "Migration command failed; no check users created");
      process.exit(1);
    }
  } else {
    check("migrations applied with supabase db push", false, "SKIPPED: this run cannot approve the full staging gate");
  }

  try {
    await rlsChecks();
  } catch (err) {
    check("RLS checks ran to completion", false, err instanceof Error ? err.message : String(err));
  } finally {
    const { storageClean, removed } = await cleanupStaging(admin, created, storagePaths);
    if (storagePaths.length) check("scratch Storage cleanup before Auth deletion", storageClean);
    check("check-user cleanup", removed === created.length, `${removed}/${created.length} removed; failures require operator cleanup`);
  }

  try {
    run("npx", ["tsx", "scripts/migrate-images.ts", "--dry-run"], {
      NEXT_PUBLIC_SUPABASE_URL: env.STAGING_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.STAGING_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.STAGING_SUPABASE_SERVICE_ROLE_KEY,
    });
    check("image migration dry run", true);
  } catch {
    check("image migration dry run", false);
  }

  if (!args.has("--skip-e2e")) {
    if (!process.env.STAGING_APP_URL) {
      check("e2e against staging", false, "STAGING_APP_URL not set (use --skip-e2e to skip deliberately)");
    } else {
      try {
        run("npm", ["run", "e2e"], { E2E_BASE_URL: process.env.STAGING_APP_URL,
          E2E_STAGING_BASE_URL: process.env.STAGING_APP_URL, E2E_ALLOW_STAGING_WRITES: "1" });
        check("e2e against staging", true);
      } catch {
        check("e2e against staging", false);
      }
    }
  } else {
    check("e2e against staging", false, "SKIPPED: this run cannot approve the full staging gate");
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} staging checks passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
