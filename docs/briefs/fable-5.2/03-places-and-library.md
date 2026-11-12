# Prompt 03 — Places and a useful private library

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Help people decide where to go, keep their own reasons, and act on their saved places.

## Tickets and prerequisites

Tickets: `2.5`, `2.7`, `2.8`, `3.1`, `3.2`, `3.6`.

Prerequisites: 00 foundation and scoped attribution amendment; 1.1 primitives. No dependency on deferred 2.6 or import implementation.

## Allowed scope

Place pages/reviews/media, save actions and library, shared types, authorized photo route/upload pipeline, owner-only data/schema, repositories and demo. 3.3 remains a retained/verified specification only.

## Acceptance criteria

1. Photo-first page with complete fallback; rating next to count; actual friends’ reviews first then community; personal fit/friends/community separate and sponsored distinct. Unknown hours/travel are labeled. Claims link to evidence that exists; no fake recent/confirmed tip claim.
2. Best for / Less suited uses small occasion choices plus contributor text, author attribution, multiple opinions, see-all and moderation. Minimal authorship is in scope; confirmation history, freshness, correction workflow and expiry from 2.6 remain Later.
3. Public photo records team/permission provenance. Separate owner-only personal photo for first rating/review, library allowed, using existing secure upload/delivery. Save/join/plan/bulk Visited never require that photo. Friend-posted media is visible only when deliberately shared.
4. One-tap save asks nothing; optional later organization stores owner-only note/tags/source/recommender/want-to-go/visited. Show Only you. Use deterministic suggestions from the place’s existing category/tags, dismissible and never an invented experience.
5. Library supports search, tag/status/category filters, pagination at 500 saves, bulk tag/list/Visited/remove, undo for every bulk action, and owner CSV/JSON export. User text exported to CSV must be escaped against formula execution.
6. Pick somewhere uses only the viewer’s filtered saves, with Pick again/Open/Directions and explicit empty-state widening. Proposed default: choose from the matching set without replacement until exhausted; do not invent open-now facts. Test deterministically with injected selection.

## Required tests

- RLS/direct API as owner, other user, friend, outing member and anonymous; private fields/media never in public responses, shares, notifications or recommendations.
- First-rating photo enforcement including existing ratings and retries; never blocks save/join/Visited; upload limits/metadata/delivery, moderation and account deletion.
- Bulk undo consistency/ownership, export privacy and formula-escaping, pagination, picker empty/one/no-match, demo parity; browser save/library/photo/reviews flows and accessibility.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
