# Prompt 07 — A plan the group can reopen and edit

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Generate a checked, versioned plan from the locked outing and preserve its fixed event commitment.

## Tickets and prerequisites

Tickets: `6.3`, `6.4`.

Prerequisites: 6.1/6.2; 5.3/5.5 and stable occurrence contract independently verified.

## Allowed scope

Existing AI planner/tools/actions, outing itinerary storage/RLS/invalidation, shared editor and deterministic fake model/router.

## Acceptance criteria

1. AI proposes order; software computes/verifies feasibility in outing/event zone. Only a locked authorized shortlist is used. No fixed New York or non-walking fallback.
2. Persist our plan/verdict with append-only versions, author and fixed anchor, not restricted provider results. A second current member reopens the same plan after refresh and revalidation.
3. Moving/cancelling the anchor or losing venue access invalidates the plan through the actual event mutation contract; removed member loses both page and API access.
4. Pin a reservation, reorder, drop optional stop, change limits and recalculate with explicit conflict/uncertainty messages. Every save is a new version. Concurrent saves cannot silently overwrite a newer version.
5. One deterministic/AI repair attempt per spec, then show constraint/suggested edit. Failures preserve the prior saved version and label stale validation honestly.

## Required tests

- All 6.0 §8 cases plus real action/RPC permission/version conflict tests, anchor-update invalidation and removed-member tests; private-save/provider-payload exclusions.
- Browser second-member refresh/edit/conflict journey; deterministic provider/model fakes, DST/fixed-anchor cases and demo parity.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
