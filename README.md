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

Open http://localhost:3000. The app runs in **demo mode**: a file-backed local store (`.data/demo-store.json`, git-ignored) seeded with fictional Columbus, Ohio data. Sign in from `/auth/sign-in` by tapping a persona, or with any seeded email (e.g. `maya@example.com`) and the password `findmaxxing`. Sign-ups, saves, ratings, events and follows persist across restarts. Delete `.data/` to reset.

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

## Going live with Supabase + Mapbox

1. Create a Supabase project. In the SQL editor (or `supabase db push`), run:
   - `supabase/migrations/0001_init.sql` — schema, triggers, RLS policies, storage buckets
   - `supabase/migrations/0002_tier1_owner_controls.sql` — owner edit/delete rules
   - `supabase/migrations/0003_tier2_community_layer.sql` — trust tiers, photo cap, report views
   - `supabase/migrations/0004_audit_hardening.sql` — visibility inheritance, transactional writes, and concurrency guards
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
    places/[id], places/new  Place detail + Add Place
    events, events/[id], events/new
    saved, people, profile, profile/edit, u/[username]
    auth/sign-in, auth/sign-up, auth/callback
    api/uploads/[name]       Serves demo-mode image uploads
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

**Rating notes.** A rating is a number; the note attached to it is the local knowledge. Notes appear
as a reviews list on the place page. Only ratings that carry a note show up there.

**Reports that go somewhere.** Two read paths, exposed as definer-rights views that omit
`reporter_id` outright rather than merely not selecting it: `reports_i_filed` for the person who
filed, and `reports_about_my_stuff` for the owner of the reported listing. An owner can see what was
said and act on it by editing or hiding the listing. A moderation console over the base table is
service-role work and is deliberately not built.

Owners may set `published` and `hidden`. The `pending` and `removed` statuses stay reserved for
moderation, and the `WITH CHECK` clause on the update policy is what makes that reservation real.

## Data model

`profiles` · `profile_interests` · `interests` · `categories` · `places` · `place_tags` · `place_photos` · `place_ratings` · `saved_places` · `events` · `event_tags` · `event_attendees` · `follows` · `reports`

Plus two views for the report read paths: `reports_i_filed` and `reports_about_my_stuff`.

Integrity is enforced in the database, not just the UI:

- one rating per user per place (`unique (place_id, user_id)`), aggregate maintained by trigger
- at most six photos per place, enforced by trigger
- one join per user per event (primary key), capacity and "not ended" enforced by a trigger that row-locks the event
- no self-follows, no duplicate follows or saves, one open report per reporter per target
- check constraints on coordinates, scores, lengths, statuses
- `status` + `visibility` columns exist on places/events so moderation and trust tiers can be added later without a migration

## Security notes

- The browser only ever sees the anon key. Every read and write in Supabase mode goes through a request-scoped server client under RLS. Users can only insert rows as themselves and update/delete rows they own.
- Clients cannot write `rating_avg`, `rating_count`, or `creator_id`. Owners can set only the documented listing states and visibility tiers; RLS and database checks enforce those limits.
- Server actions re-validate all input with Zod and re-check the session; nothing trusts client-side state.
- Redirect targets after auth are restricted to same-origin paths. Demo uploads are served from a strict filename allow-list.
- Security headers (`nosniff`, `X-Frame-Options`, referrer policy, permissions policy) are set in `next.config.ts`.

## Decisions worth knowing

- **Demo mode is a first-class repository, not a mock.** It mirrors the Postgres tables and rules (including capacity, duplicate-join, and rating aggregation), so the UI you develop against behaves like production.
- **Filtering is client-side over a bounded server fetch** (500 places / 200 events). Chips and search feel instant; a bounding-box query is the obvious next step at scale.
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
- **Images:** photos upload to Supabase Storage (public buckets, per-user folders) or to `.data/uploads` in demo mode. Places without photos get a generated category cover so nothing looks empty.

## Intentionally deferred

Direct messaging, push notifications, recommendation algorithms, payments, moderation dashboard, advanced reputation scoring, native apps, analytics, and production deployment. The schema and repository contract are shaped so these can be added without rewrites.
