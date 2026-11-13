# 0053 — Event admission: capacity, reservation and fulfilment

Priority: Must (the first slice of 4.5a's database work, under
[4.0 Amendment A1](4.0.md#amendment-a1-2026-11-11--must-event-subset-without-waitlists) revision 3).
Branch `codex/founder-implementation-handoff-2026-11-11`, starting commit `e2eabb3`.
Status: **IMPLEMENTED-LOCAL.** Migration, demo twin and tests. Awaiting Codex review. Not applied to any
hosted database. 0054 not started.

## Contract

- **Objective:** one capacity rule on every way into an event. Seats taken are the people going plus
  live paid holds. A full event refuses a join, a reservation and a late confirmation alike.
  Payment confirmation and reservation take their locks in one order (the person's account, the
  event, the ticket), decide on one clock read after the locks, and keep today's results and refund
  outcomes. A host cannot lower capacity under a live hold.
- **Allowed files:** migration `0053_event_admission.sql` (functions and one trigger only), the
  demo twin (`src/lib/data/demo/repository.ts`, `demo/payments.ts`), tests, this note and the ledger.
- **Functions:** new `findmaxxing_private.seats_taken_at`; `findmaxxing_private.seats_taken`
  redefined on it; `public.check_event_join`, `public.confirm_ticket`, `public.reserve_ticket`
  replaced; the attendee-count floor removed from `public.guard_owner_event_change`; new trigger
  function `findmaxxing_private.guard_event_capacity_floor`.
- **Preserved:** every grant and policy (legacy direct insert and delete on `event_attendees` from
  web and native; `reserve_ticket` for signed-in users; `confirm_ticket` for the service role only);
  every error string; `confirm_ticket`'s four results; the refund-pending contract including the
  payment intent on a queued refund; reserved migration 0052.
- **Out of scope:** series tables and schedule changes (0054), notifications (0055), waitlists and
  offers (4.4, Later), typed join wrappers, any UI, any hosted database.
- **Preflight:** done. [Revision 3 preflight](amendments-r3-codex-review.md#40-events), item 1: "The
  0053 admission slice may proceed under the contract below." Its conditions are the acceptance rows
  in this note.

## Changes

**`supabase/migrations/0053_event_admission.sql`** (functions and one trigger; no table, column,
grant or policy change).

- `findmaxxing_private.seats_taken_at(event, at)`: people going plus `pending` tickets with
  `expires_at > at`. `seats_taken(event)` (0051, used by readiness) is now that at the current clock.
  Both stay revoked from every API role.
- `check_event_join()`: same rules, order and messages as before. The count is now
  `seats_taken_at`, read after the event lock. A paid ticket is no exemption. The host still needs
  no ticket and is still subject to capacity.
- `confirm_ticket()`: reads the ticket without a lock to learn what to lock, then takes the buyer's
  account lock, the event row and the ticket row, in that order, and **re-reads the ticket**. A
  reference that became null (event deleted, buyer anonymized) is refunded. A reference that points
  somewhere else raises `payments:ticket_changed` (SQLSTATE 40001) and nothing is changed. One
  clock read after the locks decides whether the hold is live. Same four results. Every refund path
  stores the payment intent.
- `reserve_ticket()`: the caller's account lock first; then the event; one clock read for the
  sweep, the count and the new hold's expiry (`v_at + 30 minutes`).
- `guard_owner_event_change()`: re-created from 0012 with its attendee-count floor removed.
- `findmaxxing_private.guard_event_capacity_floor()` and trigger
  `guard_owner_event_change_capacity_floor`: lowering capacity below seats taken is refused with the
  existing message. Raising capacity, or an edit that leaves it alone, is never refused. It is a
  definer function because the owner guard is an invoker and may not call the private count.
- A check at the end fails the migration if `event_attendees_block_suspended` (account lock) would
  stop firing before `event_attendees_check_join` (event lock).

**Demo twin** (`src/lib/data/demo/repository.ts`, `demo/payments.ts`): join, reservation,
confirmation and capacity edit use the same seat count (`seatsTaken`, already used for readiness).
Confirmation counts the other people going and the other live holds. Capacity is refused only when
lowered below seats taken. One difference from SQL found by the parity scripts and removed: the
demo marked lapsed holds expired even when the reservation was then refused; SQL rolls that back.

Flags: none. Dependencies: none. No UI change. Existing clients need no change: the web and native
direct insert and delete on `event_attendees` keep working and now meet the new count.

## One deliberate narrowing, for the reviewer

`confirm_ticket`'s `exception when others` used to turn **any** failure of the seat insert into a
refund, including a deadlock. It now re-raises four concurrency errors (`40P01` deadlock, `40001`
serialization, `55P03` lock not available, `57014` cancelled) so the webhook is retried, and refunds
on everything else as before. With the new lock order I could not produce a deadlock, so this is a
backstop. It is the one place the function does not keep "the existing handler unchanged". Say so
if it should go back.

## How a hold stranded before this migration settles

A hold is "stranded" when capacity was lowered under it: more seats are spoken for than the event
has. 0053 cannot un-strand it, and does not try. From the migration on:

- nobody new is admitted while the event is over its limit (joins and reservations are refused);
- the host can still edit the event, and can raise capacity, which un-strands the hold;
- if the buyer pays while it is still over, the payment is refunded under the existing contract
  (`refund_pending` with the payment intent), exactly as before the migration;
- if the buyer never pays, the hold runs out at its `expires_at` and stops counting;
- capacity cannot be lowered further under it.

Tested on SQL and the demo twin in `tests/event-admission.test.ts` (three stranded-hold scripts).

## Acceptance evidence

| Requirement | Evidence | Result |
| --- | --- | --- |
| One capacity rule across RSVP, paid reservations, payment confirmation and capacity edits | `tests/event-admission.test.ts`, eight scripts run step for step on SQL and the demo twin | Pass |
| Limited to capacity, reservation and fulfilment plus the demo twin | "the migration is functions and one trigger only" (source check) | Pass |
| Legacy web and native grants preserved | "existing permissions are exactly as they were" (function grants, table privileges, the three `event_attendees` policies, tickets not client-writable); `tests/function-grants.test.ts` and `tests/payments.test.ts` unchanged and passing | Pass |
| Paid outcomes preserved; payment intent kept on a queued refund | "confirmation keeps its four answers"; "a deleted event, an anonymized buyer and a closing account are each refunded"; intent asserted in every refund case | Pass, with the narrowing above |
| 0052 still reserved | no `0052*` file; `0053_event_admission.sql` present | Pass |
| An event or buyer reference may become null; a different non-null reference never proceeds | null cases above; race case "a ticket that points at a different buyer once locked is not acted on at all" (error, ticket still `pending`, nobody seated) | Pass |
| **Live-hold last-seat guard** (attendees below capacity, last seat held) | PGlite/demo: the paid-ticket holder and the host who left are both refused. PostgreSQL: "the live-hold guard…" (1 going + 1 live hold of 2: refused) and the same seat raced in both orders | Pass |
| **Hold already stranded before the migration** | the three stranded scripts (no new claims; refunded when paid; runs out; seated after capacity is raised) | Pass |
| **Buyer account-closure race** | PostgreSQL: a confirmation waiting on the buyer's account lock holds neither event nor ticket; real `prepare_account_deletion` against `confirm_ticket` in both orders with no deadlock | Pass |
| Reservation lock order | PostgreSQL: a reservation waiting on the caller's account lock holds no event | Pass |
| Seat count callable under the real roles only through the guarded paths | PGlite and PostgreSQL: direct calls refused for `authenticated`, `anon` and `service_role`; join, edit, confirm and readiness work | Pass |
| A1.6 admission subset on disposable PostgreSQL | table below | Pass, except case 12 (not part of 0053; see Remaining) |
| PGlite and demo parity | `tests/event-admission.test.ts` 15/15; existing `payments.test.ts` parity still passing | Pass |

### A1.6 cases on PostgreSQL 17.11 (`tests/event-admission-pg.test.ts`)

| A1.6 | Case | As written | With its guard removed |
| --- | --- | --- | --- |
| 1 | Last free seat, two inserts | second waits, then `This event is full`; 2 going of 2 | no event lock in the join: both in, **3 going of 2** |
| 2 | Capacity lowered racing a join, both orders | the later one is refused; seats never exceed capacity | (regression) |
| 3 | Two reservations for the last paid seat | second waits, then full | (regression: already serialized before 0053) |
| 4 | Capacity lowered under live holds | refused; the hold then confirms | no floor trigger: lowered, and the buyer who pays is **refunded** |
| 5 | Paid leave, seat re-held, old ticket returns | refused; old ticket stays `paid`; the new buyer is seated | live holds left out of the count: old ticket **gets in**, seats exceed capacity, the new buyer is **refunded** |
| 5 | The same seat raced, both orders | exactly one gets it | (covered by the row above) |
| 6 | Confirmation against cancellation, both orders | ticket ends `refund_pending` with its intent; no deadlock | (see the re-read row) |
| 7 | Confirmation against a new reservation for the last seat, both orders | one or the other, never both | (see the re-read row) |
| 8 | Confirmation against the host's account closure, both orders | `refund_pending`, event cancelled; no deadlock | — |
| 9 | Lock order: waiting on the event | holds no ticket | the 0028 function: **holds the ticket** |
| 15 | Lock order: waiting on the buyer's account; closure against confirmation, both orders | holds neither event nor ticket; closure first → refund, confirmation first → seated | no account lock first: **holds event and ticket** while waiting |
| 16 | Lock order: reservation waiting on the caller's account | holds no event | the 0022 function: **holds the event** |
| 17 | Confirmation that gets the lock after the hold ran out | `refund` | transaction start time: **confirmed** |
| 18 | Reservation that waited for the lock | hold is 30 minutes from when it could act | transaction start time: **shorter by the wait** |
| new | The same payment delivered twice at once | `confirmed`, then `duplicate` | no re-read after locking: **`confirmed` twice** |
| new | Ticket points at another buyer once locked | error, nothing changed | — |

After the removal tests, the suite re-applies the migration and checks it is back as written.

**A correction to the amendment's own table.** A1.6 says removing the re-read should make cases 6
and 7 fail. It does not: in both, the join trigger or the expiry check still catches the stale row
and the outcome is the same. What the re-read alone protects is a second delivery of the same
payment, so that is the case used here. The amendment's row should be changed to match.

## Tests

All local, 2026-11-12/13.

| Command | Result |
| --- | --- |
| `npx vitest run tests/event-admission.test.ts` | **15/15** (PGlite and the demo twin) |
| `TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres npx vitest run tests/event-admission-pg.test.ts` | **28/28**: 18 as written, 9 with a guard removed, 1 restoration check. Run five times in a row: 28/28 each. About 8 seconds |
| `npx vitest run tests/payments.test.ts tests/session-rules.test.ts tests/function-grants.test.ts tests/schema.test.ts` | 102/102, unchanged files |
| `TEST_DATABASE_URL=… npm run check` | **exit 0.** Typecheck, lint, **77 files / 1,376 tests, 0 skipped**, build. The tree also held the uncommitted event-page fix |
| `npm run typecheck --workspace @findmaxxing/mobile` | exit 0 |
| Demo-mode build, then `npm run e2e` | 21/21 |
| `npm run e2e:features` | 11/11 (prices an event, cancels a checkout, pays, refunds on cancellation, through the demo twin) |
| `npm run e2e:event-detail` | 9/9 (join, full, priced) |

Not run: `a11y`, `e2e:onboarding` (no page code changed); anything against a hosted database.

## Adversarial review

- **Three failures in the first PostgreSQL run were the test's, not the migration's:** it read the
  ticket before the waiting confirmation had finished; it tried to lower capacity to 1, which the
  table's own check forbids; and a failed step left a connection in the wrong role, which failed
  every test after it. All three were fixed in the test. Recorded so the green run is not read as
  "passed first time".
- **Trigger order.** The first version of the order check demanded that the account-lock trigger be
  the very first; another trigger (`…_a_insert_metadata`, which takes no lock) sorts before it. The
  check now compares only the two triggers that matter.
- **The second insert still queues without the event lock.** With the join's lock removed, the
  second insert waits briefly behind the first on a later, unrelated row and then goes through. The
  proof is the outcome (3 going of 2), not the absence of waiting.
- **Snapshot after waiting.** Every count runs as a new statement after the lock is granted, inside
  a volatile function, so it sees rows committed while it waited. Cases 1, 2 and 5 depend on this
  and pass.
- **Private helper under real roles.** The capacity floor is a trigger function in the private
  schema; it runs for a signed-in owner without any grant on that schema, and a direct call from
  the same role is refused.
- **Someone who does not own the event** gets no capacity message: RLS hides the row from their
  update, so no trigger runs. Tested.

## Remaining issues

- **NOT VERIFIED: hosted Supabase.** Local PostgreSQL 17.11 and PGlite only. Whether 0052 was ever
  applied to a hosted database is still an open rollout check (4.0 A1.7).
- **A1.6 case 12** (`decide_sessions` racing a join) is not in this slice: 0053 does not touch that
  function. It stays NOT VERIFIED from 4.3.
- **The narrowing of the refund handler** above needs the reviewer's yes.
- **The amendment's mutation table** needs the one-row correction above.
- In Supabase mode the edit form's pre-check still counts attendees only; the database refuses the
  live-hold case and its message is mapped to the same error. That path was not driven through a
  browser in Supabase mode.
- `payments:ticket_changed` reaches the webhook as an error. The webhook's retry behaviour for it
  was not exercised (no code path can produce it today).

## Handoff

- Commit: the commit that adds this evidence; hash in [progress.md](../implementation/progress.md).
- Ready for independent review: yes. Stopped here as asked: 0054 not started, nothing pushed.

## Independent Codex verification

0053 is verified locally and is ready as the base for the 0054 contract. The admission migration, legacy roles, demo parity and buyer-closure and last-seat race outcomes were independently checked. Hosted Supabase and the hosted 0052 history remain open. The 4.3 `decide_sessions` race remains outside this slice.

- Approved the retryable SQL error handling. A transient failure should leave the delivery pending so it can retry. The added PGlite test injects `40001` during attendee insertion and proves rollback, followed by one confirmation and a duplicate result. The webhook regression proves it releases the claim and does not issue a refund on the failed attempt. A retry confirms once. The route's existing error response requests redelivery.
- Confirmed the corrected mutation target. The locked ticket re-read protects simultaneous duplicate delivery. Cancellation and competing reservations also have other guards. Updated the amendment's proof table to match the actual evidence.
- Independent runs passed the 28 PostgreSQL race and mutation checks, 16 SQL/demo admission checks, 25 payment-event processing checks, mobile typecheck, the 11-check feature browser suite and the 9-check event detail browser suite. See the progress ledger for the full run and golden-journey result.
