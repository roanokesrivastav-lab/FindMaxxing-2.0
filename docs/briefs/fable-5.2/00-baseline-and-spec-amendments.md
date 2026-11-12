# Prompt 00 — Baseline and remove deferred dependency assumptions

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Inventory existing work, verify rather than rebuild completed foundations, and produce independently reviewable contract amendments for the narrowed Must scope.

## Tickets and prerequisites

Tickets: `0.1 / 0.3`, `1.1`, `3.3`, `4.0`, `4.2`, `4.3`, `4.pre`, `5.0`, `6.0`.

Prerequisites: None; establish a clean checkpoint first.

## Allowed scope

Planning/evidence docs first; targeted foundation repairs only after identifying their existing ticket and scope. Read docs/features/4.0.md, 5.0.md, 6.0.md, 3.3.md, 1.1.md, 0.3.md and the staged 4.0 build prompt. Do not execute the historical broad 4.0 prompt: it includes deferred 4.4.

## Acceptance criteria

1. Record exact reviewed HEAD, dirty-file ownership, candidate migration head and any baseline failures. Preserve all staged/unrelated changes.
2. Produce a clean-baseline/integration recommendation that excludes unfinished 4.4 without deleting it. Never drop/renumber 0052 on a hosted database; if it has already been applied, document compatibility and require a new reviewed migration/rollout instead.
3. Amend the event contract for series/occurrences and attendee states without waitlists, offers or participant queues. Maintain going-only attendee semantics, one capacity definition (going + live paid holds), event-first lock order, free-full rejection, cancellation/readiness behavior and paid flow safety. Retain proven legacy writes or introduce capacity-only RPCs only where necessary, with all web/native/service writers compatible before any grant revocation.
4. Amend 5.0 dependencies so after Events means after the Must event subset, not after deferred 4.4. Verify direct-API membership/privacy and lock tests still cover the revised contract.
5. Amend 2.7 to use independent contributor authorship/moderation without 2.6 freshness machinery; remove full persistence from filter/native prerequisites while retaining preview-only map layout.
6. Validate the existing matching/provider spec as documentation only; imports remain Later. Validate routing plan-only persistence and provider restrictions. Do not make provider purchases or calls.
7. Codex preflights revised high-risk briefs before dependent implementation. Ready independent UI tickets can continue while those reviews are pending. Existing green 1.1/4.2/4.3 are reuse/verification work, not new feature builds.

## Required tests

- npm run check on the selected clean candidate; record actual results, not old test counts.
- Confirm tests/helpers/postgres.ts can supply independent connections on localhost and CI requires it. Do not run migrations against a hosted target.
- Review current security, paid-event, grants, session-rules and activity tests against the candidate. No claim that this planning-only amendment passes implementation tests.

## Observed baseline failures (planning check, 2026-11-11)

The repository verifier named 40 existing test files. Running them on the unchanged staged application checkout produced **39 files passed / 1 failed; 802 tests passed / 2 failed**. Both failures are in `tests/demo-repository.test.ts`:

- `prevents duplicate joins and enforces capacity` (line 82): a full event resolved to `waitlisted` where the existing test expected a full rejection. This confirms the staged Later 4.4 work is affecting the current demo baseline. Do not ship it implicitly or merely change the test to make a deferred feature pass.
- `preserves attendees on edit, validates capacity, cancels, and restricts deletion` (line 157): the expected `/capacity/` expression did not match `Capacity cannot be below the existing attendee count`. Review wording/contract as part of the isolated event checkpoint; do not conceal it as a green starting baseline.

No application fix was made in the planning turn. The full `npm run check`, fresh hosted checks and actual device runs were not performed. The repository-wide vexp report also flags potential import/dependent issues in pre-existing staged source; treat those as investigation leads, not verified compiler errors. See `docs/roadmap-verification-2026-11-11.md`.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
