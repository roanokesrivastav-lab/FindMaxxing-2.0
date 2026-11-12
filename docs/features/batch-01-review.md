# Batch 01 review bundle — onboarding and first useful map

Run 2026-11-11 from [the batch prompt](../briefs/fable-5.2/01-onboarding.md). Tickets **1.2** and
**1.3**, both **IMPLEMENTED-LOCAL**. Neither is independently verified. Work stopped here for review,
as instructed; batch 02 has not been started.

Branch `codex/founder-implementation-handoff-2026-11-11`. Nothing has been pushed, merged or deployed.

## Commits

| Commit | Ticket | What |
| --- | --- | --- |
| `78b0b34` | 1.2 | Six-row picker, More interests, Skip, Continue to home city; one interest limit end to end |
| `29cc1ce` | 1.3 | First-arrival strip on the map; removable interests, Show everything, one widening; three fixes the checks exposed |
| `2578fdc`, and the commit adding this file | ledger | Progress and evidence only |

Batch 00 commits (`c06f1ad`, `9c515b9`, `99f8023`, `fbd995b`, `e726e8d`) are in
[00-baseline.md](00-baseline.md).

Source files changed since `4eea5e5` (17 files, +1,557 / −55): `packages/shared/src/taxonomy.ts`,
`packages/shared/src/validation.ts`, `src/app/(explore)/page.tsx`,
`src/components/explore/{ExploreClient.tsx,FirstArrival.tsx,arrivalNotice.ts}`,
`src/components/map/MapCanvas.tsx`, `src/components/onboarding/{WelcomeFlow.tsx,InterestThumb.tsx}`,
`src/lib/map/useGeolocation.ts`, `src/lib/onboarding/interests.ts`, `tests/onboarding.test.ts`,
`tests/first-arrival.test.ts`, `scripts/e2e-onboarding.mjs`, `scripts/e2e.mjs`, `package.json`
(one script), `.github/workflows/ci.yml` (one step). No migration, no dependency, no flag.

## Acceptance criteria to evidence

| # | Criterion | Evidence | Result |
| --- | --- | --- | --- |
| 1 | Six recognizable thumbnail rows with fallback glyphs, selected checkmarks, More interests, visible Skip and Continue to home city; zero selections allowed | `tests/onboarding.test.ts` (rendered step, thumbnail); `e2e:onboarding` steps 1–2; screenshots 01, 03, 05 | **Pass**, with every row on the glyph fallback: no permissioned photos exist yet |
| 2 | Every accepted interest honoured by first-map filtering, or the limit explicit; 12/8 mismatch fixed end to end | `tests/onboarding.test.ts` "twelve interests…" (real actions, real Explore page, a seeded place only the ninth interest matches), SQL parity in PGlite, mutation check; `e2e:onboarding` maximum-choices step; screenshot 04 | **Pass** |
| 3 | First arrival shows removable interests and Show everything; no-results and denied-location states offer one explicit widening, never silently relax | `tests/first-arrival.test.ts`; `e2e:onboarding` steps 3, 6, 7, 8, 9; screenshots 04, 07–13 | **Pass** in Chrome |
| 4 | People step unchanged, no social context line; camera/selection restoration stays Later | Diff review: People markup untouched; nothing stores camera, selection, filter or scroll state | **Pass** |

Required tests named by the batch:

| Required | Where | Result |
| --- | --- | --- |
| Zero and maximum choices | `e2e:onboarding` steps 2 and 3; `tests/onboarding.test.ts` | Pass |
| Skip | `e2e:onboarding` step 4; unit test | Pass |
| Returning-user behaviour | `e2e:onboarding` steps 2 and 5; `e2e` step "onboarding never shows again…"; unit tests | Pass |
| Keyboard | `e2e:onboarding` step 5 (rows, disclosure, Continue, focus ring, focus to next heading) and step 3 (remove a filter with Enter) | Pass |
| Denied location | `e2e:onboarding` step 8 | Pass |
| No nearby matches, through real save and Explore paths | `tests/first-arrival.test.ts` last block; `e2e:onboarding` steps 6 and 7 | Pass |
| Golden-journey first-save segment extended | `scripts/e2e.mjs`: first map strip → its filtered list → a place → new list; screenshots 14–16 | Pass (21/21) |
| Mobile width and large-text visual check | 390×844 throughout; 200% text on the picker and the strip; screenshots 06, 12 | Pass |
| Relevant accessibility check | axe with target-size on three picker states and three first-map states in `e2e:onboarding`; `npm run a11y` | Pass |

## Checks on the final code

All local, 2026-11-11, on `29cc1ce` (the later commits change documents only).

| Command | Result |
| --- | --- |
| `TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres npm run check` | **exit 0.** Typecheck, lint, **72 files / 1,214 tests passed, 0 skipped**, build compiled |
| `npm run typecheck --workspace @findmaxxing/mobile` | exit 0 |
| Demo-mode build, then `npm run e2e` | **21/21 passed** |
| `npm run a11y` | **24 pages × 2 widths: 0 serious/critical, 0 other** |
| `npm run e2e:onboarding` | **10/10 passed** |

Baseline before any change, for comparison: 70 files / 1,172 tests, e2e 19/19, a11y clean.
Not run: `npm run e2e:features` (payments, ads, messaging; untouched), anything hosted, any device.

## Screenshots

Chrome, production demo-mode build of `29cc1ce`, fresh in-memory demo store, pilot flags on through
the demo server, 390×844 unless noted. Files in [evidence/batch-01](evidence/batch-01/).

| File | State |
| --- | --- |
| `01-picker-default.png` | Interests step, nothing picked |
| `03-picker-at-limit.png` | Twelve picked, limit stated, the rest unavailable |
| `05-picker-more-open.png` | More interests open, keyboard focus ring visible |
| `06-picker-large-text.png` | Picker at 200% text (full page) |
| `02-map-zero-interests.png` | First map after picking nothing |
| `04-map-twelve-interests.png` | First map with twelve interests (map tiles still loading in the capture) |
| `07-map-no-matches.png`, `08-map-no-matches-wider.png` | No matches, then after "Search a wider area" |
| `09-list-no-matches.png` | The same strip in list mode |
| `10-map-one-empty-interest.png` | One interest with results, one without |
| `11-map-location-denied.png`, `12-…-large-text.png` | Location refused; the same at 200% text |
| `13-map-desktop.png` | 1280×900 (the results drawer beside the map is existing behaviour, batch 05) |
| `14`–`16-journey-*.png` | Golden journey: first map, place, first save |

## Adversarial findings and fixes

Found by the tests and browser runs in this batch, all fixed before the commits:

1. **Silent truncation, three places** cut twelve chosen interests to eight. One shared limit now.
2. **Silent refusal.** The thirteenth tap was ignored without a word. The limit is now stated up front
   and at the limit, and unavailable options are marked.
3. **A fourth silent truncation** would have appeared in the Explore filter sheet once the query
   capped at twelve. The sheet now stops at twelve and says so.
4. **The welcome message was invisible on a phone in map mode** (it lived inside the list panel).
5. **"Search a wider area" did nothing with reduced motion on.** The map never reported its new area
   after an instant jump, an existing defect in `MapCanvas` that also affected every other programmatic
   map move for those users.
6. **The widening could be tapped before the map loaded** and did nothing. The notice now waits.
7. **A premature "still nothing"** could show between the tap and the map reporting the wider area.
8. **Two accessible-name mismatches** on the signed-in map (Filters button with a count, profile link),
   which the existing a11y suite never visits signed in.
9. **Overflow at 200% text**: the onboarding step buttons (41px) and the map search row (4–11px).
10. **A test that could not fail**: the first overflow check compared against a width that grows with
    the overflow. Rewritten against the configured viewport.

Checked and left alone, recorded for their owners: the trip planner still cuts interests to eight
(`TripPlanner.tsx`, `/api/trip-plan`); the desktop results drawer sits beside the map (batch 05).

## Limits: what this does not prove

- **No phone, no Safari, no screen reader.** Chrome on a Mac at phone size is not iOS or Android.
- **No hosted Supabase.** SQL discovery ran in PGlite; nothing was applied or read on staging.
- **No real thumbnails.** The team has to supply six permissioned photos for the rows.
- **Per-interest "nothing here" stays silent** when an area has more results than one page.
- The founder checkpoint for this batch (five newcomers: first wrong tap, expected versus actual,
  time to a useful save) needs real people and has not happened.

## Independent review readiness

- **1.2 and 1.3: ready for Codex verification.** No preflight was required for either.
- **Still blocked on Codex preflight** (flagged separately, nothing built on them): 4.0 Amendment A1
  and 5.0 Amendment A1. Later contracts that will need one: 2.7, R4, 0.1b.
- **Owner actions:** push `codex/founder-implementation-handoff-2026-11-11` and
  `codex/deferred-waitlist-snapshot-2026-11-11` (neither is on origin); confirm whether migration 0052
  was ever applied to a hosted database; supply the six interest photos.

## Next ready work (not started)

Batch 02's tickets that do not depend on the 4.0 preflight: **4.1** editorial event detail and **1.5**
quiet Events tab (its "followed usual sessions" part needs 4.5a). 4.5a, 4.5b, 4.6 and 4.8's schema wait
for the preflight. Batch 04 (6.1, 6.2 routing foundation) is independent and can move earlier.
