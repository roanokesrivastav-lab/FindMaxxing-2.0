# Security audit repair — 2026-10-28

## Current status

A1 preflight is complete. Batch 3 (F4/F11/F8) is implemented locally with new migration
`0039_security_grants_and_suspension.sql`: typecheck, lint, 1,023 tests and the Webpack production
build pass. Default Turbopack is blocked by this environment's port restriction. Batches 1, 2,
4 and 5 remain open. No migration has been deployed. The next batch is 1 (F2/F3/F7).

## Decision and handoff

**Approved with required changes**, incorporated in the contracts below. The A1 record and
contracts describe the initial baseline; subsequent implementation results appear at the end.
This is not release approval.

Baseline: `tier1-owner-controls`, `bf03994`, migrations `0001`–`0038`, initially clean checkout.
Brief: Lane A in [astra-prompts.md](astra-prompts.md), based on
[the 2026-10-27 audit](audits/2026-10-security-and-coverage.md) and
[the audit handoff](audit-handoff.md). The local `astra-audit-workflow.md` memory already
points to the current prompt file and records the Astra/Sol workflow; it needed no update.
The prompt file is already tracked here, contrary to the earlier handoff note.

Keep the queue's batch numbers, but execute **3 → 1 → 2 → 4 → 5**. Batch 3 makes
privilege tests faithful before new service-only functions are introduced. Every batch can
be released without a later batch, once its own checks pass. Shared limiter infrastructure
from batch 1 may be reused by batch 2; its database row cap must also hold for direct SQL/API writes.

Required changes to the initial plan:

1. Move batch 3 first. Review grants rather than accepting an automatically generated allowlist.
2. Batch 1 must include render-beacon accounting and per-campaign limits; a durable GET limiter
   alone does not satisfy F2. Recompute budget totals **after** obtaining the transaction lock.
3. Reserve auth attempt capacity before the provider call so simultaneous failures cannot evade
   the cap. Clarify that email-wide protection intentionally follows the same email across IPs;
   the independence test uses distinct emails and distinct IPs. Account lockout abuse remains a tradeoff.
4. Batch 4 must atomically persist cleanup work with the authorized row deletion. Simply moving
   an authenticated Storage delete after the row delete loses the ownership relationship used by RLS.
5. Batch 5 must persist a trustworthy campaign/payment-intent association and handle refund-before-
   completion ordering. Receipt polling needs retries for temporary failures, not a permanent
   “fetched” mark on the first unsuccessful HTTP request.
6. Separate worktrees prevent simultaneous file edits, but do not eliminate integration conflicts.
   Lane A and native work may both touch shared repository interfaces, demo adapters and tests.
   Serialize migration number allocation and review shared-file diffs when integrating.

## Current findings

All eleven were open at A1. “Confirmed” below means source evidence or the explicitly described
local reproduction; it does not claim hosted-provider or device verification. References are
relative to the repository at the baseline commit.

| ID / severity | Current evidence | Failure scenario and confidence |
| --- | --- | --- |
| F1 / medium | `supabase/migrations/0031_user_interactions.sql:80`, `0033_interaction_attribution.sql:32`, `0033_interaction_attribution.sql:71`; `src/lib/data/supabase/repository.ts:1401`; `src/server/recommendations/index.ts:35` | 600 batches/hour × 100 rows, with no daily row cap. Rail UUIDs are generated but not registered. An authenticated insert accepted an invented request UUID, score `999`, and propensity `0.001`. **Confirmed locally**; sustained volume not load-tested. |
| F2 / medium | `src/app/api/ads/route.ts:29`, `src/server/limiters.ts:13`, `src/server/http/clientIp.ts:11`; `supabase/migrations/0023_ads.sql:197` and `:208` | GET counts delivery; limits live per process and accept forwarded headers. Bots can consume campaign budgets without rendering. Totals are read before the advisory lock, so concurrent transactions may use stale totals. **Confirmed source structure**; concurrent overshoot requires multi-connection reproduction. |
| F3 / medium | `src/server/actions/auth.ts:23` and `:56`; `src/server/accountDeletion.ts:44` | Password sign-in and deletion reauthentication have no app-side throttle; sign-up uses process memory. **Confirmed app-side gap**. Shared provider egress-IP lockout remains **Plausible**, not observed. |
| F4 / medium | `tests/helpers/pglite.ts:12`–`:20` | Function default grants are absent. Applying all 38 migrations with explicit API-role function defaults changes EXECUTE privileges for three non-trigger SECURITY DEFINER functions in the probe below. **Confirmed local fidelity gap**; hosted role-owner defaults still require inspection. |
| F5 / low | `src/lib/data/supabase/repository.ts:804`–`:814` | Owner removal deletes another uploader's row and returns no storage path; no photo-removal queue/sweeper was found in source, scripts or migrations. The objects remain. **Confirmed by source**, Storage not exercised. |
| F6 / low | `src/lib/data/supabase/repository.ts:736`–`:741`; `supabase/migrations/0032_photo_delete_policy_column.sql:14` | Storage removal precedes the ownership-filtered row delete. Forbidden, suspended, closing-account or failed row deletion can leave a published place with missing images. **Confirmed by source**, failure injection not yet implemented. |
| F7 / low | `src/app/api/geocode/route.ts:91`–`:107`, `:27`–`:29` | Unique queries bypass the cache and reach Mapbox without auth or a limiter. Nominatim serialization is process-local. **Confirmed by source**; quota/billing impact unverified. |
| F8 / low | `src/app/api/cron/purge-analytics/route.ts:13`, `refresh-reputation/route.ts:9`, `notifications/route.ts:15`, `payments/route.ts:16` | All four compare strings directly. No test imports/calls the purge or reputation cron routes. Current checks reject unauthorized requests; the defect is coverage and comparison hygiene, not an observed auth bypass. **Confirmed by source/test inventory**. |
| F9 / low | `src/server/payments/webhook.ts:58`–`:64`, `:94`–`:110`; `src/lib/data/supabase/repository.ts:1710`; `supabase/migrations/0023_ads.sql:41` and `:163` | Full refund updates tickets only; partial refunds and disputes do not update campaigns. Campaigns store a checkout ID but no payment-intent ID. **Confirmed by source**, no Stripe calls made. |
| F10 / low | `src/server/notifications/push.ts:26`–`:34` and `:113`–`:123` | Ticket IDs are discarded and no receipt endpoint is called anywhere in source. Later delivery failures cannot remove stale devices or surface credential failures. **Confirmed code gap**, provider delivery unverified. |
| F11 / low | `supabase/migrations/0017_admin.sql:59`–`:69` | User A can call `is_suspended(B)` and read B's private moderation status. **Confirmed locally**: a separate user's suspension returned `true`. |

## Shared repair rules

Allowed scope is the assigned finding, its real entry points, database policies/functions, demo twins,
focused regression tests and this repair record. Before starting, recheck HEAD, working-tree changes
and the highest migration number. `0039` is the next free number at this baseline, not a reservation.

Do not edit existing migrations, change dependencies, push/deploy, make real Stripe/Expo calls,
change pricing/ranking policy, or redesign unrelated UI. Preserve RLS, account-closing fences,
suspension enforcement and opt-out behavior. Use provider fixtures; keep service-role secrets server-only.
No batch is accepted solely because an implementer's summary says it passed.

Each repair must run targeted tests and `npm run check` (typecheck, lint, full tests, build), then
receive a hostile diff review against every acceptance criterion. Record exact failures and unverified
requirements here. If independent agent review is used, supply only the contract and diff initially.
Stop and report after each batch, as the queue requires.

## Batch 3 — Privilege fidelity, suspension privacy and cron authorization (first)

**Objective:** repair F4, F11 and F8 before relying on database privilege tests for later work.

**Files/components:** `tests/helpers/pglite.ts`; new grant-inventory fixture/test; a new migration;
`src/server/http/` cron-auth helper; all four `src/app/api/cron/*/route.ts`; suspension callers and
`src/lib/data/demo/repository.ts` if caller semantics need mirroring. Existing admin, security,
payment, account-deletion and push cron tests must remain active.

**Acceptance:** model API-role function defaults before migrations; enumerate every non-trigger
public SECURITY DEFINER overload by full signature and effective anon/authenticated privileges.
Review each allowlisted signature and its caller checks; an added unauthorized API-callable function
must fail the inventory test. Repair grants with explicit `PUBLIC, anon, authenticated` revokes
where appropriate without breaking intended public APIs. User A's `is_suspended(B)` returns false;
self status, admin moderation flows and all internal suspension enforcement still work. A private
helper, if needed, must not expose another unrestricted RPC. All four cron routes reject missing,
wrong and unset secrets before creating service clients or doing work, and accept a correct secret.
Compare equal-length secret digests with `timingSafeEqual`.

**Required tests:** inventory plus a deliberate newly exposed function to prove the guard fails;
anon/cross-user/self/admin/service-role suspension cases; suspended upload, ticket, campaign,
message and ordinary-write regression tests; per-route 401/200 matrix with side-effect assertions,
including malformed/non-ASCII and unequal-length headers. Run `npm run check`.

**Must not change:** moderation decisions, cron scheduling, retention windows or public Plus badge behavior.
Forward-only migration; do not roll back to permissive grants. Database/hosted default-owner parity
remains a staging check. **Preflight: approved with the requirements above.**

## Batch 1 — Durable abuse limits and ad impression accounting

**Objective:** repair F2, F3 and F7 across instances and bypass paths.

**Files/components:** new limiter tables/RPC migration; `src/server/limiters.ts`, `src/lib/rateLimits.ts`,
`src/server/http/clientIp.ts`; auth/account actions, password reset and deletion reauthentication;
ads route and new beacon route; `src/components/ads/SponsoredSlot.tsx`; geocode route;
repository contracts, Supabase/demo adapters and related tests.

**Acceptance:** use one atomic database-backed budget shared across independent server clients.
All service-only limiter RPCs are denied to API roles. Missing/unavailable durable state must not
silently revert to a production memory limiter. Trust forwarding headers only under an explicit
verified deployment policy; normalize addresses and store keyed hashes with bounded retention,
not raw IPs or emails. Unknown-client behavior must be bounded and documented.

Use explicit constants and window-boundary tests. Proposed initial defaults: preserve ad request
cap of 120/hour/IP, add at most 3 billed impressions/campaign/IP/UTC day; sign-in permits at most
5 attempts/email/15 minutes and a separate 20 attempts/IP/15 minutes; geocode permits 30 lookups/IP/minute.
Preserve or tighten current sign-up/reset limits and cover deletion password checks. Reserve
capacity before attempting authentication (conservatively counting all attempts); the sixth failed
sign-in must not reach Supabase. Distinct IP/email pairs stay independent; same-email attempts share
their cap. Preserve generic reset responses. Document targeted email lockout risk and CAPTCHA/provider
settings as operational follow-up rather than claiming app throttling protects direct hosted Auth calls.

GET must record zero impressions. A short-lived signed token binds campaign, slot, expiry, nonce and
client hash to the render beacon; token consumption, per-client caps and campaign budget mutation are
atomic and replay-safe. Revalidate campaign visibility/status and totals under the lock; stale cards,
tampering, expired tokens and concurrent final-budget claims cannot charge. A beacon limits accounting
abuse but does not prove a human saw an ad. Organic ranking, CPM and Plus suppression remain unchanged.
Geocode over limit returns 429 before provider access. If Nominatim remains enabled, its provider-wide
spacing must hold across instances too, with bounded waiting rather than an unbounded process queue.

**Required tests:** two separately constructed clients sharing one DB budget; 1,000 alternating ad
requests across clients; zero impressions without beacons; replay/tamper/expiry and midnight boundaries;
actual auth/action/geocode route calls with provider spies showing zero calls on denial; missing proxy
configuration and storage outage; demo parity. Real multi-connection Postgres tests must demonstrate
no cap overshoot under contention (PGlite alone cannot prove that). Run `npm run check`.

**Must not change:** ad pricing/targeting, recovery-link semantics, account deletion ordering or unrelated
UI. If the limiter is unavailable, suppress ads/deny costly requests with a controlled response. Rollout
requires coordinated migration and application versions; preserve kill switches instead of reverting to
unbounded accounting. **Preflight: approved with the requirements above.**

## Batch 2 — Trusted interaction attribution and row caps

**Objective:** repair F1 at the database boundary, including direct PostgREST inserts.

**Files/components:** new migration; `src/server/recommendations/index.ts`, interaction server/actions;
repository types and adapters; `src/lib/data/demo/interactions.ts`; rail attribution payloads if needed;
interaction and recommendation/evaluation tests and scripts.

**Acceptance:** persist server-issued requests bound to user, item type/ID, policy, scores,
propensities and expiry. Ordinary clients cannot create/alter issued requests. Forged, expired,
cross-user or wrong-item request IDs store no attributed row. Revoke client insert rights to authoritative
attribution fields; update the adapter so legitimate writes omit those fields and the DB supplies them.
Preserve unattributed detail/list actions and hide/undo, including opt-out behavior. One legitimate
request/item impression survives retries. Suggested passive client limits: 60 batches/hour and 2,000
persisted rows/UTC day, enforced atomically in the database. Deleting history must not replenish quotas.
Do not make analytics saturation roll back legitimate saves, ratings or attendance generated by triggers;
explicitly separate trusted transactional events and hide/undo from passive telemetry accounting.
Exclude legacy/untrusted attribution from evaluation without erasing the user's explicit choices.

**Required tests:** real role-based inserts with fabricated UUID/score/propensity; other user's request,
wrong item/type, expiration and changed item visibility; valid dedupe; 100-row batch boundaries and daily
rollover; delete-and-reinsert quota evasion; two clients racing remaining capacity; opt-out/hide/undo,
transactional interaction and demo parity; recommendation/evaluation regressions. Direct PostgREST HTTP
verification is required on isolated staging before treating the hosted boundary as proven.
Run `npm run check`.

**Must not change:** ranking weights, comparison fit, training policy or existing migrations. On issuance
failure keep recommendations usable without fabricating attribution. Bound request retention and include
account-deletion cleanup. **Preflight: approved with the requirements above.**

## Batch 4 — Authorized photo deletion with durable object cleanup

**Objective:** repair F5 and F6 without creating a row/object transaction gap.

**Files/components:** new cleanup queue/trigger migration; Supabase/demo photo and place delete adapters;
`src/server/actions/places.ts`; bounded service-role cleanup worker and authenticated cron integration;
storage, owner-action and account-deletion regression tests.

**Acceptance:** successful authorized deletion and cleanup enqueue commit together, including direct
row deletes and cascades. Unauthorized, suspended, closing-account or failed deletes enqueue nothing
and leave all objects intact. Queue trusted bucket/path stems captured from deleted rows; API callers
cannot submit arbitrary objects for service-role deletion. After a successful worker cycle remove main,
`.sm` and `.md` sizes. Failures retain retryable work and are reported; retries and duplicate jobs are safe.
Worker checks protect still-attached/reused objects. A separate orphan sweeper, if added, must use a
grace period of at least 24 hours and never remove attached objects or new uploads.

**Required tests:** actual owner-control actions and Supabase repository paths with authorized owner,
uploader, non-owner, suspended and closing users; failure before row commit, crash after commit, and
Storage partial failure; positive/negative `0032` three-size policy paths; direct deletes/cascades;
queue access controls, bounded retries and demo parity. Run `npm run check`.

**Must not change:** image encoding, upload limits or visibility. Pending jobs must survive worker rollback;
row disappearance alone is not evidence that Storage was cleaned. External Storage failure makes the
one-cycle target conditional on successful service access. **Preflight: approved with requirements above.**

## Batch 5 — Campaign reversals, partial refunds and Expo receipts

**Objective:** repair F9 and F10 while preserving webhook and notification retry semantics.

**Files/components:** new migration(s); `src/server/payments/webhook.ts`; ads/payments repository
contracts and Supabase/demo twins; `src/server/notifications/push.ts`, notification cron and receipt
ledger/worker; payment, ad, push transport/readiness and database tests.

**Acceptance:** verified settlement records a unique campaign/payment-intent association. A refund
or dispute ends the matching campaign within one processed webhook; duplicate/out-of-order events
cannot reactivate it or affect another campaign. Handle a reversal arriving before settlement with
durable PI-keyed state. Existing campaigns without an association require a documented backfill or
verified provider lookup and reconciliation path; silently ignoring them does not close F9. Partial
ticket refunds produce an operator-visible durable record without changing attendance. Specify and
test conservative campaign behavior for partial refunds; do not automatically resume disputed campaigns.

Persist successful Expo ticket IDs with device/send identity. Poll eligible receipts after the provider's
documented delay, verified against official docs during implementation. Lease work across workers,
retry missing receipts, 429/5xx and network failures with bounded backoff/expiry, and process each terminal
receipt idempotently. `DeviceNotRegistered` removes only the matching device registration (not a later
replacement); `InvalidCredentials` is reported. Account deletion cleans related data. Receipt polling
must not resend the notification or falsely count ticket acceptance as confirmed delivery.

**Required tests:** actual webhook handler/route with signature boundary intact; refund/dispute before
and after completion, replay and replaced checkout; partial-refund records and attendance unchanged;
legacy campaign mapping failure/recovery; Expo single/array/error envelopes, HTTP 429/500, missing and
terminal receipts, duplicate workers, credential errors, device replacement and demo parity.
All provider traffic mocked. Run `npm run check`.

**Must not change:** refund eligibility, Stripe idempotency fences, quiet hours, push caps or the existing
at-most-once sending policy. Keep reversal state and pending receipt work through rollback.
Payment and push changes should remain separately reviewable within this batch.
**Preflight: approved with the requirements above.**

## A1 verification record

Executed locally on 2026-10-28:

| Check | Result |
| --- | --- |
| Working tree / prompt / memory survey | Clean baseline; prompt tracked; workflow memory already correct. |
| Focused baseline command below | **6 files, 42 tests passed**. These are existing tests, not proof the findings are repaired. |
| Scratch PGlite probe with all 38 migrations and seed | Forged attribution persisted as `rules-v2`, score `999`, propensity `0.001`; interactions rule remains `600 / 3600`; cross-user suspension returned `true`; no function default-ACL entry. Scratch databases closed; no application data changed. |
| Scratch privilege comparison | Applied all migrations to a second database with explicit API-role function defaults. Among 87 non-trigger public SECURITY DEFINER functions, effective role privileges differed for `create_place_with_details`, `update_place_with_tags`, `update_event_with_tags` (full signatures compared). Their caller checks still require review; grant differences alone do not prove an exploitable RPC. |
| Source review | All F1–F11 paths above inspected, later migrations checked for overrides, missing cron tests/receipt processing/photo queue searched. |
| `npm run check`, e2e, a11y | **Not run for A1**, which changes documentation only. Mandatory for each implementation batch. |
| vexp `verify_done` | Tool not exposed in this session. Named-file inspection, native searches and focused local verification used. |
| Hosted Supabase/PostgREST, multi-connection Postgres, Stripe/Expo, devices | **Not run**. No credentials, external transactions or deployments used. |

```sh
npm test -- tests/interaction-attribution.test.ts tests/admin.test.ts tests/ads.test.ts tests/geocode.test.ts tests/push-transport.test.ts tests/account-deletion-auth.test.ts
```

**Ready for user review:** the A1 plan and evidence. **Next execution:** A2–A6 template with
`batch 3` and `F4, F11, F8`. All repairs and release gates remain open. Stop here at A1's
explicit no-code boundary; no approval of the branch or implementation is implied.

## Batch 3 implementation and verification

The user requested continuation after A1. The batch-3 contract above governed implementation.

### Changes

- `0039_security_grants_and_suspension.sql` revokes implicit API access to the three older write
  RPCs (`create_place_with_details`, `update_place_with_tags`, `update_event_with_tags`), then
  grants their intended authenticated/service access. No existing migration was edited.
- The same migration binds `is_suspended` to the signed-in caller. All current internal uses pass
  `auth.uid()`, so no private helper is necessary. No-subject service operations still work; admin
  listings retain their independently gated access. Plus visibility is unchanged.
- `admin.isSuspended` now requires an explicit trusted viewer ID in the repository interface;
  both adapters mask cross-user requests. The profile page supplies its authenticated viewer.
  Demo admin listings remain available to admins, matching SQL.
- PGlite initializes explicit API-role function defaults. `tests/fixtures/function-grants.ts` is a
  manually reviewed allowlist with reasons for each group. The inventory reads all 87 non-trigger
  public SECURITY DEFINER functions and checks the exact role/signature set of 52 API-callable ones.
  Tests deliberately expose a new function, a same-name overload, and an existing private-status
  function to verify that the inventory rejects each expansion.
- All four cron routes use one server-only helper that compares SHA-256 authorization-header
  digests with `timingSafeEqual`. Authorization still precedes service-client construction and work;
  scheduling, retention and provider behavior are unchanged.

### Acceptance review

| Criterion | Evidence / result |
| --- | --- |
| F4: faithful defaults and reviewed inventory | `function-grants.test.ts`: exact allowlist; PUBLIC-only revoke leaves API access and is detected; new overload and role expansion detected. **Pass locally**. |
| F4: authenticated calls preserved, anonymous writes denied | Inventory asserts all three repaired signatures; existing schema/admin/action tests pass under the new defaults. A separate probe confirms authenticated/service true, anon false for all three. **Pass locally**. |
| F11: private self status and demo parity | `suspension-privacy.test.ts`: suspended self true; other users and admin RPC callers false; anon RPC denied; demo masks cross-user/anonymous access. **Pass locally**. |
| F11: enforcement and privileged operations preserved | Real SQL calls still reject suspended upload, ticket reservation, pricing, messaging, trip quota, campaign creation and profile writes. Admin listing/unsuspension and no-subject service lookup pass. Existing admin/security tests also pass. **Pass locally**. |
| F8: all cron entry points fail closed | `cron-auth.test.ts` runs each real GET handler: missing/wrong/short/long/malformed/non-ASCII headers and unset/empty secrets return 401 with zero mocked boundary calls. Correct secrets run work and return 200. **Pass locally**. |
| F8: constant-time secret comparison | Full helper review: equal-length SHA-256 digests passed to Node `timingSafeEqual`; missing configuration rejects before comparison. No timing benchmark claim. **Pass by inspection**. |
| Migration ordering / repeatability | All migrations through 0039 applied in database suites; separate scratch reapplication of 0039 succeeded. **Pass locally**. |

### Commands and results

- Focused run: **7 files / 88 tests passed** using the command below.
- `npm run check`: typecheck, lint and **62 files / 1,023 tests passed**. The build failed with
  `TurbopackInternalError: [project]/node_modules/mapbox-gl/dist/mapbox-gl.css [app-client] (css)`;
  cause: `creating new process` → `binding to a port` → `Operation not permitted (os error 1)`.
  A requested elevated `npm run build` retry returned the same error. Therefore the complete
  `npm run check` is **not green**. A separate Webpack build was attempted without configuration changes.
- `npm run build -- --webpack`: the sandboxed run failed with `getaddrinfo ENOTFOUND fonts.googleapis.com`
  and `Failed to fetch` errors for `Bricolage Grotesque` and `Figtree`. Retrying with elevated execution
  succeeded (exit 0): compilation, TypeScript, static generation and route output completed. Thus the
  production Webpack build is **passed**; the default Turbopack check remains environment-blocked.
- Initial focused run failed with `function public.update_place_with_tags(uuid, text, text, text,
  text, double precision, double precision, text, text, text, text, text[], jsonb) does not exist`.
  This was a signature typo in the new migration's GRANT, corrected before the passing runs.
- `git diff --check`: passed before final documentation edits; repeated at completion.
- vexp tools are not exposed in this session; direct inspection and the required local checks were used.

```sh
npm test -- tests/function-grants.test.ts tests/suspension-privacy.test.ts tests/cron-auth.test.ts tests/admin.test.ts tests/security-boundaries-db.test.ts tests/push-readiness.test.ts tests/account-deletion-cron.test.ts
npm run check
npm run build -- --webpack
```

### Separate adversarial self-review

Re-read the implementation and real SQL call sites after the focused tests. Checked effective
privileges (including PUBLIC), full overload signatures, absence of a new unrestricted helper,
the SECURITY DEFINER/current-subject interaction, service calls without a subject, admin listing
access, demo parity, and every cron route's side-effect ordering. No additional blocking defect found.
This was a separate self-review pass, **not an independent second-agent review**.

Hosted Supabase role-owner defaults and PostgREST behavior remain unverified. Apply 0039 on isolated
staging and repeat grant/self/cross-user probes before release. No provider calls or device tests were
made. New API-callable definer functions require a deliberate allowlist review; changing function bodies
still requires semantic security tests (an inventory cannot establish their safety).

No broader release approval: F1/F2/F3/F5/F6/F7/F9/F10 and native/release gates remain open.
**Ready for user review:** batch 3, with the default-build environment limitation above. F4/F8/F11
are fixed and verified locally; hosted application of 0039 remains a release condition. No additional
source fix is required by this self-review. Changes are uncommitted; nothing was pushed or deployed.
Stop after this batch for review, as requested by the work queue.
