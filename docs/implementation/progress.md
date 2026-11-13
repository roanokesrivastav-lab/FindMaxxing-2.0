# Persistent implementation ledger

This file lets another founder’s agent resume without chat history. Baseline labels are dated review evidence only. Do not mark a spec or local implementation as independently verified merely because it is Must.

| Ticket | Priority | Current state | Implementation commit | Evidence / blocker |
| --- | --- | --- | --- | --- |
| [1.1](tickets/1-1-design-tokens-and-primitives.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | earlier work | [00-baseline](../features/00-baseline.md) §3; not independently verified |
| [1.2](tickets/1-2-six-interest-thumbnail-picker.md) | Must | IMPLEMENTED-LOCAL | `78b0b34` | [features/1.2.md](../features/1.2.md); no real thumbnail photos, no device run |
| [1.3](tickets/1-3-first-map-arrival.md) | Must | INDEPENDENTLY VERIFIED in Chrome | `29cc1ce`, fixes `d8dc696` | [features/1.3.md](../features/1.3.md); Chrome only, no device run |
| [1.5](tickets/1-5-quiet-events-tab.md) | Must | BLOCKED — needs followed-series data (4.5a) | — | See batch 02 |
| [2.1](tickets/2-1-map-clustering.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 05 |
| [2.4a](tickets/2-4a-time-and-travel-filters.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 05 |
| [2.4b](tickets/2-4b-has-room-availability-filter.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 05 |
| [2.5](tickets/2-5-photo-first-place-decisions.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [2.7](tickets/2-7-best-for-less-suited.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [2.8](tickets/2-8-public-and-personal-photos.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [4.7](tickets/4-7-intent-aware-pins-and-venue-sessions.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 05 |
| [3.1](tickets/3-1-richer-saves.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [3.2](tickets/3-2-library-tools.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [3.3](tickets/3-3-matching-provider-specification.md) | Must | SPEC RECONCILED (document only) | `99f8023` | [3.3 validation note](../features/3.3.md); B1/B2 deferred with the Later importers |
| [3.6](tickets/3-6-pick-from-my-saves.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 03 |
| [4.0](tickets/4-0-event-foundation-specification.md) | Must | 0053 verified locally; 0054 contract requirements open | `c06f1ad`, r2 `3bd83e0`, r3 `d342838` | [Revision 3 findings](../features/amendments-r3-codex-review.md); [current handoff](founder-fable-handoff.md) |
| [4.1](tickets/4-1-editorial-event-detail.md) | Must | PARTLY IMPLEMENTED-LOCAL (existing-contract part) | `094be4e`, host-leave fix `7084dbf` | [features/4.1.md](../features/4.1.md); host attendance copy verified locally; newcomer block needs its write contract |
| [4.2](tickets/4-2-structured-activity-details.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | `15f5561` | [00-baseline](../features/00-baseline.md) §3; hosted NOT VERIFIED |
| [4.3](tickets/4-3-attendance-and-readiness.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | `f2eb957` | [00-baseline](../features/00-baseline.md) §3; cron, push and the decide-vs-join race NOT VERIFIED |
| 4.5a slice: [0053 admission](../features/0053-admission.md) | Must | INDEPENDENTLY VERIFIED locally | `431f8d3`, retry proof `8b053f3` | [Review and tests](../features/0053-admission.md#independent-codex-verification); hosted NOT VERIFIED |
| [4.5a](tickets/4-5a-recurring-series-and-host-tools.md) | Must | READY — start with the 0054 lock and permission contract | — | [Exact next task and tests](founder-fable-handoff.md#next-task-45a-recurring-series-migration-0054) |
| [4.5b](tickets/4-5b-permanent-series-page.md) | Must | BLOCKED — needs 4.5a | — | See batch 02 |
| [4.6](tickets/4-6-material-change-notifications.md) | Must | BLOCKED — needs verified series contract (4.5a) | — | See batch 02 |
| [4.8](tickets/4-8-optional-party-poster.md) | Must | BLOCKED — needs a scoped write contract | — | See batch 02 |
| [4.pre](tickets/4-pre-real-postgres-concurrency-harness.md) | Must | IMPLEMENTED-LOCAL (harness reverified) | earlier work | [00-baseline](../features/00-baseline.md) §3; event race suites arrive with 4.5a (4.0 A1.6) |
| [5.0](tickets/5-0-outings-specification.md) | Must | APPROVED WITH REQUIRED CHANGES — Must Events gate and outing fixes remain | `9c515b9`, r3 `d342838` | [Revision 3 preflight](../features/amendments-r3-codex-review.md#50-outings-and-the-63-itinerary-read-contract); blocks 5.1–5.5 |
| [5.1](tickets/5-1-outing-core-and-invites.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.2](tickets/5-2-private-save-shortlist.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.3](tickets/5-3-yes-fine-cannot-lock.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.4](tickets/5-4-browser-invite-and-sign-in-return.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.5](tickets/5-5-start-outing-from-an-event.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [6.0](tickets/6-0-routing-and-feasibility-spec.md) | Must | SPEC RECONCILED (document only) | `fbd995b` | [6.0 validation note](../features/6.0.md); provider terms unconfirmed |
| [6.1](tickets/6-1-real-walking-routes.md) | Must | IMPLEMENTED-LOCAL (not live; nothing calls it yet) | `062511c` | [features/6.1.md](../features/6.1.md); migration 0095; Mapbox exercised on stubs only; hosted NOT VERIFIED |
| [6.2](tickets/6-2-deterministic-feasibility-checks.md) | Must | IMPLEMENTED-LOCAL (pure module; nothing calls it yet) | `78cc608` | [features/6.2.md](../features/6.2.md); 6.1 is also implemented locally |
| [6.3](tickets/6-3-shared-versioned-itinerary.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 07 |
| [6.4](tickets/6-4-itinerary-editor.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 07 |
| [7.1](tickets/7-1-flash-maps.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 08 |
| [7.2](tickets/7-2-live-reports-pilot.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 08 |
| [7.4](tickets/7-4-contributor-feedback.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 08 |
| [0.1 / 0.3](tickets/0-1-0-3-security-flags-and-pilot-seed.md) | Must | 0.3 and 0.1a IMPLEMENTED-LOCAL (reverified); **0.1b NOT STARTED** | earlier work | [00-baseline](../features/00-baseline.md) §3; 0.1b needs a brief and preflight |
| [8.1a](tickets/8-1a-native-explore-parity.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 09 |
| [8.1b](tickets/8-1b-native-event-rpc-and-offer-ui.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 09 |
| [8.1c–e](tickets/8-1c-e-native-outing-invite-and-itinerary.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 09 |
| [8.2](tickets/8-2-full-golden-journey-e2e.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 10 |
| [8.3](tickets/8-3-pilot-metrics.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 10 |
| [8.4a/b](tickets/8-4a-b-candidate-release-gate.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 10 |
| [R4](tickets/r4-weekly-outing-memories.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 08 |

## Current handoff

- **Next task is 0054 recurring series for 4.5a.** The [founder handoff](founder-fable-handoff.md) gives the required contract and tests. Independent Codex checkpoints are paused during the founders' Fable run. Keep technical prerequisites and local verification gates.
- Priority snapshot is confirmed; delivery order and narrowed technical contracts are proposed.
- Start at batch 00 and inspect the actual clean branch. Existing 1.1/4.2/4.3 should be reused and reverified.
- Deferred snapshot is quarantined on its own branch; do not treat it as a dependency.
- For each session record last completed ticket, actual checks, current blockers/reviews, next ready ticket and worktree/branch. Update evidence links and commit hashes as work actually lands.
- Use IMPLEMENTED-LOCAL, NOT VERIFIED, BLOCKED, INDEPENDENTLY VERIFIED and release statuses precisely; all priorities remain separate.

## Session log

### 2026-11-11 — batch 00 (baseline and spec amendments)

- Branch `codex/founder-implementation-handoff-2026-11-11`, started at `4eea5e5`, clean. Evidence:
  [features/00-baseline.md](../features/00-baseline.md).
- Checks on unchanged source: `npm run check` exit 0 with a local PostgreSQL URL (70 files, 1,172
  tests, 0 skipped, build OK); mobile typecheck exit 0; `npm run e2e` 19/19; `npm run a11y` 0 issues.
- Blocked on independent review: 4.0 Amendment A1 and 5.0 Amendment A1 (Codex preflight). Later
  preflights needed for 2.7, R4 and 0.1b when their contracts are written.
- Owner actions open: push the two `codex/` branches (neither is on origin); confirm whether 0052 was
  ever applied to a hosted database before any hosted rollout.
- Next ready: batch 01, tickets 1.2 then 1.3.

### 2026-11-11 — batch 01 (onboarding), stopped at the session's usage limit

- Done and committed: 1.2 (`78b0b34`) and 1.3 (`29cc1ce`). `npm run check` exit 0 on both (1,214 tests on
  1.3, none skipped); `npm run e2e:onboarding` 10/10 on 1.3.
- **Not done:** `npm run e2e` and `npm run a11y` on the 1.3 commit (the golden journey script changed
  in 1.3); the batch 01 review bundle with screenshots. Build in demo mode first (see
  [00-baseline](../features/00-baseline.md) "Environment facts").
- Nothing was pushed. Still blocked on Codex preflight: 4.0 A1 and 5.0 A1.
- Next ready after those two runs: batch 02's UI-only tickets (4.1, 1.5); 4.5a/4.5b/4.6 wait for the
  4.0 preflight.

### 2026-11-11 — batch 01 closed for review

- The two suites owed above were run on the 1.3 code: `npm run e2e` 21/21, `npm run a11y` clean,
  `npm run e2e:onboarding` 10/10. Review bundle with screenshots:
  [features/batch-01-review.md](../features/batch-01-review.md).
- Last completed ticket: 1.3. Stopped at the batch boundary for review; batch 02 not started.
- Blocked on Codex preflight: 4.0 A1, 5.0 A1. Awaiting Codex verification: 1.2, 1.3.
- Next ready: 4.1 and 1.5 (batch 02, the parts that need no series schema), or 6.1/6.2 (batch 04).
- Branch `codex/founder-implementation-handoff-2026-11-11`, main checkout, nothing pushed.

### 2026-11-11 — branches pushed (owner's instruction)

- `codex/founder-implementation-handoff-2026-11-11` is on origin at `b5d01f3` (batches 00 and 01), and
  `codex/deferred-waitlist-snapshot-2026-11-11` at `7aa6c48`. Earlier notes in this ledger and in the
  evidence files saying nothing was pushed describe the state before this. The
  `git switch --track origin/...` step in `IMPLEMENTATION_START_HERE.md` now works.
- The snapshot branch is pushed for safekeeping only. It is still not a base and must not be merged.
- No pull request was opened, and nothing was merged or deployed.

### Independent Codex review of batches 00 and 01

- 1.2 is ready for product review on mobile web. 1.3 requires a working text-search state and usable first-map controls at 200% text before independent sign-off.
- 4.0 A1 and 5.0 A1 are approved with required changes. Revise the briefs and return them for preflight before starting dependent schema work.
- Review findings, handoff contracts and independent checks are in [batch-01-codex-review.md](../features/batch-01-codex-review.md).


### 2026-11-12 — 1.3 review fixes

- Both 1.3 findings from the Codex review are fixed: a text search no longer shows the area notice or
  a widening, and the strip, results card and navigation no longer overlap at 200% text. Evidence in
  [features/1.3.md](../features/1.3.md#review-fixes-2026-11-12).
- `npm run check` exit 0 (1,216 tests, 0 skipped); `npm run e2e:onboarding` 13/13; `npm run e2e` 21/21;
  `npm run a11y` clean. The new checks fail with the fixes removed.
- Awaiting Codex re-verification of 1.3. Still no Safari, device or hosted run.

### 2026-11-12 — brief revisions and batch 02 (what was ready)

- **4.0 A1 and 5.0 A1 revision 2** written with every change the Codex review required (`3bd83e0`).
  Both wait for a second preflight. Until it returns, no event or outing schema work starts.
- **Batch 02.** Only the part of 4.1 that uses existing contracts was ready, and it is done:
  the editorial event page ([features/4.1.md](../features/4.1.md)). `npm run check` exit 0 (1,234
  tests, 0 skipped); `e2e:event-detail` 9/9; `e2e` 21/21; `a11y` clean; `e2e:onboarding` 13/13;
  `e2e:features` 11/11.
- **Blocked in batch 02:** the 4.1 newcomer block and 4.8 (each needs an event column), 4.5a, 4.5b,
  4.6 (the amended contract) and 1.5 (followed-series data from 4.5a).
- **Not started:** 6.2 feasibility, which the review named as independent work that can proceed.
  It is the next ready ticket.
- Stopped at the batch 02 boundary. Nothing merged or deployed; no hosted database touched.

### 2026-11-12 — independent review of 1.3, 4.1, and amendment revision 2

- The two 1.3 fixes are independently verified in Chrome (13/13 onboarding browser checks).
- The editorial event page passed 9/9 browser checks. Fix the reproduced note that incorrectly says a host is on the list after leaving. The newcomer block still needs its write contract.
- Events and Outings A1 revision 2 are approved with required changes. Keep affected schema work gated and return the targeted revisions for preflight.
- Ready now: 6.2 pure feasibility checks and the 4.1 attendance copy fix. See [the independent review](../features/batch-02-codex-review.md) for evidence and the two amendment contracts.

### 2026-11-12 — 6.2 feasibility validator

- Done: the pure validator, the stored-verdict rules and 51 tests ([features/6.2.md](../features/6.2.md)).
  `npm run check` exit 0 (1,285 tests, 0 skipped); mobile typecheck exit 0; `npm run e2e` 21/21.
- Open from the Codex review of the same day: a third targeted revision of 4.0 A1 and 5.0 A1.
- Next ready: 6.1. The commits since `e5acdd4` are local and not pushed (owner's instruction: push later).

### 2026-11-12 — 4.1 host attendance copy

- The event page keeps “You're hosting” after the host leaves. The note explains how to rejoin when there is room or why the action is disabled when the event is full.
- Verified locally on a demo build. Event detail tests passed 19/19, and Chrome passed the 9 existing event-page checks plus a one-off scripted leave-and-rejoin check. The newcomer block still needs its write contract.

### 2026-11-12 — amendments, revision 3

- 4.0 A1 and 5.0 A1 are at revision 3, with a matching note in 6.0 §5. Each makes the targeted
  changes from the second Codex review and records its decisions on the open points; the last
  section of each amendment maps every change to where it is made.
- Events: buyer account lock first in `confirm_ticket`, account lock first in `reserve_ticket` and
  the series paths; series moves planned before any write; the empty-chat check serialized against
  new messages; guard-by-guard mutation proof; post-lock expiry for new holds.
- Outings: the anchor in its own table with no direct read, event-derived fields returned only to a
  member who can read the event; no event reference on itinerary versions; no parent lock from a
  child trigger, with a fail-closed write guard instead.
- Still gated until the targeted preflight clears: 4.5a, 4.5b, 4.6, 4.8, 1.5, the 4.1 newcomer block,
  and all 5.x and 6.3 schema work. Not gated: 6.1.

### 2026-11-12 — revision 3 preflight

- Start 6.1 with migration 0095 for the limiter. The Events 0053 admission slice can proceed under its reviewed contract. Series 0054 still needs the legacy-write lock and backup-host write contracts.
- Outings and 6.3 keep their dependency gates. Shared authored plan data stays visible to members, and the event-dependent schedule is restricted by live event access. Account closure needs a complete profile-FK and guarded-cascade plan.
- The [preflight](../features/amendments-r3-codex-review.md) has the scope, acceptance criteria and tests for each decision.

### 2026-11-12 — 6.1 walking router and route-validation limit

- Done: the router interface, deterministic fake, Mapbox client (stub-tested, not live), GraphHopper
  stub, request memo, and the 60-per-user-per-hour limit in migration 0095
  ([features/6.1.md](../features/6.1.md)). Batch 04 is complete locally.
- `npm run check` exit 0 (1,333 tests, 0 skipped, with the uncommitted event-page fix in the tree);
  mobile typecheck exit 0; `npm run e2e` 21/21; the two-connection limiter race passes on local
  PostgreSQL.
- Not done from the revision 3 preflight: the targeted changes to 0054, Outings and the 6.3 read
  contract; the 0053 admission slice (cleared to start, not started).
- Not pushed (owner's instruction).

### 2026-11-13 — 0053 event admission

- Done: migration 0053 (one capacity rule on joins, reservations, confirmations and capacity edits;
  account, event, ticket lock order; post-lock clock), its demo twin, and tests
  ([features/0053-admission.md](../features/0053-admission.md)).
- `npm run check` exit 0 (1,376 tests, 0 skipped); mobile typecheck exit 0; 28/28 two-connection
  cases on local PostgreSQL including nine guard-removal proofs; `e2e` 21/21, `e2e:features` 11/11,
  `e2e:event-detail` 9/9.
- For the reviewer: one narrowing in `confirm_ticket`'s refund handler, and a one-row correction to
  the amendment's mutation table. Both are in the evidence note.
- Stopped for Codex review. 0054 not started. The event-page host-leave fix is still uncommitted and
  separate. Nothing pushed.

### Founder continuation checkpoint

- 0053 independently verified locally. The 28 controlled PostgreSQL cases, 16 admission checks and 25 payment-event checks passed. The retry handler is approved and the ticket re-read mutation target is corrected. [Verification](../features/0053-admission.md#independent-codex-verification)
- `npm run check` passed with disposable localhost PostgreSQL and a demo build (77 files, 1,378 tests, zero skipped). Mobile typecheck passed. Demo Chrome passed features 11/11 and event detail 9/9. The first golden run timed out in the Explore/save flow. A fresh run passed 21/21. Hosted Supabase and the 4.3 deadline race remain unverified.
- The handoff includes the 4.1 host-leave fix. Start 0054 by writing the series lock and backup-host permission contract. The [founder handoff](founder-fable-handoff.md) records the sequence, tests and temporary pause on independent Codex review.

