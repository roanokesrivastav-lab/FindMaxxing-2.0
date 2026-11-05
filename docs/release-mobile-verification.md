# Release and mobile verification — batch 5, 2026-10-14

**Decision: local verification/preparation complete; batch 5 exit criteria NOT
met. Web/native release approval is withheld.** Hosted service checks and native
execution evidence must not be replaced with stub, demo, or bundle results.

## Authenticated staging follow-up — 2026-10-19

Owner authorized synthetic fixtures on `ebwgdjocwusxdamojarj` and separately
approved the exact branch-preview auth callback allowlist addition. Added only:
`https://find-maxxing-2-0-git-tier-12a7df-roanokesrivastav-labs-projects.vercel.app/auth/callback**`.
The dashboard confirmed six entries afterward; the previous five, Site URL,
email-confirmation policy and Vercel deployment protection were left unchanged.
This verifies configuration, not delivery/exchange of a confirmation email.

Created three disposable admin-confirmed accounts (owner, member, moderator), two
synthetic places (public/locals), one actual Storage image and one future event.
The credentials were held only in the ignored task-local manifest, never printed.
No existing account was used for writes. Native/iPhone execution was not involved.

### Checks observed in the protected, signed-in browser

- Member sign-in and four-step onboarding passed: interest selection, home city,
  location opt-out, following only the fixture owner, then the interest-filtered
  map. Both places were visible to the aged local member; the anonymous map after
  sign-out showed only the public place.
- Public place details loaded. The actual image element was decoded successfully
  (`complete: true`, nonzero natural width), not merely present as an image tag.
- Save sheet accepted a new list and confirmed the fixture place was added.
  Later profile navigation still reported the saved place and following count.
- Event join persisted the second attendee and reduced free capacity from nine
  to eight; leave restored one attendee/nine free slots. On resumption the event
  still showed one attendee, confirming the leave persisted.
- Member sign-out and owner sign-in passed, including after the interrupted
  upload tool call and reopening the browser.
- Owner deletion through the **deployed application** rejected a wrong password.
  An independent API check confirmed no deletion job existed afterward and the
  stored image remained. Correct-password deletion redirected to `/?deleted=1`.
  Independent service checks then verified all eight assertions: Auth absent,
  actual Storage listing empty, both places gone, future event gone, journal
  completed, journal paths scrubbed, billing ID absent, and old login denied.
  This exercises the deployed server-only service key and real Auth/Storage
  lifecycle, but not billing cancellation/refunds or injected failure recovery.

### Incomplete checks and new release issue

- Photo **upload through the UI is NOT verified**. The first Add Photos action
  opened a dialog rather than a chooser. The subsequent documented chooser flow
  was interrupted/stalled. On resumption actual Storage and photo-row inventory
  showed only the original fixture image: no member upload had reached Supabase.
  This is a tooling interruption, not a confirmed application upload defect.
- The browser captured React production error **418 (text hydration mismatch)**
  during fixture-event browsing. The page recovered and the actions above passed,
  but the no-page-errors release criterion does not pass. Likely cause: shared
  `src/lib/utils/format.ts` and `EventCard` format dates/times using the runtime's
  local timezone, including client components rendered on the server. Running
  the actual `formatEventWhen` helper on `2026-10-22T23:24:00Z` independently
  reproduced `Thu, Oct 22 · 11:24 PM` under `TZ=UTC` versus
  `Thu, Oct 22 · 4:24 PM` under `TZ=America/Los_Angeles`. This establishes the
  unstable render input; the minified stack alone does not prove it is the only
  source of error 418. Prioritize a targeted SSR/client-timezone repair with
  cross-timezone and midnight/DST tests; do not suppress the warning as a fix.
- These were interactive hosted checks, **not** a passing full scripted e2e
  run. Email delivery/recovery/PKCE, photo submission, moderator UI, health JSON
  behind preview protection, Stripe transactions, concurrency/failure injection
  and native device/push checks remain pending. No new automation-bypass token
  was created; no protection, confirmation requirement or feature flag disabled.

### Cleanup independently verified

The application deleted the fixture owner and its photo/content. The task-local
cleanup runner removed the remaining moderator/member accounts using the
ownership-marked manifest, Storage-before-Auth ordering and deletion RPC leases.
All fixture passwords were removed from the manifest after account invalidation.
Final SQL counts: **1 original Auth account, 0 Storage objects, 0 places,
0 events, 0 moderators, 0 saved lists, 0 fixture Auth accounts**. Normal scrubbed
deletion tombstones remain intentionally; no user-level historical records were
purged. Only temporary test accounts/content were deleted; they are not
recoverable through normal Auth/Storage operations and can be regenerated.

No application source code, deployed revision, Production settings or billing
configuration changed in this follow-up. **Release approval remains withheld.**

## Preview deployment follow-up — 2026-10-19

The owner upgraded Vercel to Pro and explicitly authorized copying the existing
test-project connection values into this project's **Preview environment only**.
Saved `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
`NEXT_PUBLIC_SITE_URL` as intentionally public Config values, and
`SUPABASE_SERVICE_ROLE_KEY` as a non-revealable Secret. The source URL was checked
against `ebwgdjocwusxdamojarj.supabase.co` before transfer. No key was printed in
chat; Production settings, `main`, feature flags, Stripe and cron credentials
were not changed.

- Set the site origin to the branch alias shown by Vercel:
  `https://find-maxxing-2-0-git-tier-12a7df-roanokesrivastav-labs-projects.vercel.app`.
- Redeployed audited commit `e9497e2` on `tier1-owner-controls` to Preview.
  Deployment `2e6DRJP6oKr2X9Q9cGRGmjPYppg8` reached **Ready**. The default
  `npm run build` / Next.js Turbopack build, including TypeScript checks,
  completed successfully on Vercel; this is new hosted build evidence, not a
  claim that the earlier local port-binding limitation has disappeared.
- Opened the immutable deployment URL in the signed-in browser:
  `https://find-maxxing-2-0-ecooxnymb-roanokesrivastav-labs-projects.vercel.app`.
  Explore rendered its map, taxonomy filters and expected empty-state UI;
  the sign-in form rendered. The browser error log was empty for these checks.
- Read-only SQL confirmed migration `0029` and no places, events or moderators.
  The full browser suite requires disposable fixtures and an email-confirmation
  path; no fixture records or application accounts were created in this follow-up.
- Unauthenticated HTTP requests to both preview health URLs returned **302 to
  Vercel SSO**, not application health JSON. Direct browser navigation to the
  JSON endpoint was blocked by the browser client. **Application health status
  is therefore not verified**, despite successful deployment/page smoke checks.
  Deployment protection remains enabled; unattended tests require an explicitly
  authorized protected-access method, not disabling protection implicitly.

Configuration and deployment screenshots were saved locally with values masked.
No Supabase Auth redirect allowlist changes were made. Confirmation/recovery
email redirects, authenticated user flows, automated browser e2e, administrative
server-key behavior, Stripe and native execution remain pending; **this is not
release approval**. Earlier deployment/NOT RUN sections below are historical;
this section supersedes only the deployment/configuration and smoke results.

## Hosted follow-up — 2026-10-15

The owner identified `ebwgdjocwusxdamojarj` as a disposable test project with
no real users or valuable data and explicitly authorized migrations and temporary
test users/uploads/records. This follow-up supersedes the earlier NOT RUN entries
only for the checks recorded here; overall release approval remains withheld.

- Confirmed both the logged-in dashboard and linked CLI target matched that
  project. The existing local Supabase URL also matched; no credentials were
  printed or transferred to Vercel.
- The migration preview contained exactly `0026_security_boundaries.sql`,
  `0027_account_deletion_lifecycle.sql`, `0028_payment_event_processing.sql`,
  and `0029_push_transport_readiness.sql`. Applied all four through the CLI,
  without database reset, seed import, role import, or vault changes. A second
  dry run reported the remote database up to date. Dashboard and SQL history
  independently confirmed versions through `0029`.
- Verified RLS is enabled on `account_deletion_jobs` and
  `stripe_processing_locks`; anonymous/authenticated roles cannot select them.
  Verified all seven new deletion/event/push control RPCs are executable by
  `service_role`, not anonymous/authenticated roles.
- Re-ran the focused local database and staging-preflight suites: **4 files,
  31 tests passed**.
- Ran the existing hosted checker in backend-only mode: **all 26 Auth/Storage/RLS
  assertions passed**, including locals visibility, cross-user writes/lists,
  private-photo access, moderator boundaries and rate limits. Scratch Storage
  removal and **4/4** test-user deletions passed. Final SQL counts matched the
  baseline: **1 existing Auth account, 0 Storage objects**, with no checker users
  or scratch objects remaining. Normal application deletion/audit bookkeeping is
  not asserted to have been purged.
- Image migration dry run passed: no images required migration and none failed.
  The backend-only checker deliberately reported **29/31** and exited **1**:
  its own migration step was skipped because migrations were applied/verified
  separately, and browser e2e was intentionally deferred. This is not a passing
  full staging gate. Its unused database URL contained no password; API keys were
  supplied only in the child process environment from existing local config.

### Deployment mismatch blocks hosted browser verification

The owner deployed `https://find-maxxing-2-0.vercel.app`. Vercel's dashboard
identifies its source as `main` at `c8514fb`, while the audited checkout is
`tier1-owner-controls` at `e9497e2`. Read-only GitHub branch inspection confirmed
`main` is still `c8514fb`; remote `tier1-owner-controls` is `2082afb` and lacks
the three latest local commits. No code was pushed or deployment changed here.

The deployed page displayed "Something broke" and `/api/health` returned HTTP
404. These observations do not identify the cause of the page error, but the
revision mismatch alone means it cannot verify the audited repairs. Deploy the
reviewed revision to the test environment, confirm its backend and auth redirect
configuration, then execute browser e2e. Stripe sandbox transactions, real native
execution/push, and multi-connection race scenarios still remain unverified.

## Preflight contract

Approved with required changes for the safe local portion. No separate Claude
brief was supplied; the independent audit's batch 5 contract is the scope.

- Objective: independently re-review batches 3/4, test the integrated release,
  strengthen the staging gate, and explicitly scope remaining native gaps.
- Allowed scope: confirmed payment review defects; release scripts, their tests,
  CI verification wiring, and documentation; inspect the mobile/shared workspace.
- Acceptance: maintain permission/financial boundaries, record actual outcomes,
  preserve tests and prior work, distinguish bundle/native evidence, refuse
  unknown hosted targets, and leave all unperformed checks visibly incomplete.
- Required checks: full tests, type-check/lint/default and alternate build,
  feature-enabled browser flows, accessibility, mobile type-check and exports,
  toolchain inventory, hosted gate only on an authorized disposable project.
- Must not change: product rules, trust tiers, dependencies, native feature scope,
  existing applied migrations, deployment/store metadata, production configuration,
  real payments/data, or unrelated user changes.

## Independent review of batches 3 and 4

Inspected the handlers, Stripe adapters, authoritative reconciliation, event
leases/atomic completion, real migrated role tests, push readiness/claim markers,
quiet-hours/cap behavior, surrounding code and prior diffs—not just summaries.

Two batch 3 defects were reproduced with the real handler and fake Stripe before
fixing them; all three initial reproductions failed with the expected incorrect
behavior:

| Finding | Severity and reproduction | Root cause and repair |
| --- | --- | --- |
| Stale closed-account metadata can cancel another currently attributed subscription | P1: delete account A, deliver its old subscription/checkout event, but have Stripe retrieval identify B as current owner. The old handler sent cancellation. | Closing-account handling trusted the old event's user before cancellation. It now verifies current remote ownership, acknowledges unrelated work without cancellation, and retains legitimate closure behavior. |
| Malformed metadata produces persistent UUID RPC errors | P2: deliver a subscription event with a non-UUID external user identifier. The UUID-typed claim RPC fails instead of safely acknowledging unrelated metadata. | External metadata was passed directly into account/RPC boundaries. One parser now validates and canonicalizes UUIDs across claims, current ownership and reconciliation; malformed identifiers grant no access and trigger no cancellation. |

Four new regression cases cover both stale-event types, malformed metadata, and
uppercase UUID consistency. The focused combined payment/deletion/push review
passed 69 tests. No new confirmed batch 4 defect was found; readiness tests still
cover partial/mixed delivery, cap-once accounting, quiet hours and caller grants.
Configured-transport send loss/Expo receipt tracking remain the documented,
unchanged at-most-once reliability limitation—not a newly repaired behavior.

## Staging and release gate changes

- `scripts/staging-check.ts` now requires `STAGING_PROJECT_REF` and
  `--allow-staging-writes` before constructing clients or running migrations.
  API/direct-database/pooler identities must match the selected project.
  This is a guard, not proof that a project is disposable; the owner must select
  and authorize it. Unknown targets were not inspected or mutated.
- Skipped migrations/e2e produce an incomplete/failed gate, never full approval.
  Migration failure stops before check-user creation. Connection-bearing command
  output/exceptions are not echoed by the migration step.
- Negative visibility checks no longer interpret arbitrary query errors as
  successful privacy enforcement. Scratch Storage paths are recorded before
  upload attempts, restricted to invocation-owned user prefixes, removed before
  Auth deletion, and retained for operator recovery on cleanup failure. Returned
  Auth errors are counted; the checker cannot claim all users were removed when
  it only swallowed failures. Failure paths have injected-API tests.
- The core browser suite actually creates/mutates/deletes records externally;
  only demo password-reset is skipped. External runs now require
  `E2E_ALLOW_STAGING_WRITES=1` and exact `E2E_STAGING_BASE_URL=E2E_BASE_URL`
  acknowledgment before any browser/server activity. The staging wrapper passes
  these only after its own preflight. A disposable moderator fixture can be set
  with `E2E_MOD_EMAIL` / `E2E_MOD_PASSWORD`; do not use production fixtures.
- Added `npm run e2e:features`: a fresh local demo server, scratch uploads and
  real-service credentials explicitly disabled. It covers Plus activation/cancel,
  messaging, notification preferences, ticket cancel/payment/refund, advertiser
  review/payment/pause/resume, and non-admin denial. No real money moves.
- CI now includes the mobile web export and a separately built feature-enabled
  demo smoke suite. CI wiring was reviewed; the remote CI job was not dispatched
  or observed in this local task.

## Verification evidence

| Check | Result |
| --- | --- |
| Full tests | Passed: 45 files, 831 tests; earlier intermediate runs passed 825 and 829 |
| Web type-check / lint / diff check | Passed |
| Default production build | Retried with escalation: fails on Turbopack CSS processing, `binding to a port: EPERM` |
| Webpack production build | Passed with isolated demo data and audited features enabled; no Supabase/billing/push credentials |
| Feature-enabled browser suite | Passed: 11/11; screenshots `.data/e2e-features/` |
| Core browser suite | Final 19/19; initial 18/19 exposed a streamed-page timing check. It now waits for the unchanged resolution text before asserting. External-target guards also pass their tests. |
| Accessibility | Passed: 15 pages, zero issues, keyboard focus check passed |
| Mobile type-check | Passed |
| Expo iOS/Android/web export | Passed, SDK 57: generated Hermes bundles and web assets in `/private/tmp/findmaxxing-native-verification-fstpnh` |
| Native execution | NOT RUN: Xcode 26.6 exists; escalated `simctl list devices available` and `list runtimes` are empty; Android emulator/adb unavailable in PATH |
| Real multi-connection Postgres | NOT RUN: no configured disposable database or runnable local Postgres/container tools identified |
| Hosted staging gate | NOT RUN: explicit empty-env invocation exited 2 listing missing staging variables before external work |
| Unapproved external e2e | Correctly refused: synthetic external target exited 2 before browser/network activity |
| Real Stripe/Storage/push delivery | NOT RUN; no authorized disposable service targets/device were supplied |

Exports used empty public Supabase variables. Source inspection found only public
Supabase URL/anon-key reads in the native client, not server-role/Stripe/VAPID
secret reads. This is source/configuration evidence, not approval of an unknown
deployed binary. Hermes bundles are not signed apps, native compilation, simulator
execution, or physical-device notification evidence. The Expo skill guided this
separation and credential/failure-path review; no native dependency or UI rewrite
was performed.

## Remaining mobile migration scope

These are source-confirmed implementation gaps or explicitly unverified risks,
not claims of device exploits or production incidents. Product scope must say
which capabilities are required for the native release versus deferred to web.

| Gap/risk | Evidence and next scoped contract |
| --- | --- |
| Photo display parity — confirmed gap | `apps/mobile/lib/api.ts:27` sets `photos: []`; `app/place/[id].tsx` has no gallery. Specify authenticated private-photo delivery and gallery/loading/error behavior, then test visibility across public/local/moderated places. |
| Upload privacy/size parity — confirmed missing pipeline | `lib/api.ts:100` sends raw fetched JPEG bytes directly to Storage. Metadata stripping, normalization, variants and upload bounds need a reviewed server-enforced/native-compatible pipeline; test GPS/EXIF fixtures and oversized uploads before native photo release. |
| Event creation atomicity — confirmed multi-request path | `lib/api.ts:119` inserts event, tags, then attendance separately; the web Supabase adapter has the same pattern. Specify a shared transactional operation and failure/retry tests rather than independently patching only one client. |
| Session hydration/account switch — source risk, device behavior unverified | Session loading only delays redirects; `Gate` still renders its Stack. `getSession()` can update after auth events; profile state is not explicitly cleared on user changes. Test cold boot, session-read failure, logout and account switch before approving private screens. |
| Auth persistence — confirmed choice, exposure unverified | Native Supabase Auth uses AsyncStorage, not SecureStore. Define secure persistence/refresh/background policy and migrate with compatibility tests; do not infer an exploit from the storage choice alone. |
| Push logout/revocation and project readiness — confirmed cleanup omission, delivery unverified | Sign-out does not remove the registered Expo token; registration errors are swallowed and no EAS project ID is in `app.json`. Specify revocation/account-switch ownership and visible failure handling; supply a project and real device to verify push/receipts. |
| Feature completeness — explicitly incomplete | Native Profile directs profile editing/settings/tickets/Plus to the website. Native parity is not established by successful type-check/export. Confirm the native feature checklist before treating this as a complete migration. |

These scopes were documented, not silently implemented as a larger migration.
Web-only release and native release should have separate sign-offs.

## What is required to finish batch 5

1. Supply the exact disposable Supabase project reference and staging app target,
   configured locally with credentials (not pasted into chat), and explicitly
   authorize the checker/temporary record creation. Apply migrations through
   `0029` there. The existing checker covers baseline RLS/UI, not every financial
   and native criterion; a zero exit alone is not overall release approval.
2. In Stripe test mode and real Supabase Auth/Storage, execute the lifecycle,
   ownership/pagination, timeout, delayed-settlement, replay, refund and receipt
   scenarios from the batch 2–4 reports. Real multi-connection races are required.
   Review existing stale entitlements separately; no historical backfill ran.
3. Provide a native device/simulator runtime plus configured Expo project/push
   credentials and approve the specific migration gaps above. Run iOS/Android
   auth, camera/metadata, maps/location permissions, deep links, account switch,
   upload privacy, background/foreground and notification receipt checks.
4. Observe the default build and new checks passing in CI; confirm monitoring,
   cron, backups/recovery, feature/product policies, and owner release sign-off.

No production/hosted migration, deployment, actual payment/refund, real push,
runtime download, native app install, or broad mobile feature implementation was
performed. Prior uncommitted repairs were preserved. vexp tools were unavailable;
review used direct source/diff inspection, actual local commands and isolated
failure tests. Ready for user review of the local work; **batch 5 remains pending
hosted/native evidence and scope/target choices**.

Service contracts: [Stripe verified events and current resource retrieval](https://docs.stripe.com/webhooks),
[Supabase user deletion and Storage ownership](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users),
and [Expo acceptance versus delivery receipts](https://docs.expo.dev/push-notifications/sending-notifications/).
