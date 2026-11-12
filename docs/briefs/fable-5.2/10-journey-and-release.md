# Prompt 10 — Measure the whole journey and prepare release evidence

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Prove the selected end-to-end experience, measure it honestly and make separate platform release decisions.

## Tickets and prerequisites

Tickets: `8.2`, `8.3`, `8.4a/b`.

Prerequisites: All selected Must features independently reviewed; instrumentation starts earlier with first-save/outing work, not only at the final batch.

## Allowed scope

Journey e2e, consent-aware metrics, candidate/migration manifest, beta-gate and guarded staging harness; no production deploy or hosted mutation without separate existing authorization.

## Acceptance criteria

1. Golden journey: choose/skip interests → filtered map → first save → join game with room → share/invite → shortlist/vote/lock → feasible anchored itinerary → find recurring series again. Full event path shows Full without waitlist. No restore/freshness/import/post-visit assertions as Must gates.
2. Instrument time to first useful save and shortlist-to-decision early; add actual readiness cancellations, host effort and self-reported attendance. Do not instrument deferred offer acceptance as a release requirement. Respect existing analytics consent/retention/privacy.
3. Freeze exact candidate commit and actual applied/pending migration head. Update gate coverage for Must features and their real contracts; explicitly exclude unfinished 0052 if not approved for the candidate. Test all candidate migrations in order.
4. Run local check/mobile check/e2e/accessibility/feature-enabled demo, RLS/direct API and required real-Postgres races. Prepare guarded staging checks, backup/restore and auth/media/push/cron validation.
5. 8.4a prepares the gate. 8.4b executes only against an explicitly authorized staging target with required target guards; missing authorization/configuration means NOT VERIFIED. Independent release decisions for web, iOS and Android, evidence linked; never auto-deploy.
6. Create a review bundle: current screenshots, each Must row mapped to acceptance evidence, Later backlog, outstanding risks, device/hosted results and next founder-review questions. No completion score derived from questionnaire-row counts.

## Required tests

- npm run check; npm run typecheck --workspace @findmaxxing/mobile; npm run e2e; npm run a11y; npm run e2e:features with their documented deterministic demo setup.
- Full multi-role access/removed-member/anchor validity, migration/recovery evidence; authorized staging checks and actual iOS/Android proof only when configured.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
