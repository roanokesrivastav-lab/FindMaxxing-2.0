# Payment event correctness repair — batch 3

Repairs F4 (duplicate/out-of-order subscription writes) and F5 (unpaid checkout
fulfillment), after the batch 2 self-review. Preflight: **approved with required
changes**, implemented below. No separate Claude brief was available; Astra's
audited findings and acceptance criteria define scope.

## Contract and implementation

- Objective: convergent subscription state and settled-only, retry-safe ticket
  and campaign fulfillment.
- Scope: Stripe handler/reconciliation helper, repository adapters and demo
  ledger, new migration `0028_payment_event_processing.sql`, focused tests and
  accurate existing Stripe fixtures. Existing migrations, product tiers, UI,
  dependencies, deployment, and actual transactions are not changed.
- Required tests: completed duplicates, old/new subscriptions, reversed and
  simultaneous deliveries, failures before/at completion, expired worker fencing,
  unpaid/missing settlement state, async success/failure, expired/canceled holds,
  mismatched amount/currency, campaign activation, and refund failure retries.

The ledger now distinguishes pending, processing, and complete. A service-only
five-minute lease is acquired before processing; subscriptions for a user share
one lease before any remote reads. Concurrent deliveries return a retryable
failure, not a false successful acknowledgment. A completed event is a true no-op.
Failures release pending work; process crashes are recoverable by Stripe retry
after lease expiry. Previously recorded ledger rows remain completed.

Subscription processing retrieves current remote state and paginates all
subscriptions belonging to the mapped customer/user. It chooses a live eligible
subscription over inactive ones, then uses a deterministic creation/ID tie-break
within the same access class. An old subscription or former customer's event
cannot override a live replacement. This uses current remote state, not event
timestamps or stale event snapshots. Incomplete/failed inventory is not applied.
Subscription checkout completion also takes the user lease and reconciles remote
state; it does not blindly relink a customer from an old checkout snapshot.
The fenced customer mapping, plan update and event completion commit in one SQL
transaction; an expired worker cannot apply its old snapshot after another worker
takes over.
Batch 2's account-closing guards remain intact. Temporary lock keys are cleared
from completed/released events rather than retaining an unnecessary user mapping.

Payment-mode checkout events fulfill only with `payment_status: paid`, a payment
intent, the expected USD currency, and matching amount. Unpaid/missing state and
`no_payment_required` do not grant a paid ticket or campaign. Async success enters
the same guarded fulfillment path; async failure expires a pending ticket without
undoing an already-paid one. A released or elapsed ticket hold cannot be revived
by delayed payment: its payment intent is retained for refund. Canceled events and
invalid amounts/currencies likewise take the existing refund path. Unknown/replaced
checkout refunds retain stable keys and failed refund requests leave the event
retryable. Campaigns stay awaiting payment on failure; their approved retry and
existing activation rules remain unchanged.

Ticket/campaign transitions are idempotent SQL operations separate from generic
event completion. A crash after such a transition replays that guarded transition;
it does not lose fulfillment. Remote refunds/cancellations cannot be part of a
Postgres transaction; their remote terminal state/stable keys handle retries.

## Independent verification

- 30 new tests across two files passed, covering the contract above.
- Batch 3 milestone suite passed: 41 files, 795 tests.
- After the adversarial privacy cleanup, 82 payment/ads/deletion regression tests
  passed across six files.
- Web type-check, lint, and whitespace checks passed.
- The integration review additionally caught and fixed stale checkout/customer
  relinking. Its tests prove customer mapping rolls back with a failed plan commit;
  66 payment/deletion checks passed after that fix.
- Final integrated suite: 43 files, 813 tests passed, including both batches.
- Webpack production build, 19/19 browser checks, accessibility (15 pages, zero
  issues), mobile type-check, and Expo web export passed. Web type-check was rerun
  after the final build. See batch 4's report for the consolidated gate results.

Actual migrated database tests verify service-role boundaries, transactional
rollback on invalid plan state, complete-event no-op, user-level lease contention,
scope mismatch rejection, stale-token fencing, account-closing races, and expired
hold refunds. Failure-injection tests invoke the real handler/adapters with fake
Stripe APIs; the signature test still uses Stripe's installed signature utilities.
Existing paid fixtures now explicitly contain `payment_status`/currency and
authoritative remote subscription fixtures. Assertions were updated to reflect
true duplicate no-ops, not weakened to accept missing fulfillment.

Adversarial review additionally inspected lost commit responses, stale external
snapshots, former customer associations, another subscription's delayed events,
partial refund failures, and unnecessary retained lock metadata. No remaining
local blocker was found. **Ready for user code review, not production approval.**

## Required staging checks

1. Apply migrations through `0028` to disposable staging before this version of
   the application. Confirm API callers cannot access event control RPCs/locks.
2. In Stripe test mode, deliver/replay/reorder real subscription and checkout
   events, including async success/failure, after enabling those event types on
   the webhook endpoint. Confirm replacement plans converge to remote state and
   unpaid sessions grant no access.
3. Exercise simultaneous deliveries/lease takeover using real multi-connection
   Postgres, and fail the service between remote reads, fulfillment, and completion.
   PGlite proves SQL/failure paths but not multi-process service concurrency.
4. Verify refunds for payments settling after the 30-minute hold and after host
   deletion. Confirm no double refund and no lost payment intent.
5. Review existing entitlements against Stripe before rollout. Historical ledger
   rows remain completed; this migration does not automatically backfill remote
   state that was corrupted by the old handler. A separate authorized data
   reconciliation is required if such rows exist.

No hosted migration, deployment, real payment/refund, or test-mode Stripe network
transaction was performed. vexp was unavailable; review used direct source/diff
inspection and tests. References: [Stripe webhook ordering/retries](https://docs.stripe.com/webhooks)
and [subscription inventory](https://docs.stripe.com/api/subscriptions/list).

## Follow-up self-review — 2026-10-14

Reproduced and repaired a stale closed-account event canceling a subscription
whose current remote ownership points to another account, plus malformed UUID
metadata causing permanent RPC errors. Current ownership is checked before
webhook-driven cancellation; validated/canonical UUID metadata is shared across
claims and reconciliation. Four new regressions cover both stale event forms,
invalid identifiers and uppercase UUID consistency. Legitimate durable account
closure behavior is preserved. See `release-mobile-verification.md` for the
current combined gate and remaining release requirements.
