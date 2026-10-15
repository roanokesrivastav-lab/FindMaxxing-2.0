# Account deletion and billing repair — batch 2

Repairs audit findings F1 (Storage before Auth deletion), F2 (host deletion
refunds), and F3 (subscription billing after deletion). Based on the independent
audit at `docs/audit-findings-2026-10-13.md`; no separate Claude brief was supplied.

## Preflight contract

Decision: **Approved with required changes**, incorporated in this implementation.

- Objective: make deletion retryable without losing Storage cleanup information,
  future-event refund obligations, or subscription identifiers.
- Allowed scope: deletion server/UI, payment adapters, deletion-related Stripe
  handling, existing payments cron, one additive migration, and regression tests.
- Required safeguards: verify the current account's password before preparation;
  durably inventory cleanup before cascades; do not claim completion on partial
  failure; preserve authorization, suspension checks, and historical records.
- Policy used: cancel subscriptions immediately with no new prorated refund or
  final invoice; refund paid tickets for the host's events with `starts_at > now()`;
  expire pending buyer/host holds; retain historical payment records without the
  deleted profile attached. In-progress/past events are not automatically refunded
  by deletion. Paid-campaign refund policy is unchanged.
- Must not change: native screens, dependencies, purchase feature defaults,
  unrelated payment fulfillment, previously applied migrations, deployed data,
  or production configuration.

## What changed

- Migration `0027_account_deletion_lifecycle.sql` adds a service-only deletion
  journal, without a cascading user FK. It snapshots all owned/prefixed Storage
  objects, nested/unattached uploads, and attached photos/variants on the user's
  places, including those uploaded by another person. SQL inventory avoids a
  Storage list-page limit; inventory errors fail the operation.
- Preparation freezes signed-in contributions/uploads, cancels future published
  events, and expires pending holds. Account locks serialize relevant writes,
  photo attachment, ticket admission, and billing setters against preparation.
  Another user cannot use the closing-status RPC to inspect arbitrary accounts.
- The worker closes billing, removes Storage through its API in batches of 100,
  then deletes Auth. It checkpoints each subscription cancellation and Storage
  batch. A ten-minute renewable lease fences database progress; failed requests
  retain identifiers and unfinished work for the next attempt. Reappearing objects
  invalidate Storage completion and their removal checkpoints.
- Billing cleanup expires open subscription checkouts and inventories every
  customer subscription, not just the single entitlement row. Terminal remote
  subscription state recovers lost cancellation responses. Checkouts that race
  deletion are rejected/expired; late subscription events cancel billing rather
  than recreate entitlement, customer, or payout mappings. Ignored invoice events
  do not grant access.
- Event deletion now queues future paid refunds before `event_id` is cleared.
  Payment-intent identifiers survive; expired/already-refunded and historical paid
  tickets retain their state. The existing refund worker and its stable refund
  keys remain in use. Demo deletion mirrors future-event refunds and preserves
  its live file manifest until cleanup succeeds.
- The existing authenticated payments cron resumes deletion jobs (up to ten per
  invocation) and refunds even when new purchases are disabled. Verified Stripe
  webhooks also remain active in configured Supabase mode with purchases disabled;
  raw-body signature verification is unchanged.
- Successful completion clears Storage paths, customer/subscription IDs, and
  checkpoints from the journal, retaining only a user-ID/timestamp tombstone.
  No password, session, or client-side service credential is stored. UI copy now
  explains partial cleanup, automatic retry, subscription termination, and refunds.

An administrator's Auth deletion also journals cleanup before profile cascades.
Deleting a profile for repair while its Auth user still exists is deliberately
not treated as account deletion, preserving the existing recovery workflow.

## Acceptance criteria and verification

| Criterion | Evidence |
| --- | --- |
| Correct password and account required before any cleanup | Wrong-password, other-account, and preparation-error action tests |
| Complete inventory, Storage before Auth, retryable partial failures | 1,109-object SQL inventory; 1,105-object worker batches; inventory, billing, Storage, Auth, and completion-persistence failure injection; lost Auth response |
| Durable bounded progress and no premature success | Per-batch/per-subscription checkpoint tests, reappearing-object recovery, incomplete inventory rejection, lease contention/fencing, incomplete finish rejection |
| Future host tickets refund without erasing obligations | Actual migrated Auth cascade, expired/pending/already-refunded tickets, historical paid tickets, late confirmation refund, repeated refund acknowledgment, demo parity; existing refund-key tests |
| Billing closes without access resurrection | Duplicate-subscription inventory, cursor pagination, timeout/retry and lost cancellation response, checkout/deletion race, late subscription/checkout/payout/invoice fixtures, database setter guards |
| Permissions and existing behavior preserved | Journal/RPC denial for authenticated/anonymous callers, caller-bound status, frozen writes/uploads/attachments, missing-profile recovery, all existing moderation/messaging/notification suites |
| Cleanup remains operational when purchases are disabled | Authenticated cron and signed/forged webhook route tests |

Final local checks:

- Full test suite: **39 files, 767 tests passed** (734 existing plus 33 new).
- Web type-check and lint: passed.
- Production build: passed with Webpack and isolated demo configuration.
- Browser end-to-end: 19/19 passed, including uploaded-photo account deletion.
- Accessibility: 15 pages, zero issues; keyboard focus check passed.
- Mobile type-check and Expo web export: passed; no mobile source changed.
- Whitespace/diff check: passed.

The default Turbopack command was not rerun in this batch: the earlier audit and
batch 1 documented local port-binding `EPERM`, including escalated execution.
Webpack success is not proof that the default command passes. Browser tests use
fresh demo data and scratch uploads, not hosted Auth/Storage or Stripe.

## Adversarial review and remaining release requirements

The separate failure-focused review inspected password bypass, manifest loss,
partial irreversible work, stale worker progress, late billing writes, checkout
races, cascade ordering, other-uploader photos, orphaned tickets, and retry
starvation. It caught and corrected a missing-profile recovery regression and
added granular checkpoints so repeated timeouts do not restart completed cleanup.

No remaining local blocker was found for this batch: **ready for user code
review, not approved for production release**. Required staging verification:

1. Apply `0027_account_deletion_lifecycle.sql` in a disposable Supabase project,
   after prior migrations, before deploying this application version. Keep the
   journal and control RPCs service-only. This migration was not applied remotely.
2. Verify actual Auth + Storage deletion with nested/unattached uploads, more than
   one page, and another user's attached photo. Inject removal/Auth failures and
   retry; verify the blobs as well as metadata are gone. PGlite does not implement
   the real Auth service's Storage ownership restriction.
3. In Stripe **test mode**, delete an actively subscribed host with duplicate/open
   subscription checkouts and future paid tickets. Confirm remote cancellation,
   no future renewals, successful eligible refunds, retained historical records,
   and late/replayed webhooks without restored access. Check no duplicate refunds
   under simultaneous confirmation, deletion, and cron requests.
4. Test real multi-connection Postgres races for writes/uploads, photo attachment,
   late confirmation, and competing deletion workers. PGlite and stubs exercise
   guards/failure paths but do not prove live concurrent service behavior.
5. Ensure `CRON_SECRET`, server-only Supabase service credentials, Stripe secret
   and webhook secret, and the existing 15-minute payments scheduler remain
   operational while cleanup/refunds are pending, even if purchases are disabled.
   Alert on failed jobs/refunds; do not infer completion from HTTP success alone.
   A killed worker's lease takes up to ten minutes to expire before retry.

No real user deletion, billing cancellation/refund, hosted migration, deployment,
or native-device test was performed. Audit F4/F5 (general subscription event
ordering and unpaid fulfillment) and F9 (Expo push gating) were separate work at
this milestone; subsequent local repairs are documented in
`payment-event-repair.md` and `push-transport-repair.md`. This batch alone does
not approve those paths. vexp tools were unavailable; independent
verification used direct source/diff inspection and the repository test commands.

Relevant service contracts: [Supabase user deletion](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users)
requires removal of owned Storage objects before Auth deletion;
[Stripe subscription cancellation](https://docs.stripe.com/api/subscriptions/cancel)
provides the cancellation operation used by the worker. The remote outcomes still
require the staging checks above.

## Follow-up self-review — 2026-10-14

Before starting batches 3 and 4, independently re-inspected the deletion worker,
forward migration, surrounding ticket/Stripe code, service permissions, failure
messages, and retry fencing. All 33 focused deletion tests passed. No additional
local blocker was found. The real Auth/Storage ownership behavior and
multi-connection/live-service races remain staging requirements, not locally
verified claims. Batch 3 also reruns these tests against its payment changes.
The final integrated batches 2–4 suite passed 813 tests across 43 files, with
19/19 demo browser checks, zero accessibility issues on 15 pages, and successful
type-check/lint/Webpack build/mobile export checks. Hosted checks remain pending.
