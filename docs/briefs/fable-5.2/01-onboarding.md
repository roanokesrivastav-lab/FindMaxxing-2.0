# Prompt 01 — Onboarding and first useful map

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Implement the approved interest picker and clear first-map arrival without social-context redesign or persistent camera work.

## Tickets and prerequisites

Tickets: `1.2`, `1.3`.

Prerequisites: 00 foundation inventory; existing 1.1 and flags verified.

## Allowed scope

src/components/onboarding/WelcomeFlow.tsx, onboarding save/validation, Explore first-arrival state, existing UI primitives, targeted tests.

## Acceptance criteria

1. Six recognizable thumbnail rows with fallback glyphs, selected checkmarks, More interests, visible Skip and Continue to home city; zero selections allowed.
2. Every accepted selected interest is honored by first-map filtering, or the actual supported limit is explicit at selection. Fix the current 12-selected/8-applied mismatch end to end.
3. First arrival shows removable active interests and Show everything. No-results/denied-location states offer one explicit widening, never silently relax filters.
4. Preserve existing People functionality without adding the deferred social context line. Camera/selection restoration remains Later.

## Required tests

- Zero/max choices, skip, returning-user behavior, keyboard, denied location and no nearby matches through actual save + Explore paths.
- Extend the golden-journey first-save segment; mobile-width and large-text visual check; relevant accessibility check.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
