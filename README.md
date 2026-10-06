# FindMaxxing

**Local knowledge, mapped.** FindMaxxing is a mobile-first discovery and social app: an interactive map of the places and activities locals actually use, contributed by the community. Think "Beli, but for every activity": the sports bar that reliably shows the game, the field where pickup actually happens, the study spot nobody posts about.

The core loop: **discover → view → save → contribute → create event → join event → connect**.

## Stack

- **Next.js 16** (App Router, Server Components, Server Actions), **React 19**, **TypeScript**
- **Tailwind CSS v4** with a custom design-token system (`src/app/globals.css`)
- **Supabase** (Postgres + Auth + Storage) with Row Level Security; **demo mode** fallback with no credentials
- **Mapbox GL** when a token is present; **MapLibre GL + OpenFreeMap** tiles otherwise (no key needed)
- **Zod** validation shared by forms and server actions
- **Vitest** + **PGlite** (embedded Postgres) so the real SQL migration is tested on every `npm test`. The helper sets Supabase-style default privileges once, at table creation, so a migration's column grants and revokes are what the tests actually exercise

## Quick start (no credentials needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000. The app runs in **demo mode**: a file-backed local store (`.data/demo-store.json`, git-ignored) seeded with fictional Columbus, Ohio data. Sign in from `/auth/sign-in` by tapping a persona, or with any seeded email (e.g. `maya@example.com`) and the password `findmaxxing`. `sam@example.com` is the seeded **moderator**: their profile links to the report queue at `/moderation`. `dev@example.com` is the seeded **admin** (`/admin/metrics`). Sign-ups, saves, ratings, events and follows persist across restarts. When the store format changes, the file is migrated forward on startup and the previous copy is kept beside it as `demo-store.v<N>-<timestamp>.bak.json`; an unreadable or newer file is backed up rather than overwritten. Delete `.data/` to reset.

## Checks

```bash
npm run typecheck   # next typegen + tsc
npm run lint        # eslint (next + react-hooks rules)
npm run test        # vitest: validation, demo repository, and the SQL schema via PGlite
npm run build       # production build
npm run check       # all of the above (what CI runs first)
npm run e2e         # end-to-end beta suite in a real browser (needs a build)
npm run a11y        # axe-core accessibility check (needs a build)
```

**`npm run e2e`** starts the built app in demo mode on a fresh in-memory store (nothing read from
or written to `.data`; uploads go to a scratch folder) and walks the core loop and the beta flows at
390×844: discover on the map, sign up and onboard, open a place, save it to a new list, add a place
with a photo, create and join events, follow someone, report a place, a moderator resolving the
report, password reset, and account deletion. It fails on any broken step, page error or CSP
violation and saves a screenshot per step to `.data/e2e` (`E2E_OUT` to change). `E2E_BASE_URL`
points it at a running server instead. **`npm run a11y`** runs axe-core over 15 pages and sheets at
the same size and fails on serious or critical violations; it also checks that a sheet traps focus
and gives it back. Both use the installed Google Chrome; `E2E_CHANNEL=chromium` uses Playwright's own
download (`npx playwright-core install chromium`), as CI does. Both run in CI
(`.github/workflows/ci.yml`) on every push and pull request, with no secrets.

`node scripts/smoke-tier2.mjs` does the same for the community layer and asserts its Tier 2 checks,
including that a non-local genuinely cannot see a locals-only place.
`node scripts/smoke-moderation.mjs [baseUrl]` walks the moderation loop (non-moderator 404, queue,
remove with a reason, owner notice, reporter feedback) and exits non-zero on any failure. Run the app
with `FINDMAXXING_DEMO_NO_PERSIST=1` so the walk does not change your demo store.
Measurements and operations scripts (see [Performance](#performance) and [Operations](#operations)):

| Command | What it does |
| --- | --- |
| `npx tsx tests/helpers/measure-discovery.ts 50000` | 50k places (and 5k events) in one city in PGlite; p50/p95 and plan for every hot discovery query, flagging sequential scans |
| `node scripts/measure-images.mjs` | Adds a place with six phone-sized photos through the real form, then measures image bytes on its page at 412px / DPR 1.75 against the 600KB budget |
| `node scripts/load-test.mjs` | `autocannon` (through `npx`, not a dependency) against map discovery and a place page |
| `npx tsx scripts/backup-restore-rehearsal.ts` | Dump, restore into a fresh database, compare everything (`--remote` for real databases) |
| `npx tsx scripts/staging-check.ts` | The staging gate: migrations, RLS over HTTP as real users, image migration dry run, e2e |

The beta's go/no-go list, with the command and current status of each gate, is `docs/beta-gate.md`.

## Going live with Supabase + Mapbox

1. Create a Supabase project. In the SQL editor (or `supabase db push`), run:
   - `supabase/migrations/0001_init.sql` — schema, triggers, RLS policies, storage buckets
   - `supabase/migrations/0002_tier1_owner_controls.sql` — owner edit/delete rules
   - `supabase/migrations/0003_tier2_community_layer.sql` — trust tiers, photo cap, report views
   - `supabase/migrations/0004_audit_hardening.sql` — visibility inheritance, transactional writes, and concurrency guards
   - `supabase/migrations/0005_private_photos_and_save_counts.sql` — private place-photo bucket with visibility-checked reads, and trigger-maintained save totals
   - `supabase/migrations/0006_discovery_queries.sql` — bounded, RLS-scoped discovery functions and their indexes
   - `supabase/migrations/0007_discovery_filters_and_aggregates.sql` — neighborhood, created-after and starts-before discovery filters, plus the neighborhood and interest count aggregates the list pages use
   - `supabase/migrations/0008_photo_variants.sql` — lets each place photo's smaller stored sizes follow the photo's own read and delete rules
   - `supabase/migrations/0009_saved_lists.sql` — owner-only saved lists that organize bookmarks, with their summaries and add-to-list function
   - `supabase/migrations/0010_moderation.sql` — moderators, the report queue and review RPCs, the append-only moderation history, removed-content rules, and the firmer local tier (7-day accounts, 30-day home city cooldown, revocation)
   - `supabase/migrations/0011_rate_limits.sql` — database-enforced write limits for places, events, ratings, lists, reports and uploads
   - `supabase/migrations/0012_account_deletion.sql` — deleting an account takes its places, events and photos with it, and keeps reports it filed with the reporter cleared
   - `supabase/migrations/0013_discovery_performance.sql` — `pg_trgm` search indexes, row policies that read the row they are given, and the Nearest order
   - `supabase/migrations/0014_onboarding.sql` — first-run onboarding state (existing accounts count as done)
   - `supabase/migrations/0015_analytics.sql` — admins, pseudonymous first-party analytics, place source, metric functions
   - `supabase/migrations/0017_admin.sql` — admins above moderators, suspension (every write refused in the database), audited moderator grants and taxonomy edits, paged admin reads
   - `supabase/migrations/0018_recommendations.sql` — rule-based, explained "For you" recommendations for places and events, computed under RLS
   - `supabase/migrations/0019_trip_planning.sql` — the daily limit on AI trip plans
   - `supabase/migrations/0016_reputation.sql` — contributor reputation (cached levels, moderator reset) and the trusted-locals and followers visibility tiers
   - `supabase/seed.sql` — optional fictional demo data (generated from `src/lib/seed/seed-data.ts` via `npm run seed:sql`; **do not use the demo users in production**)
2. In Supabase Auth settings, add `http://localhost:3000/auth/callback` (and your production URL) to the redirect allow-list. Email confirmation is supported: the sign-up flow shows a "check your email" state and `/auth/callback` exchanges the code.
   Under **Authentication → Rate Limits**, keep sign-ups and password-recovery emails low for the beta: 30 sign-ups and 30 token verifications per 5 minutes per IP, and 4 emails per hour (or connect your own SMTP provider and raise it deliberately). Turn on CAPTCHA protection if sign-up spam appears. These sit in front of the app's own per-IP limit (see [Rate limits](#rate-limits)).
3. Make at least one moderator. Moderators are granted only from SQL or the service role, never from the app:
   ```sql
   insert into public.moderators (user_id)
   select id from public.profiles where username = 'your_username';
   ```
4. Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | for Supabase mode | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | for Supabase mode | Public anon key; all queries run under RLS as the signed-in user |
| `SUPABASE_SERVICE_ROLE_KEY` | in production (secret) | Server only, never sent to the browser. Account deletion uses it for the Auth admin delete and Storage cleanup (`src/server/accountDeletion.ts`); so does `scripts/migrate-images.ts` |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | no | Public `pk.*` token. Without it (or with anything that is not a `pk.` token) the map uses MapLibre + OpenFreeMap; a token Mapbox rejects falls back to MapLibre at runtime |
| `NEXT_PUBLIC_MAPBOX_STYLE` | no | Custom Mapbox style URL |
| `NEXT_PUBLIC_SITE_URL` | in production | Absolute origin for auth redirect links (sign-up confirmation, password recovery), and the User-Agent the geocoder identifies itself with |
| `SENTRY_DSN` | no (secret) | Forward server and client errors to Sentry (see [Operations](#operations)) |
| `ERROR_WEBHOOK_URL` | no (secret) | Forward errors as JSON to any endpoint |
| `FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION` | no | `1` lets a production server run in demo mode, for a deliberate public demo only |
| `FINDMAXXING_DEMO_NO_PERSIST` / `FINDMAXXING_DEMO_FRESH` / `FINDMAXXING_DEMO_UPLOAD_DIR` | no | Demo mode for scripted runs: never write the store / ignore the store on disk / put uploads elsewhere |

Setting both Supabase variables switches the whole app to Supabase mode. There is no code change; `src/lib/data/index.ts` picks the repository implementation from the environment.

**Demo mode never serves production.** It keeps everything in one JSON file rewritten on a debounce,
which is not safe across processes. A production server (`next start`, `NODE_ENV=production`)
refuses to start without the Supabase variables, with a message saying why, unless
`FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION=1` declares a public demo; a Vercel build fails the same way.
Local `next build` without Supabase still works, so CI can build and test.

5. Deploy (see [Operations](#operations)), then run the staging gate in `docs/beta-gate.md`.

## Project structure

```
src/
  app/                       Routes (App Router)
    (explore)/               / — the map, with its own loading skeleton
    new                      Create chooser: place or event
    places/[id], places/new, places/[id]/edit
    events, events/[id], events/new, events/[id]/edit
    neighborhoods, neighborhoods/[name], tags, tags/[slug]
    saved, saved/[id], people, profile, profile/edit, profile/reports, profile/settings
    welcome                  First-run onboarding (once; finished or skipped, never again)
    moderation, moderation/[type]/[id]   Report queue and review (moderators only; 404 for everyone else)
    u/[username], u/[username]/[kind]
    auth/sign-in, auth/sign-up, auth/callback, auth/forgot, auth/reset
    api/discover/*           Discovery endpoints: places, events, map, item
    api/geocode              Server-side address lookup (Mapbox or Nominatim)
    api/photos/[id]          Visibility-checked place photos
    api/uploads/[name]       Serves demo-mode avatar uploads
    api/health               Database reachability for uptime checks ("ok" or "unavailable", nothing else)
    api/client-errors        Error-boundary reports from the browser (rate-limited)
  components/
    ui/                      Design-system primitives (Button, Chip, Sheet, Stars, Toast…)
    layout/                  AppShell, bottom tab bar, desktop rail, create menu
    map/                     MapView (provider switch), MapCanvas, pins, LocationPicker, MiniMap
    explore/                 The map-first discovery experience
    places/, events/, profile/, forms/, auth/, shared/
  lib/
    data/types.ts            Domain types
    data/repository.ts       The single data-access contract
    data/supabase/           Supabase implementation (RLS-scoped client)
    data/demo/               File-backed demo implementation + demo auth
    data/taxonomy.ts         Categories + interests (single source of truth, mirrored in SQL)
    auth/server.ts           getViewer() / requireViewer()
    observability/           Structured error logs and optional Sentry / webhook forwarding
    security/csp.ts          The per-request Content-Security-Policy
    rateLimits.ts            Write limits (mirrors rate_limit_rules) and the in-memory per-IP limiter
    supabase/                Server, browser and proxy clients
    validation/schemas.ts    Zod schemas for every form
    seed/seed-data.ts        Fictional demo data (drives both demo mode and seed.sql)
    map/, utils/
  server/actions/            Server Actions: auth, account, places, events, lists, profile, moderation, onboarding
  server/accountDeletion.ts  Account deletion (Supabase admin path and demo mirror)
  server/passwordReset.ts    Password recovery (Supabase recovery email, or an on-screen demo link)
  proxy.ts                   Refreshes the Supabase session on each request
supabase/
  migrations/                Ordered schema, RLS, feature, and hardening migrations
  seed.sql                   Generated demo seed
tests/                       Vitest suites (schema runs against PGlite)
scripts/                     seed generator, e2e and accessibility suites, measurements, rehearsal, staging gate
docs/                        beta-gate.md, runbooks/
```

## The community layer

Three features carry the "local knowledge is the moat" idea beyond a plain listings app:

**Trust tiers.** A place is visible to `public`, `locals`, or `private`. The rule for who counts as a
local is defined once, in SQL, as `public.is_local(city)`: your account is at least 7 days old, a
moderator has not revoked your local status, **and** your profile's home city matches or you have
contributed a published place in that city. Home city can change once every 30 days (a trigger
enforces it; case and spacing fixes are free) and the profile form shows the next allowed date.
The demo store mirrors the same rule in `isLocalOfCity`, and both are covered by tests, so the two
paths cannot drift. Locals-only places are filtered by the row-level policy itself, not by a query
the client could forget. See [the local-tier decision](#decision-is-a-self-declared-home-city-enough-for-the-local-tier).

**Photos follow their place.** Place photos live in a private bucket. The browser only ever sees
`/api/photos/[id]`, which checks visibility on every request (RLS in Supabase mode, `canViewPlace` in demo mode)
and then streams the bytes itself — no reusable signed URL that could outlive a visibility change. Responses are
`private, no-cache` with an ETag, so browsers revalidate before every reuse: a still-authorized viewer gets a 304
without a Storage download, and a viewer who has lost access gets a 404 on the very next request. The Storage read policy applies the same
`can_view_place()` rule, so a non-local cannot fetch a locals-only photo even with its object path, and an uploader's own objects are readable only while they are not yet attached to a photo row. Avatars
stay public because they belong to the public profile.

**Images go through a pipeline before they are stored** (`src/lib/images/pipeline.ts`, using `sharp`).
The decoded bytes decide what a file is, not its name or declared type: only JPEG, PNG and WebP are accepted,
animated images are refused, and so are images under 200px (96px for avatars) or over 40 megapixels,
which is checked before decoding so a small file cannot expand into gigabytes. EXIF orientation is applied,
all metadata (GPS included) is dropped, and the result is re-encoded as WebP. Each place photo is stored at
three sizes, 480, 960 and 1600px on the long edge: `owner/abc.webp` plus `owner/abc.md.webp` and
`owner/abc.sm.webp`. The smaller sizes are derived from the storage path, so there is no schema change.
Migration 0008 makes them follow their photo's visibility. Avatars are a 256px square.
`/api/photos/[id]?size=sm|md|lg` serves one size, and pages ask for them with `srcSet` and a per-layout
`sizes`, loading everything lazily except the detail-page hero. Each photo is decoded once, straight
down to the largest size, and the three sizes are encoded from that one after another. Across all requests
at most two images are processed at a time (`withImageSlot`), so several six-photo forms queue instead of
decoding 40-megapixel images side by side. The browser also shrinks photos to 2400px before sending them
(`src/lib/images/client.ts`). It accepts originals up to 40MB, and the shrunk file must be under 10MB. A form
refuses to submit while photos are still being prepared, refuses a batch over 15MB, and server actions
accept 16MB bodies. The old 1MB default rejected most phone photos.

**Mobile budget:** a place page with all six photos must stay under 600KB of images on the Lighthouse
mobile profile (412px wide, DPR 1.75), where it loads the hero at 960px and the gallery at 480px.
`tests/images.test.ts` enforces this with realistic ~4MB phone photos: they come to about 450KB. A
browser measurement at 412px and DPR 2 came to 226KB. A phone at DPR 3 picks the next size up
(about 850KB for the same page); the budget is set for the Lighthouse profile.

**Existing images:** `npx tsx scripts/migrate-images.ts [--dry-run] [--delete-originals]` re-encodes
photos and avatars stored before the pipeline. It writes each one to a new path and repoints its row,
so cached copies never go stale (the photo route's ETag is keyed on the path) and originals stay as a
backup unless `--delete-originals` is passed. Even then, originals are deleted only after every repoint
has been saved, so an interrupted run never leaves a row pointing at a deleted file. A photo counts as
current only when both smaller sizes exist. Until then, the photo route falls back to the original for
every size. In demo mode, stop the dev server first; the script backs up `demo-store.json`. For
Supabase it needs `SUPABASE_SERVICE_ROLE_KEY`. Re-running it only reports what is already current.

**Rating notes.** A rating is a number; the note attached to it is the local knowledge. Notes appear
as a reviews list on the place page. Only ratings that carry a note show up there.

**Reports that go somewhere.** Two read paths, exposed as definer-rights views that omit
`reporter_id` outright rather than merely not selecting it: `reports_i_filed` for the person who
filed (now with the time a moderator resolved it, never who), and `reports_about_my_stuff` for the
owner of the reported listing. An owner can see what was said and act on it by editing or hiding the
listing. Moderators work the queue; see [Moderation](#moderation).

Owners may set `published` and `hidden`. The `pending` and `removed` statuses stay reserved for
moderation: the update policy's `WITH CHECK` refuses setting them and its `USING` refuses leaving them.

## Moderation

**Who moderates.** `public.moderators` holds the role. Clients have no insert, update or delete
grant on it, moderators included, so the role is granted only from SQL or the service role (see
step 3 of [Going live](#going-live-with-supabase--mapbox)). `public.is_moderator()` (definer rights)
answers for the current session. In demo mode `sam@example.com` is seeded as a moderator; a demo
store upgraded from an earlier version has none until you add one to `moderators` in
`.data/demo-store.json`.

**The queue** (`/moderation`) lists open reports grouped by target, oldest first, with the count and
reasons, in keyset pages of 30 (first reported, target id) so it never silently truncates. A target
page (`/moderation/[type]/[id]`) shows the target as it is now, whoever may otherwise see it
(`moderation_target()`, so a moderator who is not a local can still review a locals-only place),
every report with who filed it, and the target's moderation history. Both routes 404 for anyone else,
and the database returns nothing to them either: the queue and snapshot functions check
`is_moderator()`, and the moderator read policies on `reports` and `moderation_actions` do too.

**Decisions** go through one RPC, `moderate_target(type, id, action, reason)`, which resolves every
open report on the target in one transaction (an advisory lock per target makes two moderators take
turns):

| Action | Reports become | Content |
| --- | --- | --- |
| Dismiss | dismissed | unchanged |
| Mark reviewed | reviewed | unchanged |
| Remove (reason required) | reviewed | `removed` |
| Restore | any open ones dismissed | `removed` → `published` |

Profiles can be dismissed or reviewed, not removed; a moderator can instead revoke the person's local
status (`set_local_status`, reason required), which is also audited.

**Removed means removed for everyone.** `can_view_place` and `can_view_event` no longer let an owner
see their own removed content, so it disappears from discovery, detail pages, saved lists and counts
for its owner too. The owner instead sees a "Removed by moderators" section on their profile with the
reason (`my_removed_content()`), and cannot edit or republish it. Nothing is deleted, so a moderator
can restore it.

**The audit trail** is `moderation_actions`: who, what, which target, the reason, the time, the status
before and after, and how many reports it resolved. Moderators can read it; nobody else can. It is
append-only twice over: no client has an insert, update or delete grant, and a trigger refuses every
update or delete, even by the table owner (and so by any definer-rights function), unless the
session is the service role. The one change it allows is the foreign key clearing `moderator_id` when
a moderator deletes their account.

## Rate limits

Write volume is bounded in the database, so a client calling PostgREST or Storage directly with its
own JWT hits the same limits as the app. `check_rate_limit(action)` counts writes per user in fixed
windows (`rate_limit_counters`), under a per-user-and-action advisory lock, and raises SQLSTATE
`FM429` with how long to wait; the app turns that into "Too many places for now. Try again in about
3 hours." The increment rolls back with the write it guards, so a write that fails for another reason
does not use up the allowance. Sessions without a user (seeds, SQL, the service role) are not limited.

| Action | Limit | Enforced by |
| --- | --- | --- |
| Places | 20 a day | `before insert` trigger on `places` (also covers `create_place_with_details`) |
| Events | 50 a day | trigger on `events` |
| Ratings | 100 a day | trigger on `place_ratings` (an upsert counts, even when it updates) |
| Lists | 30 a day | trigger on `saved_lists` (on top of the 100-list cap) |
| Reports | 30 a day | trigger on `reports` |
| Photo uploads | 60 an hour | the Storage insert policy; one per photo, not per stored size |
| Avatar uploads | 20 an hour | the Storage insert policy |
| AI trip plans | 10 a day | `check_rate_limit('trip_plans')`, called before Claude is |
| Messages | 60 an hour | trigger on `messages` |
| Sign-ups | 5 an hour per IP | the sign-up server action |

The numbers live in one table, `rate_limit_rules`, mirrored by `RATE_LIMITS` in
`src/lib/rateLimits.ts`; a test keeps them equal, and the demo repository enforces the same limits
with the same window arithmetic. Sign-ups (and, later, password-reset requests) cannot be attributed
to a user, so they are limited per IP in the server action with an in-memory limiter. That limiter is
**per instance**: a deploy running several instances needs a shared store (Redis, Upstash or a
Postgres table) for it to be global. Supabase Auth's own limits sit in front of it (see
[Going live](#going-live-with-supabase--mapbox)).

## Discovery queries

Discovery filters in SQL rather than in the browser, so a search covers every matching record, not
just the newest few hundred. `public.discover_places` and `public.discover_events` take a bounding box
(antimeridian-safe), text, category and any-of tags. They are invoker-rights `language sql` functions
with no `SET` clause, so RLS applies to every row and Postgres inlines them, letting the caller's
ORDER BY and LIMIT use the indexes. Search text is a literal substring (wildcards are escaped in SQL);
taxonomy keywords such as "hoops" → pickup sports are expanded once in `src/lib/data/discovery.ts`
and passed in, so demo and Supabase modes match the same records.

The repository exposes two read models over the same filters:

| | `search` (list) | `mapMarkers` (map) |
| --- | --- | --- |
| Records | full `Place` / `Event` | compact id, name, category, coordinates |
| Order | places newest first; events soonest first; id breaks ties | places by rating count, then saves; events soonest first |
| Size | pages of 30 (max 100), keyset `nextCursor` | capped at 300 (max 1000), `truncated` flag |

Map pins are capped and flagged instead of paged, because a paged map would make dense areas look
empty. Cursors are opaque and keep microsecond timestamps, so page boundaries never skip or repeat
a row. HTTP access: `GET /api/discover/places`, `/api/discover/events` and `/api/discover/map`,
with `bbox=west,south,east,north`, `q`, `category`, `tags=a,b`, `neighborhood`, `createdAfter`,
`limit`, `cursor`, `includePast`, (events only) `startsBefore` and (map only) `kind=all|places|events`. Responses are `private, no-store` because what you see
depends on who you are. `tests/discovery.test.ts` runs every filter for four viewers against both the SQL
functions and the demo repository, and requires identical pages.

**Nearest.** Lists can also be ordered by distance from a point: `places.search({ near })`, or
`near=lat,lng` on `/api/discover/places`. `discover_places_nearest()` returns ids in (distance, id)
order with a keyset cursor on both, computed in SQL with the usual filters (a bounding box
prefilters when given), and the repository fetches the full rows by id. Distance is
equirectangular, rounded to the centimetre, with a JavaScript twin (`discoveryDistance`) so the demo
store orders identically; the parity test walks every page for several viewers and filters. On
Explore, "Nearest first" appears beside the places list once the browser has a location. PostGIS
was not needed: the measured plans are fine at 50k places (see [Performance](#performance)).
The Saved page keeps its client-side Nearest sort, since it already holds the whole list.

**Explore** is built on these. With no search text, results follow the map: once panning or zooming
settles, it queries the visible bounds (debounced, stale requests aborted, previous results kept on
screen while the next load). With search text, it searches everywhere, fits the map to the matches, and
offers "Search this area" to narrow to the viewport. When the pin cap truncates a dense area, the map says
so and asks the viewer to zoom in; list sections page with "More places". The selected pin stays on
the map across refreshes, and a pin whose details are not loaded fetches them from
`GET /api/discover/item`. The server renders the first result set for the default viewport; the client
re-queries with the real bounds once the map loads.

**The other discovery pages** use the same list model. Events, New this week, each interest and each
neighborhood render the first cursor page on the server and load more on demand. The Today and This
week filters send a `startsBefore` computed in the viewer's local time. Header counts and the
Interests and Neighborhoods indexes come from `count()` and two invoker-rights aggregates,
`discover_tag_counts` and `discover_neighborhoods`, so a place the viewer cannot see is never counted.
Neighborhoods match on a normalized key (trimmed, lowercased, whitespace collapsed). The event form's
place picker searches `/api/discover/places` instead of listing every place.

## Accounts

**Password recovery.** "Forgot password?" on sign-in leads to `/auth/forgot`. It always answers the
same way ("if an account uses that address, we sent a link"), whether or not the email exists, and
is limited to 5 requests an hour per network and per address. In Supabase mode it calls
`resetPasswordForEmail` with a redirect through `/auth/callback` to `/auth/reset`, where `updateUser`
sets the new password; Auth's own email limits sit in front. In demo mode no email is sent: the page
shows the reset link instead. Demo tokens are random, stored only as hashes, in memory, valid for an
hour and once; a request for an unknown email gets a decoy token that fails exactly like an expired
one, so even the demo answer does not reveal who has an account.

**Account deletion** is in `/profile/settings`. The user re-enters their password (checked on a
separate client with no cookies), and the confirmation lists exactly what goes. One admin call
deletes the auth user; the database cascades the rest (0012): profile, places and events they
created (with their photos, ratings, saves and attendees), photos they added to other places,
ratings, saves, lists, follows and attendance. Then every stored image goes: all three sizes of each
photo on their places or uploaded by them, their avatar, and anything left in their Storage
folders. A failed image removal is reported to monitoring with the paths, rather than undoing a
deletion the user asked for. The deleted user's id is logged, so a restore from an older backup can
re-apply deletions made since.

**Decision: reports a deleted user filed are kept, anonymized** (pending owner confirmation).
`reports.reporter_id` becomes null. An open report about harmful content should not disappear because
the person who filed it left, and a removal decision should still show what it was based on.
Nothing in the report identifies them afterwards. Moderation history they wrote is kept the same way.

## Onboarding

New accounts land on `/welcome`, four short steps: interests (they start the map's filter),
home city (with the local-tier rules spelled out: when they will count as a local, and the 30-day
change limit), optional location (kept on the device), and people who share their interests to
follow. Every step can be skipped, and "Skip setup" ends it at once. Finishing or skipping sets
`profiles.onboarded_at`; Explore sends a signed-in user without it to `/welcome`, so it shows until
finished or skipped and never again. It lands on the map filtered to their interests, with a nudge
to save a first place. Existing accounts were marked onboarded by the migration (and the demo store
upgrade), so nobody is sent back through it.

## Operations

**Deployment target: Vercel.** It runs Next.js 16 natively (server actions, the proxy, streaming,
`instrumentation.ts`), gives preview deploys per branch, and Vercel Cron covers the scheduled work
later sessions add. `vercel.json` sets `npm ci`, the build, the `iad1` region (close to a us-east
Supabase project), and a 30-second function limit for photo uploads. Set the variables from the
table above in the Vercel project, separately for Preview (point it at the staging Supabase project)
and Production. A Vercel build without the Supabase variables fails on purpose.

**Per-instance behaviour.** Two things are per server instance, not global: the image pipeline's
two-at-a-time processing limit (`withImageSlot`), and the in-memory limiters for sign-ups, password
reset requests and client error reports. On Vercel each function instance has its own. The database
rate limits are global. For a global sign-up limit across instances, move `createMemoryLimiter` onto
a shared store (Upstash Redis, or a Postgres table keyed by IP hash).

**Monitoring** (`src/lib/observability`). Every server error is one JSON log line (level, message,
time, stack, context), which Vercel's log view and any log drain index. Context keys that could carry
personal data (password, token, secret, cookie, email) are dropped. Forwarding is off unless
configured: `SENTRY_DSN` sends events to Sentry's envelope endpoint over plain `fetch` (no SDK in the
bundle), `ERROR_WEBHOOK_URL` POSTs JSON anywhere. Reported automatically: unexpected server-action
failures (`toFailure`), every uncaught route, render and action error (`onRequestError` in
`src/instrumentation.ts`), React error boundaries (`error.tsx` and `global-error.tsx` post to
`/api/client-errors`, at most 30 a minute per client), and failed image cleanup after account
deletion. `GET /api/health` answers `{"status":"ok"}` or a 503 `{"status":"unavailable"}` after a
one-row read of a public table as anon, with a 3-second timeout: point an uptime monitor at it.

**Security headers.** On top of `nosniff`, `X-Frame-Options`, the referrer policy and the
permissions policy in `next.config.ts`, the proxy sets a Content-Security-Policy per request with a
fresh nonce (`src/lib/security/csp.ts`). Scripts need the nonce (`'strict-dynamic'` lets Next's own
scripts load the rest); connections, images and workers are limited to the site, Supabase,
OpenFreeMap and Mapbox; framing, plugins and foreign form targets are refused. Styles allow
`'unsafe-inline'` because the map libraries set inline styles on the elements they create. The e2e
suite fails on any CSP violation in the browser console.

**Backups** are covered in `docs/runbooks/backup-and-restore.md`: point-in-time recovery, the
restore rehearsal, a scheduled Storage copy (Supabase backups do not include Storage), and restoring
production.

**Staging gate.** `scripts/staging-check.ts` applies the migrations with `supabase db push`, creates
four users with the admin API (two members, a 0-day-old account and a moderator), checks
cross-user access, the locals tier, lists, private photos, moderation and the list rate limit over
HTTP, runs the image migration as a dry run, then the e2e suite against the staging deployment, and
deletes its users at the end. Without credentials it exits 2 and changes nothing.

## Performance

Measured with `npx tsx tests/helpers/measure-discovery.ts 50000 --runs 10`: 50,026 places and 5,013
upcoming events, all in one city (the dense case), ~12% locals-only, text from a 64-word vocabulary.
PGlite is single-threaded WebAssembly, so absolute times are pessimistic; the comparison and the
plans are what matter. p95 in milliseconds, as anon / as a signed-in local:

| Query | Before 0013 | After 0013 | Plan after |
| --- | --- | --- | --- |
| Map markers, zoomed box | 6.5 / 3.2 | 4.7 / 1.6 | box index, sort |
| Map markers, whole city | 5.7 / 2.8 | 2.0 / 1.4 | notability index |
| List page 1, no filters / deep page | 1.2 / 5.7 | 0.9 / 4.8 | recency index |
| List page 1, category + tag | 65 / 56 | 67 / 58 | recency index + tag filter |
| Search, rare term | 361 / 353 | 8.7 / 7.6 | trigram indexes → id lookup |
| Search, common term | 3.7 / 3.0 | 35 / 29 | trigram indexes → id lookup |
| Search, no match | 375 / 352 | 10 / 10 | trigram indexes |
| Search, events | 87 / 47 | 9.7 / 9.5 | trigram indexes |
| Count, whole city | 353 / 261 | 64 / 30 | scan (counts every visible row) |
| Aggregates (neighborhoods, tag counts) | 497–656 | 235–393 | scan (aggregates every visible row) |
| Nearest, whole city | – | 112 / 84 | distance over the box, top-N sort |

What changed in 0013, and why:

- **Text search had no usable index under RLS.** Postgres will not run a non-leakproof operator like
  `ILIKE` before a row policy, so even with trigram indexes every API search walked the table. The
  match now runs in definer-rights helpers (`discover_place_text_ids`, `discover_event_text_ids`) that
  can use the indexes and apply the same visibility rule themselves, returning only ids the caller
  could see; the outer query still runs under RLS. A test compares them with the old row-by-row
  match for every viewer, and another with the policies. Common words got slower (they used to find
  31 matches a few rows into the recency index), but the worst case went from ~370 ms to ~35 ms.
- **The places and events policies looked each row up again** through `can_view_place(id)`. They now
  test the row's own columns, which roughly halved every count and aggregate. The child tables keep
  the functions; a test holds the two forms to the same answer for every row and viewer.
- City-wide counts and the two aggregates still scan, by nature: they visit every visible row.
  Header counts and the index pages use them; at beta scale they are fine, and if they are not, they
  are the first candidates for a per-viewer-class cache.

**Images:** `node scripts/measure-images.mjs` uploads six ~2.6MB phone photos (15.6MB) through the
form and loads the page at 412px / DPR 1.75: 285KB of images (the hero at 960px, five gallery
thumbnails at 480px), against the 600KB budget. **Concurrency** (`node scripts/load-test.mjs`, demo
mode, 20 connections for 15s on this machine): map discovery 3,126 req/s with p99 12ms; a place page
418 req/s with p99 65ms; no errors or non-2xx responses. Run it against staging before trusting
production numbers.

## Accessibility

- **Map pins** are buttons with a full name ("Little Alley Dumpling, Food, rated 4.7 from 3
  ratings"; events give their start time), `aria-pressed` for the selected pin, and a visible focus
  ring. They are in the tab order, and Enter or Space opens them. The list panel carries the same
  results for anyone who prefers it.
- **Sheets** (the save sheet, report, confirmations) are modal dialogs: focus moves into them (the
  first field when there is one), Tab and Shift+Tab stay inside, Escape closes them, and focus returns
  to whatever opened them.
- **Contrast:** axe found muted text, the flare accent, category labels and avatar initials below AA.
  The muted, danger and moss tokens are darker, a `flare-ink` token is used wherever flare is text or
  sits behind white text (the bright flare stays for fills and icons), and `readableInk()` darkens
  category and avatar colours just enough wherever they are text or behind it.
- **Motion:** `prefers-reduced-motion` stops the pulsing event pins and slide-ins, and makes map
  flights jump instead of animating. Pinch-zoom is no longer disabled.
- `npm run a11y` runs axe-core over 15 pages and sheets (with reduced motion on) and fails on serious
  or critical violations. A manual screen-reader pass has not been done yet (see the beta gate).

## Feature flags (Part B)

Everything built after the beta is off until listed in `NEXT_PUBLIC_FEATURES` (comma-separated,
or `all`): `analytics`, `reputation`, `admin`, `recommendations`, `aiRerank`, `tripPlanning`,
`messaging`, `notifications`, `push`, `payments`, `ads`, `pwa`. `featureEnabled()` in
`src/lib/config.ts` is the one switch. Features that call an outside service also need its key
(`ANTHROPIC_API_KEY`, the VAPID keys, the Stripe keys) and stay off without it, UI included.
The flag is inlined at build time, so changing it needs a rebuild. The database objects for every
feature exist regardless (migrations always apply); the flags decide what the app uses and shows.

## Analytics

First-party and pseudonymous, with no third-party tracker unless you add one (migration 0015).

- **What is recorded:** key actions only: view place, save, add to list, add a place, create an
  event, join an event, follow, rate, a search with no results, and onboarding steps. Each event is a
  name, a few ids in `props` (at most 1 KB), and a time. No IP address, no user id: the actor is a
  salted SHA-256 of the user id, and the salt sits in a table no client can read. Signed-out visitors
  are not recorded.
- **How it is written:** only through `track_event()` (definer rights). It takes the actor from the
  session, so nobody can write events as someone else; the event name must be on the list; it is
  rate-limited (600 an hour); and it does nothing for a user who opted out. The app calls it from
  `src/server/analytics.ts` after the action succeeds, never letting a failure reach the user, and
  skips it entirely when the browser sends Do Not Track (`DNT: 1`) or Global Privacy Control
  (`Sec-GPC: 1`). Settings has a "Share anonymous usage" switch.
- **Who can read it:** admins only (`public.admins`, granted from SQL like moderators;
  `dev@example.com` in demo mode). `/admin/metrics` shows the core-loop funnel (distinct people per
  step over 30 days), weekly active contributors (12 weeks), and the **thesis metric**: the share of
  saves that went to places people added (`places.source = 'community'`) rather than seed data.
  That one is computed from the saves themselves, so it is exact and identifies no one. Every place
  a user creates is `community`; only SQL (seeds, imports) can write `seed`.
- **Retention:** 180 days. `purge_analytics()` deletes older events; Vercel Cron calls
  `/api/cron/purge-analytics` daily at 04:17 UTC with `CRON_SECRET` (`vercel.json`). Running it
  twice deletes nothing the second time.
- **Forwarding (optional, off):** `POSTHOG_KEY` + `ANALYTICS_FORWARD_SECRET` send each event to
  PostHog with an HMAC of the user id as the distinct id and no IP; `PLAUSIBLE_DOMAIN` sends
  Plausible custom events with no identifier at all.

## Reputation and the extra tiers

**Levels, not scores.** `compute_reputation()` scores what other people do with what you add:
+2 per save and +2 per rating others give your places, +1 per person who joins your events, +3 per
place still up two weeks after you added it, −10 per place or event moderators removed, +1 / −1 per
report of yours moderators reviewed / dismissed, all scaled by account age up to 30 days. Your own
saves, ratings and attendance count for nothing. People only ever see a level: **New**,
**Contributor** (10+ and a week old) or **Trusted local** (40+, 30 days old, local status not
revoked). The score is readable by admins only (`reputation_cache`); `/help/reputation` explains how
levels are earned.

**Cached, refreshed hourly.** Levels live in `reputation_cache`, `profiles.reputation_level` and
`places.creator_reputation`, refreshed by `/api/cron/refresh-reputation` (Vercel Cron, hourly,
`CRON_SECRET`), at the end of the seed, and immediately for anyone a moderator resets. Row policies
read the stored level instead of recomputing it per row. Clients cannot write any of the three.

**Ranking.** The creator's level is one input to map ranking: after rating count and save count,
before the id tie-break. It never outranks what people actually rate and save.

**Moderator reset.** On a profile's moderation page (behind the `reputation` flag), "Reset
reputation" requires a reason, makes everything earned so far stop counting, and is recorded in the
moderation history as `reset_reputation`.

**Two new visibility tiers** for places, on top of public, locals and private:

| Tier | Who sees it |
| --- | --- |
| `trusted` | locals of the place's city whose level is Trusted local |
| `followers` | people the creator follows back (mutual follows) |

The rule is written three times (the places policy, `can_view_place()` for photos, ratings,
saves, lists, events and Storage, and the text-search helper) and tests hold all three, and the
demo store, to the same answer for every row and viewer. Events at such a place inherit its
visibility as before; saved lists show only what their owner can still see, so a place drops out of
someone's list the moment the creator stops following them back. The add-place form and the owner
controls offer the two tiers when the `reputation` flag is on.

## Admin dashboard

`/admin` (admins only, `admin` flag on; 404 otherwise): People (search, suspend / lift, grant /
revoke moderator), Content (any status, filters, links to each item's moderation history), the
report queue, Metrics (plus rate-limit hits right now), and Categories and interests. Admins count as
moderators. Every admin write needs a reason and lands in `moderation_actions`.

**Decision: suspension stops writes, content stays up** (pending owner confirmation). A trigger on
every user-writable table, and the upload policy, refuse any write from a suspended account; they
can still sign in and browse. Their existing content is not hidden; moderators remove individual
items. **Taxonomy:** the database is the live vocabulary (editable, retirable, audited by slug);
the app's pickers come from `src/lib/data/taxonomy.ts` at build, so `scripts/pull-taxonomy.ts`
plus a deploy brings edits into the UI.

## Recommendations ("For you")

Behind the `recommendations` flag, signed-in people get a "For you" rail on Explore (while browsing,
not during a search) and on the Events page. Every card says why it is there.

**Rule-based, in SQL, under RLS.** `recommend_places()` and `recommend_events()` are invoker-rights,
so every candidate passes the same row policies as the rest of the app: a locals-only, trusted or
followers place can only be recommended to someone who could already open it. They use only signals
the viewer may read: their own interests, saves, ratings and joined events, and public activity of
people they follow (places those people added or rated highly, events they host or joined). Other
people's saves stay private and are never a signal. The viewer's own places, and anything they already
saved, rated or joined, are left out.

| Places | Weight | Explanation |
| --- | --- | --- |
| added by someone you follow | +4 | Added by @x, who you follow |
| rated 4+ by someone you follow | +3 | Rated highly by @x |
| shares a tag with a place you saved or rated 4+ | +3 | Because you saved X |
| each tag matching your interests | +2 | Matches your interest in Hiking |
| same category as events you join | +1 | Like the events you join |
| nearby (with a location) | up to +2, fading over ~3 km | |

Events score +4 at a place you saved, +4 hosted by someone you follow, +2 if someone you follow is
going, +2 per interest tag, +1 on the weekday you usually go out (Columbus time), up to +1.5 for
starting soon and +2 for being nearby. The strongest signal is the explanation.

**Diversity, so it is not the most-saved list again:** places get +1.5 when a person added them (not
seed data) and +1.5 / (1 + saves), so lesser-known places get the most lift; small events (under five
going) get +0.5. Popularity is never a positive signal. The demo store
(`src/lib/data/demo/recommend.ts`) uses the same weights, rounding and order, and a parity test
compares every seeded user's places and events, scores and reasons, with and without a location. It
runs live; at beta scale that is fast enough (it reads the viewer's own rows plus candidate places).

**Optional AI rerank** (`aiRerank` flag plus `ANTHROPIC_API_KEY`): Claude reorders the top 20 and
rewrites the reason lines, through the official SDK, server-side only (`src/server/recommendations/rerank.ts`).
Model `claude-sonnet-5` by default, set with `RECOMMENDATIONS_MODEL`; low effort; the static system
prompt is cached; structured output (a zod schema); a 4-second timeout and no retries. It sends only
the viewer's interests, the names of places they saved, and each candidate's public fields (name,
category, neighborhood, tags, local tip, rating): no usernames and nothing about anyone else, so the
rule-based reason texts (which can name people you follow) are not sent. The answer is trusted for
nothing: unknown or repeated ids are dropped, missing ones keep their rule order, and a timeout, API
error, refusal or unparsable answer falls back to the rule-based order. Only mocked in tests (no key
was available); see the owner checklist.

## AI trip planning ("Plan my day")

Behind the `tripPlanning` flag, and only when `ANTHROPIC_API_KEY` is set (otherwise `/plan` and its
API return 404). The person gives a day and time window, a vibe, interests, a budget and a starting
point; `/api/trip-plan` streams progress ("Searching places…") and then the plan, as
newline-delimited JSON.

**How it works** (`src/server/trips/`): a server-side Claude agent, a manual tool loop on the
official SDK, model `claude-opus-5-5` by default (`TRIP_PLANNER_MODEL`), medium effort, the static
system prompt cached, and server-side refusal fallbacks on (`fallbacks: "default"`, beta
`server-side-fallback-2026-07-01`). Its tools are all read-only and all run as the signed-in viewer:
`search_places`, `get_place`, `upcoming_events`, `my_saved` (their own saves and list names) and
`distance`. The viewer id comes from the session, never from the model, and every read goes through
the repository, so RLS decides what the model can see. It can never read anyone else's saves, lists
or private places. Inputs are validated with zod; a bad call comes back as an error result.

**Limits:** at most 10 tool rounds, 90 seconds overall, and 10 plans per person per day
(`trip_plans` in `rate_limit_rules`, counted before Claude is called).

**Only real places:** the plan arrives through a strict `submit_plan` tool. Every stop is looked up
again as the viewer, and unknown, invisible, repeated or malformed stops are dropped (the page says
how many). Places and events are linked to their real pages.

**Afterwards:** "Save as a list" creates a list (and saves the places) through the normal list rules;
each place stop has "Make it an event", which opens the event form with the place linked.

Tested with a mocked Anthropic client only: tool permissions, validation, the loop's caps and
failure paths, the request shape, and the limit. Running it for real needs an API key (owner
checklist).

## Messaging

Behind the `messaging` flag. Two kinds of conversation (`0020_messaging.sql`):

- **Event group chats.** Every event has one, and its members are exactly the people going: a
  trigger on `event_attendees` adds you when you join and removes you when you leave (the migration
  backfills everyone already going). The chat closes, read-only, once the event is cancelled or
  removed, and is deleted with the event. The event page links to it for people going.
- **Direct messages**, one conversation per pair (`direct_key`). **The anti-spam rule:** you can start
  one only with someone who follows you back, or who is going to an event you are both going to
  (`can_message`, used by `start_direct`). Nobody can be messaged out of the blue, so there are no
  message requests to triage. An existing conversation stays open if you later unfollow or leave the
  event; blocking is how to end it. Someone else's profile shows "Message" when the rule allows it,
  and the rule in words when it does not.

**Privacy is in the database.** Only members read a conversation, its members or its messages (RLS
with definer helpers, so the policies do not recurse). Members insert messages only as themselves;
nobody can edit or delete a message, add members, or create conversations except through
`start_direct` and the attendance trigger. Read receipts are each member's own `last_read_at`
(column grant plus an own-row policy), set by `mark_read` with the database clock. Message text is
never indexed and no discovery or recommendation function reads it.

**Blocking** (`blocks`, private to the blocker): a blocked person cannot start or continue a direct
conversation with you, in either direction (`messaging:blocked`); you stop seeing their messages,
including in event chats; and you disappear from their view of member lists. Group chats stay open to
both. Unblock from the conversation, their profile or `/messages`.

**Abuse:** messages are rate limited (60 an hour), suspended accounts cannot send or block, and a
member can report a message into the moderation queue (only members can, since only they saw it).
Moderators see the full text of a reported message, and only of reported ones; removing it hides it
from everyone, and restoring brings it back. Deleting an account deletes its messages, memberships
and blocks; the other person keeps the conversation, with "Deleted account" on the other side.

**Delivery.** `/messages` lists conversations with unread counts (`my_conversations()`); the rail
shows the total. A thread loads its newest 50 messages (keyset pages via `conversation_messages`)
and then stays live: with Supabase it subscribes to Realtime inserts on `messages` (the migration adds
the table to the `supabase_realtime` publication when it exists, and RLS decides who receives each
row) and refetches through `/api/messages/[id]`, with a slow poll as a fallback; in demo mode it polls
that route every 4 seconds while the tab is visible. The route answers members only.

Tested in PGlite under RLS (membership, the anti-spam rule, blocking both ways, the attendance
trigger, closed chats, the rate limit, suspension, reports and moderation), for parity with the demo
store (conversations, unread counts, previews and the can-message matrix for every pair of seed
users, and account deletion), through the actions and the route, and in a two-browser demo run.
Realtime itself has not run against a real Supabase project (owner checklist).

## Data model

`profiles` · `profile_interests` · `interests` · `categories` · `places` · `place_tags` · `place_photos` · `place_ratings` · `saved_places` · `saved_lists` · `saved_list_items` · `events` · `event_tags` · `event_attendees` · `follows` · `reports` · `moderators` · `moderation_actions` · `local_revocations` · `rate_limit_rules` · `rate_limit_counters` · `conversations` · `conversation_members` · `messages` · `blocks`

Plus two views for the report read paths: `reports_i_filed` and `reports_about_my_stuff`.

Integrity is enforced in the database, not just the UI:

- one rating per user per place (`unique (place_id, user_id)`), aggregate maintained by trigger
- at most six photos per place, enforced by trigger
- one join per user per event (primary key), capacity and "not ended" enforced by a trigger that row-locks the event
- saved lists organize bookmarks without replacing them: `saved_places` is still the save, and a saved place can be in no list or in several. Two composite foreign keys hold the rules. `(list_id, owner_id) → saved_lists` means an item can only live in its own owner's list. `(owner_id, place_id) → saved_places` means an item is always one of its owner's bookmarks: no orphan items, and unsaving a place removes it from every list. Deleting a list keeps its bookmarks. List names are normalized in the database the same way the app normalizes them (every whitespace run, tabs and Unicode spaces included, becomes one space, and the ends are trimmed). They are unique per owner, ignoring case and spacing, and each owner can have at most 100 lists (a trigger with an advisory lock). RLS makes lists and items owner-only, and only a list's name can change. `add_to_saved_list` bookmarks and adds in one transaction, and `saved_list_summaries()` counts only the places the owner can still open. In the app, the bookmark on a place's page saves it in one tap and opens a "Save to" sheet. There you can unsave it (which also takes it out of every list), tick any of your lists, or create a new list with the place already in it. `/saved` shows your lists above all saved places. `/saved/[id]` is one list, visible only to its owner, with search and sort, "remove from this list", rename, and delete (which keeps every place saved)
- no self-follows, no duplicate follows or saves, one open report per reporter per target
- check constraints on coordinates, scores, lengths, statuses
- `places.visibility` drives the trust tiers, and events inherit the visibility of their linked place; `removed` is set only by moderators (`moderate_target`), and `pending` stays reserved
- profiles grant update only on the columns a user edits, so nobody can backdate `created_at` or `home_city_changed_at`; a trigger forces both on self-inserted rows too

## Security notes

- The browser only ever sees the anon key. Every read and write in Supabase mode goes through a request-scoped server client under RLS. Users can only insert rows as themselves and update/delete rows they own.
- Clients cannot write `rating_avg`, `rating_count`, or `creator_id`. Owners can set only the documented listing states and visibility tiers; RLS and database checks enforce those limits.
- Server actions re-validate all input with Zod and re-check the session; nothing trusts client-side state.
- Redirect targets after auth are restricted to same-origin paths. Demo uploads are served from a strict filename allow-list.
- Security headers (`nosniff`, `X-Frame-Options`, referrer policy, permissions policy) are set in `next.config.ts`.

## Decisions worth knowing

- **Demo mode is a first-class repository, not a mock.** It mirrors the Postgres tables and rules (including capacity, duplicate-join, and rating aggregation), so the UI you develop against behaves like production.
- **Filtering happens in the database, scoped to the map viewport.** Search text, category and tags go to the discovery functions along with the visible bounds, so results cover every matching record rather than a fixed recent slice. See [Discovery queries](#discovery-queries).
- **The map provider is chosen at build time** from `NEXT_PUBLIC_MAPBOX_TOKEN`; only the selected library is bundled. A token that is not a public `pk.` token never selects Mapbox, and a Mapbox map that fails before its first load (a revoked or mistyped token) swaps itself for MapLibre and reports the failure. The Mapbox renderer has never been rendered with a real token; that is on the owner checklist.
- **Pin clustering is deferred.** The map caps pins at 300 per view and asks the viewer to zoom in when an area is truncated. Real clustering means rendering pins as a GeoJSON layer (both libraries cluster sources natively) instead of the React `<Marker>` elements used now, which would lose the pin buttons' accessibility and needs a rewrite of `MapCanvas` for both providers. Building half of that would be worse than the cap, so it waits for a session of its own.
- **Address lookup runs server-side** at `/api/geocode`, using Mapbox when a token is set and
  OpenStreetMap's Nominatim otherwise. Proxying it keeps the provider off the client, lets one
  cache serve every user, and satisfies Nominatim's requirement for an identifying User-Agent and
  roughly one request per second. Typing an address moves the pin, and the matched bounding box
  picks the zoom, so a street address lands close and a neighborhood stays wide. A pin the user
  placed by hand is never moved automatically; the match is offered as a button instead.
- **Forms submit through `onSubmit` rather than the `action` prop.** React 19 resets a form after
  an action settles, which silently destroyed typed input and the selected photo list on any
  validation error. Submitting inside a transition keeps the DOM intact. See
  `src/lib/forms/useFormSubmit.ts`, which also focuses the first field the server rejected.
- **Place "local tip" is a dedicated field.** It is the product's differentiator, so it gets its own prominent slot on cards and detail pages.
- **Seed data is fictional** (names, tips, venues) and placed at real Columbus coordinates so the map looks alive. It is not a set of real recommendations. One seeded account (`nina@example.com`, home city Cleveland) is deliberately *not* a Columbus local, so the trust tier is visible in demo mode rather than only in tests.
- **Images:** uploads are processed server-side (see the image pipeline above), then go to Supabase Storage in per-user folders, or to `.data/uploads` in demo mode. Place photos are private and are served only through `/api/photos/[id]` after a visibility check (see [The community layer](#the-community-layer)); avatars stay public. Photos are plain `<img>` with `srcSet`, not `next/image`: the files are already sized, and the optimizer would have to fetch private photos through the authorized route anyway. Places without photos get a generated category cover so nothing looks empty.

## Decision: is a self-declared home city enough for the local tier?

**Status: pending owner confirmation.**

Before Session 8, `is_local(city)` trusted the profile's home city, which anyone could set at sign-up
and change at will, so "locals only" was a soft barrier. The beta default, now implemented:

- **New accounts wait 7 days** before they count as a local anywhere.
- **Home city changes at most once per 30 days**, enforced by a trigger (the first time it is set is
  free, and so are case and spacing fixes). The profile form shows the next allowed date.
- **Moderators can revoke local status** for a user, with a reason and an audit entry, and restore it.

Alternatives considered and deferred:

- **Address verification** (a mailed code, or a utility bill): strong, but it costs money, adds a
  privacy burden (storing addresses), and is a heavy step for a beta.
- **Vouching by existing locals**: fits the community thesis, but needs a reputation system to stop
  rings of new accounts vouching for each other. It belongs with Session 11's reputation work.
- **Activity thresholds** (for example, three published places in the city before you count): hard to
  fake, but it locks newcomers out of exactly the places they most want to find, and it rewards
  volume over knowledge.

## Intentionally deferred

Push notifications, payments, ads, native apps and production deployment, until their sessions
land; analytics, reputation, the admin dashboard, recommendations, trip planning and messaging are
built and sit behind [feature flags](#feature-flags-part-b).
