# Stage B integration report (2026-11-05)

Integration branch: `claude/gifted-ramanujan-cen2b2` (the session's assigned branch), cut from
`tier1-owner-controls` @ `9e61cd9`. Not merged to main, not deployed, no PR opened.
Four lanes ran in parallel, each as its own subagent in its own git worktree and lane branch
(`lane/b1-events`, `lane/b2-places`, `lane/b3-onboarding`, `lane/b4-itinerary`). Lane branches were local
only. Every finished ticket was merged here, checked, and pushed. All four lane branches are fully merged.

## Verification

- Setup: local PostgreSQL 16, `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`, shared
  by all lanes (the harness creates a throwaway database per suite). `tests/abuse-limits-pg.test.ts` on the
  base: 6/6 passed, none skipped.
- Base `npm run check`: exit 0, 68 files / 1,100 tests.
- Final `npm run check` with `TEST_DATABASE_URL` set (commit `e2069c4`): exit 0. Typecheck, lint, **95 files /
  1,431 tests passed, none skipped**, build OK.
- `npm run e2e` 19/19 and `npm run e2e:features` 11/11 on the final head. The paid ticket checkout, cancel,
  admit and refund flows are included.
- Integration incidents:
  - One merge conflict (`src/lib/data/supabase/repository.ts`: B2 exported `PLACE_SELECT`, B4.3 added
    `EVENT_SELECT`). Both were kept.
  - One check run was killed by memory pressure (vitest workers SIGKILLed while four lanes were testing). It was
    re-run with `VITEST_MAX_WORKERS=2` and passed.
  - One run hit a pre-existing clock flake in `tests/auth-limits.test.ts`, which then passed on re-run. Its
    15-minute window is wall-clock aligned, so near the boundary the copy says "in a minute" and the regex
    expects "N minutes". It was not fixed here.
  - Nothing was reverted.

## Race tests (real PostgreSQL, two connections, `tests/helpers/postgres.ts`)

- `event-waitlist-pg` (the 4.4 hard gate) **passed**. The case numbers follow the 4.0 test plan:
  1. last seat;
  2. direct insert racing `accept_offer`;
  3. expiry racing accept;
  4. double accept;
  5. leave racing a new join;
  6. capacity lowered racing a join;
  7. paid `reserve_ticket` race, unchanged;
  9. cancel racing joins;
  10. duplicate notification delivery;
  11. 1,000 alternating join/leave calls.
- `event-series-pg` case 8 (concurrent series generation, 0 duplicates) passed.
- `abuse-limits-pg`: 6/6 passed.

## Tickets

| Lane | Ticket | Status | Lane commit |
| --- | --- | --- | --- |
| B1 | 1.5 Quiet-utility Events tab (+ e2e fix) | merged | f512026, 8cd9cf7 |
| B1 | 4.1 Event page hierarchy | merged | e95975f |
| B1 | 4.2 Structured activity details | merged | 4cf24cf |
| B1 | 4.3 Minimum attendance and readiness | merged | 7316973 |
| B1 | 4.8 Party poster card | merged | 29c0d3a |
| B1 | 4.4 Waitlist and offers (hard gate passed) | merged | 47820ed |
| B1 | 4.5a Series model and host tools | merged | 5bea3a0 |
| B1 | 4.5b Series page | merged | ec3f19d |
| B1 | R3 Lightweight clubs (spec in R3.md) | merged | d99abcd |
| B1 | 4.6 Material-change notifications | merged | 13631cb |
| B1 | R2 Need-players alerts (spec in R2.md) | merged | 9574a7d |
| B2 | 2.5 Place page, photo first | merged | 612ee7e |
| B2 | 2.6 Tip provenance and freshness | merged | 3ffb758 |
| B2 | 2.7 Best for / less suited | merged | db0a0f9 |
| B2 | 3.1 Richer saves | merged | 1f81b3b |
| B2 | 3.2 Library tools | merged | f742e1a |
| B2 | 3.6 Pick from my saves (R1) | merged | 1448a86 |
| B2 | 2.8 Public and personal photos | merged | 84d170a |
| B3 | 1.2 Interest picker | merged | ed03361 |
| B3 | 1.3 First-map arrival | merged | 6af9f6d |
| B3 | 2.1 Map clustering | merged | e91f75d |
| B3 | 2.2 Selection and state | merged | 64d2f66 |
| B3 | 2.4a Intent filter tabs | merged | a60a684 |
| B4 | 6.2 Feasibility validator | merged | 81bb06a |
| B4 | 6.1 Routing adapter | merged | 00d3f43 |

Nothing is NOT VERIFIED, blocked or not started. Out-of-scope tickets were not touched.

## Migrations and dependencies

- Events: 0050 event_newcomer, 0051 event_activity_details, 0052 event_readiness, 0053 event_card_style, 0054
  event_waitlist_offers, 0055 event_series, 0056 clubs, 0057 material_change_notifications, 0058
  need_player_alerts.
- Places: 0060 place_tips, 0061 place_occasions, 0062 save_details, 0063 personal_photos (new private bucket
  `personal-photos`).
- Map block 0070–0074: unused.
- Dependencies added: none. `.env.example` gained three empty, commented routing variables (not live).

## Flags and demo mode

Demo configuration already turns on every pilot flag (`.env.development`, `scripts/lib/demo-server.mjs`). Elsewhere,
set `NEXT_PUBLIC_FEATURES=pilotFoundation,pilotExplore,pilotLibrary,pilotEvents` (or `pilot`). In demo mode
(`npm run dev`, no Supabase keys):

- `pilotFoundation`:
  - the welcome flow (new interest picker, then first-map arrival filters);
  - `/events` (Quiet-utility rows).
- `pilotEvents`:
  - `/events/<id>` (editorial page, Readiness row, waitlist/offer states);
  - the Party poster toggle in the event form;
  - `/series/<id>` (from the seed series);
  - `/clubs/<id>`;
  - `/events/alerts`.
- `pilotExplore`:
  - `/explore` (clusters, "1 of N" stacks, URL state, When / 15 min / Activity tabs);
  - `/places/<id>` (photo first, tips, occasions, personal photo on first rating).
- `pilotLibrary`: `/saved` (details, search and filters, bulk edit with undo, export, "Pick somewhere").
- `pilotItinerary`: nothing user-facing yet (6.1/6.2 are engine only; 6.3 is the first caller).

The only flag-off change: a paid event no longer says "Free to join" (4.1 copy fix).

## Recommended options relied on

- 4.0 D-A to D-M, including D-I: phase 1 and phase 2 of closing direct `event_attendees` writes ship
  together, because no native build has shipped. `apps/mobile/lib/api.ts` join/leave now call the RPCs.
- 6.0 R-1, R-2, R-4 and R-5. R-3 (the route-validation limit) is deferred to 6.3 because it needs a migration;
  R-6 belongs to 6.3.
- Per-ticket choices are recorded in each `docs/features/<ticket>.md`:
  - 1.5: "usually go to" = same category plus the same venue or host within 120 days, plus series you follow;
  - 4.8: a typographic poster;
  - 1.2: a shared cap of 8 interests;
  - 2.4a: the time windows, and straight-line "15 min" at 80 m/min;
  - 3.1: tag suggestions come from your own tags, then the place's interest tags;
  - 3.6: a uniform random pick;
  - 2.8: the name "personal photo", and the first-photo rule enforced in the app action, not the database;
  - "friends" = people you follow;
  - R2 and R3 options are in their spec docs.

## Only the owner, staging, devices or keys can confirm

- The look and feel in demo mode. The 4.8 poster was never mocked up for approval.
- The Beli check.
- Hosted Supabase:
  - PostgREST embeds and RPCs (covered only by PGlite/local PostgreSQL and typecheck);
  - storage policies and signed URLs for `personal-photos` (another user's token must not GET or sign
    `personal-photos/<owner>/…`).
- Mapbox walking with a real key, and the Mapbox storage clause (6.0 §11).
- Real push to a phone.
- The native waitlist and series UI (8.1b). Native first ratings are not photo-gated.
- Screen readers. Safari/iOS Back and scroll behaviour. Map tiles (not loadable in the sandbox).
- `supabase/seed.sql` was not regenerated: it was already behind the generator before this stage. Run
  `npm run seed:sql` and review the diff.

## Known issues seen, not fixed (outside this stage's tickets)

- The bottom nav overflows by 18 px at 200% text on every page.
- The event create form overflows by 25 px at 200% text (pre-existing date row).
- `KindBadge` contrast in `PreviewCard`; the accessible names of the Filters button and the avatar link.
- The `auth-limits` clock flake above.
- No moderator or admin UI for tips, occasion notes, public photos, series or clubs (database or repository only).

## Suggested updates to the protected docs (not edited here)

- roadmap-80.md:
  - §6 migration ledger: 0050–0058 and 0060–0063 are used;
  - 4.4: phase 2 is done, with `api.ts`;
  - the chosen rules for 1.5, 4.8, 3.1 and 3.6;
  - 1.2: cap of 8;
  - 2.4a: limits on When and "15 min";
  - 2.2: the drawer is gone only with the flag on;
  - 6.3 takes on R-3 and the `drivingMinutes` removal.
- founder-decisions.md:
  - "personal photo" naming, and the app-level first-photo rule;
  - friends = follows;
  - the R2 and R3 options.
- beta-build-rules.md: use lazily created optional demo-store collections instead of `STATE_VERSION` bumps, so
  lanes don't collide.
