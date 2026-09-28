# FindMaxxing

**Local knowledge, mapped.** FindMaxxing is a mobile-first discovery and social app: an interactive map of the places and activities locals actually use, contributed by the community. Think "Beli, but for every activity": the sports bar that reliably shows the game, the field where pickup actually happens, the study spot nobody posts about.

The core loop: **discover → view → save → contribute → create event → join event → connect**.

## Stack

- **Next.js 16** (App Router, Server Components, Server Actions), **React 19**, **TypeScript**
- **Tailwind CSS v4** with a custom design-token system (`src/app/globals.css`)
- **Supabase** (Postgres + Auth + Storage) with Row Level Security; **demo mode** fallback with no credentials
- **Mapbox GL** when a token is present; **MapLibre GL + OpenFreeMap** tiles otherwise (no key needed)
- **Zod** validation shared by forms and server actions
- **Vitest** + **PGlite** (embedded Postgres) so the real SQL migration is tested on every `npm test`

## Quick start (no credentials needed)

```bash
npm install
npm run dev
```

Open http://localhost:3000. The app runs in **demo mode**: a file-backed local store (`.data/demo-store.json`, git-ignored) seeded with fictional Columbus, Ohio data. Sign in from `/auth/sign-in` by tapping a persona, or with any seeded email (e.g. `maya@example.com`) and the password `findmaxxing`. Sign-ups, saves, ratings, events and follows persist across restarts. When the store format changes, the file is migrated forward on startup and the previous copy is kept beside it as `demo-store.v<N>-<timestamp>.bak.json`; an unreadable or newer file is backed up rather than overwritten. Delete `.data/` to reset.

## Checks

```bash
npm run typecheck   # next typegen + tsc
npm run lint        # eslint (next + react-hooks rules)
npm run test        # vitest: validation, demo repository, and the SQL schema via PGlite
npm run build       # production build
npm run check       # all of the above
```

`node scripts/smoke.mjs` (with `npm run dev` running and Google Chrome installed) walks every major
flow in a headless browser and writes screenshots to `.data/smoke/`.
`node scripts/smoke-tier2.mjs` does the same for the community layer and asserts its Tier 2 checks,
including that a non-local genuinely cannot see a locals-only place.
`npx tsx tests/helpers/measure-discovery.ts 50000` loads synthetic places into PGlite and prints
query plans and timings for the discovery queries.

## Going live with Supabase + Mapbox

1. Create a Supabase project. In the SQL editor (or `supabase db push`), run:
   - `supabase/migrations/0001_init.sql` — schema, triggers, RLS policies, storage buckets
   - `supabase/migrations/0002_tier1_owner_controls.sql` — owner edit/delete rules
   - `supabase/migrations/0003_tier2_community_layer.sql` — trust tiers, photo cap, report views
   - `supabase/migrations/0004_audit_hardening.sql` — visibility inheritance, transactional writes, and concurrency guards
   - `supabase/migrations/0005_private_photos_and_save_counts.sql` — private place-photo bucket with visibility-checked reads, and trigger-maintained save totals
   - `supabase/migrations/0006_discovery_queries.sql` — bounded, RLS-scoped discovery functions and their indexes
   - `supabase/seed.sql` — optional fictional demo data (generated from `src/lib/seed/seed-data.ts` via `npm run seed:sql`; **do not use the demo users in production**)
2. In Supabase Auth settings, add `http://localhost:3000/auth/callback` (and your production URL) to the redirect allow-list. Email confirmation is supported: the sign-up flow shows a "check your email" state and `/auth/callback` exchanges the code.
3. Copy `.env.example` to `.env.local` and fill in:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | for Supabase mode | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | for Supabase mode | Public anon key; all queries run under RLS as the signed-in user |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Reserved for server-only admin scripts; never read by the app or sent to the browser |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | no | Public `pk.*` token. Without it the map uses MapLibre + OpenFreeMap |
| `NEXT_PUBLIC_MAPBOX_STYLE` | no | Custom Mapbox style URL |
| `NEXT_PUBLIC_SITE_URL` | no | Absolute origin for auth redirect links, and the User-Agent the geocoder identifies itself with |

Setting both Supabase variables switches the whole app to Supabase mode. There is no code change; `src/lib/data/index.ts` picks the repository implementation from the environment.

## Project structure

```
src/
  app/                       Routes (App Router)
    (explore)/               / — the map, with its own loading skeleton
    new                      Create chooser: place or event
    places/[id], places/new, places/[id]/edit
    events, events/[id], events/new, events/[id]/edit
    neighborhoods, neighborhoods/[name], tags, tags/[slug]
    saved, people, profile, profile/edit, profile/reports
    u/[username], u/[username]/[kind]
    auth/sign-in, auth/sign-up, auth/callback
    api/discover/*           Discovery endpoints: places, events, map, item
    api/geocode              Server-side address lookup (Mapbox or Nominatim)
    api/photos/[id]          Visibility-checked place photos
    api/uploads/[name]       Serves demo-mode avatar uploads
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
    supabase/                Server, browser and proxy clients
    validation/schemas.ts    Zod schemas for every form
    seed/seed-data.ts        Fictional demo data (drives both demo mode and seed.sql)
    map/, utils/
  server/actions/            Server Actions: auth, places, events, profile
  proxy.ts                   Refreshes the Supabase session on each request
supabase/
  migrations/                Ordered schema, RLS, feature, and hardening migrations
  seed.sql                   Generated demo seed
tests/                       Vitest suites (schema runs against PGlite)
scripts/                     seed generator, browser smoke test
```

## The community layer

Three features carry the "local knowledge is the moat" idea beyond a plain listings app:

**Trust tiers.** A place is visible to `public`, `locals`, or `private`. The rule for who counts as a
local is defined once, in SQL, as `public.is_local(city)`: your profile's home city matches, **or**
you have contributed a published place in that city. The demo store mirrors the same rule in
`isLocalOfCity`, and both are covered by tests, so the two paths cannot drift. Locals-only places are
filtered by the row-level policy itself, not by a query the client could forget.

**Photos follow their place.** Place photos live in a private bucket. The browser only ever sees
`/api/photos/[id]`, which checks visibility on every request (RLS in Supabase mode, `canViewPlace` in demo mode)
and then streams the bytes itself — no reusable signed URL that could outlive a visibility change. Responses are
`private, no-cache` with an ETag, so browsers revalidate before every reuse: a still-authorized viewer gets a 304
without a Storage download, and a viewer who has lost access gets a 404 on the very next request. The Storage read policy applies the same
`can_view_place()` rule, so a non-local cannot fetch a locals-only photo even with its object path, and an uploader's own objects are readable only while they are not yet attached to a photo row. Avatars
stay public because they belong to the public profile.

**Rating notes.** A rating is a number; the note attached to it is the local knowledge. Notes appear
as a reviews list on the place page. Only ratings that carry a note show up there.

**Reports that go somewhere.** Two read paths, exposed as definer-rights views that omit
`reporter_id` outright rather than merely not selecting it: `reports_i_filed` for the person who
filed, and `reports_about_my_stuff` for the owner of the reported listing. An owner can see what was
said and act on it by editing or hiding the listing. A moderation console over the base table is
service-role work and is deliberately not built.

Owners may set `published` and `hidden`. The `pending` and `removed` statuses stay reserved for
moderation, and the `WITH CHECK` clause on the update policy is what makes that reservation real.

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
with `bbox=west,south,east,north`, `q`, `category`, `tags=a,b`, `limit`, `cursor`, `includePast`
and (map only) `kind=all|places|events`. Responses are `private, no-store` because what you see
depends on who you are. `tests/discovery.test.ts` runs every filter for four viewers against both the SQL
functions and the demo repository, and requires identical pages.

**Explore** is built on these. With no search text, results follow the map: once panning or zooming
settles, it queries the visible bounds (debounced, stale requests aborted, previous results kept on
screen while the next load). With search text, it searches everywhere, fits the map to the matches, and
offers "Search this area" to narrow to the viewport. When the pin cap truncates a dense area, the map says
so and asks the viewer to zoom in; list sections page with "More places". The selected pin stays on
the map across refreshes, and a pin whose details are not loaded fetches them from
`GET /api/discover/item`. The server renders the first result set for the default viewport; the client
re-queries with the real bounds once the map loads.

## Data model

`profiles` · `profile_interests` · `interests` · `categories` · `places` · `place_tags` · `place_photos` · `place_ratings` · `saved_places` · `events` · `event_tags` · `event_attendees` · `follows` · `reports`

Plus two views for the report read paths: `reports_i_filed` and `reports_about_my_stuff`.

Integrity is enforced in the database, not just the UI:

- one rating per user per place (`unique (place_id, user_id)`), aggregate maintained by trigger
- at most six photos per place, enforced by trigger
- one join per user per event (primary key), capacity and "not ended" enforced by a trigger that row-locks the event
- no self-follows, no duplicate follows or saves, one open report per reporter per target
- check constraints on coordinates, scores, lengths, statuses
- `places.visibility` drives the trust tiers, and events inherit the visibility of their linked place; the `pending` and `removed` statuses are reserved so a moderation workflow can be added later without a migration

## Security notes

- The browser only ever sees the anon key. Every read and write in Supabase mode goes through a request-scoped server client under RLS. Users can only insert rows as themselves and update/delete rows they own.
- Clients cannot write `rating_avg`, `rating_count`, or `creator_id`. Owners can set only the documented listing states and visibility tiers; RLS and database checks enforce those limits.
- Server actions re-validate all input with Zod and re-check the session; nothing trusts client-side state.
- Redirect targets after auth are restricted to same-origin paths. Demo uploads are served from a strict filename allow-list.
- Security headers (`nosniff`, `X-Frame-Options`, referrer policy, permissions policy) are set in `next.config.ts`.

## Decisions worth knowing

- **Demo mode is a first-class repository, not a mock.** It mirrors the Postgres tables and rules (including capacity, duplicate-join, and rating aggregation), so the UI you develop against behaves like production.
- **Filtering happens in the database, scoped to the map viewport.** Search text, category and tags go to the discovery functions along with the visible bounds, so results cover every matching record rather than a fixed recent slice. See [Discovery queries](#discovery-queries).
- **The map provider is chosen at build time** from `NEXT_PUBLIC_MAPBOX_TOKEN`; only the selected library is bundled.
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
- **Images:** uploads go to Supabase Storage in per-user folders, or to `.data/uploads` in demo mode. Place photos are private and are served only through `/api/photos/[id]` after a visibility check (see [The community layer](#the-community-layer)); avatars stay public. Places without photos get a generated category cover so nothing looks empty.

## Intentionally deferred

Direct messaging, push notifications, recommendation algorithms, payments, moderation dashboard, advanced reputation scoring, native apps, analytics, and production deployment. The schema and repository contract are shaped so these can be added without rewrites.
