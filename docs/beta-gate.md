# Beta gate

The public beta opens only when every line below says **passed on staging**
(or **passed locally** where staging adds nothing). "Passed on staging" is
written here only after the command has actually been run against the staging
Supabase project, with the date.

Status as of the Session 9 commit (local machine: macOS, Node 20; no Supabase,
Vercel, Sentry, Mapbox or Anthropic credentials were available).

| Gate | What proves it | Command | Status |
| --- | --- | --- | --- |
| RLS | Every table, policy, trigger and function tested as anon and as signed-in users through PostgREST-style roles, including cross-user access, locals-only visibility, lists, photos, moderation, rate limits, and policy/function equivalence | `npm test` | **Passed locally** (PGlite, all migrations). |
| RLS over HTTP | The same rules as real users (anon, two users, a moderator) against a real Supabase project | `npx tsx scripts/staging-check.ts` | **Not yet run**: needs `STAGING_DATABASE_URL`, `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_SUPABASE_SERVICE_ROLE_KEY`. Without them it exits 2 and says so. |
| Migrations | `0001`–`0014` apply in order to an empty database; the seed applies after them | `npm test` (every suite builds a fresh database) | **Passed locally** (PGlite). |
| Migrations on Supabase | `supabase db push` applies them to the staging project | `npx tsx scripts/staging-check.ts` (step 1) | **Not yet run**: needs staging credentials and the Supabase CLI. |
| Performance: discovery | p95 per hot query at 50k places in one city; no sequential scan on a hot list or map path | `npx tsx tests/helpers/measure-discovery.ts 50000` | **Passed locally**: map markers ≤ 5 ms, list pages ≤ 5 ms (category + tag 67 ms), text search 9–36 ms, counts 30–200 ms, aggregates 230–390 ms (PGlite, single-threaded WASM; see README). City-wide counts and aggregates scan by nature. |
| Performance: images | A six-photo place page stays under 600 KB of images at 412 px / DPR 1.75 | `node scripts/measure-images.mjs`; `npm test` (`tests/images.test.ts`) | **Passed locally**: 285 KB in the browser; the unit budget test passes. |
| Performance: concurrency | No errors under concurrent load on map discovery and a place page | `node scripts/load-test.mjs` | **Passed locally** (demo mode): map 3,126 req/s p99 12 ms; place page 418 req/s p99 65 ms; 0 errors. **Not yet run** against staging (`LOAD_BASE_URL=…`). |
| Recovery | A dump restores with identical row counts, RLS policies, RLS flags, functions, triggers and visibility | `npx tsx scripts/backup-restore-rehearsal.ts` | **Passed locally** (PGlite → PGlite, 22 tables, 377 rows, 52 policies). |
| Recovery on Supabase | The same against staging and a scratch database; PITR switched on | `… backup-restore-rehearsal.ts --remote`; dashboard | **Not yet run**: needs `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL` and the Postgres client tools. PITR is a dashboard setting for the owner. See `docs/runbooks/backup-and-restore.md`. |
| End-to-end | The core loop and beta flows at 390×844 in a real browser: discover, onboarding, open a place, save to a new list, add a place with a photo, create and join events, follow, report, moderator resolves, password reset, account deletion; no CSP violations | `npm run build && npm run e2e` | **Passed locally**: 19/19, three consecutive runs, demo mode. Also runs in CI. |
| End-to-end on staging | The same suite against the staging deployment (demo-only steps skipped) | `npx tsx scripts/staging-check.ts` (step 4) or `E2E_BASE_URL=… npm run e2e` | **Not yet run**: needs a staging deployment. |
| Accessibility | axe-core over 15 pages and sheets: no serious or critical violations; the save sheet traps focus and returns it; map pins are labelled buttons | `npm run build && npm run a11y` | **Passed locally**: 0 serious/critical, 0 moderate after fixes. Also runs in CI. A manual screen-reader pass (VoiceOver on iOS) has not been done. |
| Monitoring | Errors from actions, routes and error boundaries are logged as JSON and forwarded when configured; `/api/health` checks the database without leaking details | `npm test` (`tests/beta-readiness.test.ts`); `curl …/api/health` | **Passed locally** (logging, scrubbing, Sentry envelope format). **Not yet run** with a real `SENTRY_DSN`: needs a Sentry project. |
| Rate limits | Database-enforced per-user limits on places, events, ratings, lists, reports and uploads; per-IP sign-up and reset limits | `npm test` (`tests/rate-limits.test.ts`, `tests/moderation-actions.test.ts`) | **Passed locally**. Staging HTTP check (list limit) **not yet run**. Supabase Auth's own limits are a dashboard setting (README). |
| Moderation | Moderator-only queue, atomic resolution, removal hides content from everyone, append-only audit trail | `npm test` (`tests/moderation.test.ts`); `node scripts/smoke-moderation.mjs` | **Passed locally**. Staging HTTP check **not yet run**. |
| Security headers | CSP with per-request nonce; map and Supabase origins allowed; nothing blocked on the main flows | `npm test`; `npm run e2e` (fails on any CSP violation) | **Passed locally** with MapLibre. Mapbox has never been rendered (no token). |
| Demo mode kept out of production | `next start` in production refuses to run without Supabase unless a public demo is declared; Vercel builds fail the same way | `npm test` (`tests/beta-readiness.test.ts`) | **Passed locally**. |
| Account deletion (Supabase mode) | Deletes the auth user (cascades) and every stored image | `npm test` (cascades in SQL; demo flow end to end) | **Passed locally** for the SQL cascades and the demo flow. The Supabase admin path (service-role key, Storage removal) **not yet run**. |
| Password recovery (Supabase mode) | Recovery email → `/auth/callback` → `/auth/reset` | manual on staging | **Not yet run**: needs Supabase Auth email (or SMTP) configured for staging. The demo flow passes in `npm run e2e`. |

## Owner sign-off before opening

- [ ] Every "not yet run" line above run on staging and updated here with the date.
- [ ] The local-tier decision (README) confirmed.
- [ ] Report retention on account deletion (kept, anonymized) confirmed.
