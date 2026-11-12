# Persistent implementation ledger

This file lets another founder’s agent resume without chat history. Baseline labels are dated review evidence only. Do not mark a spec or local implementation as independently verified merely because it is Must.

| Ticket | Priority | Current state | Implementation commit | Evidence / blocker |
| --- | --- | --- | --- | --- |
| [1.1](tickets/1-1-design-tokens-and-primitives.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | earlier work | [00-baseline](../features/00-baseline.md) §3; not independently verified |
| [1.2](tickets/1-2-six-interest-thumbnail-picker.md) | Must | IMPLEMENTED-LOCAL | `78b0b34` | [features/1.2.md](../features/1.2.md); no real thumbnail photos, no device run |
| [1.3](tickets/1-3-first-map-arrival.md) | Must | IMPLEMENTED-LOCAL | `29cc1ce` | [features/1.3.md](../features/1.3.md); Chrome only, no device run |
| [1.5](tickets/1-5-quiet-events-tab.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
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
| [4.0](tickets/4-0-event-foundation-specification.md) | Must | BLOCKED — amendment awaiting Codex preflight | `c06f1ad` | [4.0 Amendment A1](../features/4.0.md); blocks 4.5a, 4.5b, 4.6, 8.1b, 5.5 |
| [4.1](tickets/4-1-editorial-event-detail.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
| [4.2](tickets/4-2-structured-activity-details.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | `15f5561` | [00-baseline](../features/00-baseline.md) §3; hosted NOT VERIFIED |
| [4.3](tickets/4-3-attendance-and-readiness.md) | Must | IMPLEMENTED-LOCAL (reverified 2026-11-11) | `f2eb957` | [00-baseline](../features/00-baseline.md) §3; cron, push and the decide-vs-join race NOT VERIFIED |
| [4.5a](tickets/4-5a-recurring-series-and-host-tools.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
| [4.5b](tickets/4-5b-permanent-series-page.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
| [4.6](tickets/4-6-material-change-notifications.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
| [4.8](tickets/4-8-optional-party-poster.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 02 |
| [4.pre](tickets/4-pre-real-postgres-concurrency-harness.md) | Must | IMPLEMENTED-LOCAL (harness reverified) | earlier work | [00-baseline](../features/00-baseline.md) §3; event race suites arrive with 4.5a (4.0 A1.6) |
| [5.0](tickets/5-0-outings-specification.md) | Must | BLOCKED — amendment awaiting Codex preflight | `9c515b9` | [5.0 Amendment A1](../features/5.0.md); blocks 5.1–5.5 |
| [5.1](tickets/5-1-outing-core-and-invites.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.2](tickets/5-2-private-save-shortlist.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.3](tickets/5-3-yes-fine-cannot-lock.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.4](tickets/5-4-browser-invite-and-sign-in-return.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [5.5](tickets/5-5-start-outing-from-an-event.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 06 |
| [6.0](tickets/6-0-routing-and-feasibility-spec.md) | Must | SPEC RECONCILED (document only) | `fbd995b` | [6.0 validation note](../features/6.0.md); provider terms unconfirmed |
| [6.1](tickets/6-1-real-walking-routes.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 04 |
| [6.2](tickets/6-2-deterministic-feasibility-checks.md) | Must | NOT VERIFIED / REMAINING WORK | — | See batch 04 |
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
