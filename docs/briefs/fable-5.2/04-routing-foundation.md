# Prompt 04 — Walking adapter and deterministic feasibility

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Build the reliable routing and constraint contracts used by travel filters and eventual shared itineraries.

## Tickets and prerequisites

Tickets: `6.1`, `6.2`.

Prerequisites: 00 routing spec revalidated; no outing UI needed for these pure/adapted foundations.

## Allowed scope

src/server/trips, pure shared feasibility/time-zone modules, configured walking adapter and fake, per-request memo/rate limit, focused tests. Read docs/features/6.0.md.

## Acceptance criteria

1. WalkingRouter has configured provider/fake/unknown/timeout behavior; fake is deterministic and labels demo results. No keys or real calls. No straight-line shortcut is passed off as a measured walking route.
2. For tentative Mapbox walking, persist only our plan/verdict; never provider durations/distances/geometry. Per-request memo only; revalidate on open. GraphHopper is a documented fallback, not an automatically deployed service.
3. Pure validator handles fixed/flexible stops, event zone, overnight windows, both DST transitions, duration/break/walking constraints and unknown hours. Defaults from 6.0: 30 minutes per leg, 90 total; configurable later in editor.
4. A 6 PM reservation reached at 6:20 is infeasible. Unknown routing/hours stays uncertain; failed recalculation preserves the last valid plan without relabeling it current. Provider payloads cannot be injected into persisted itinerary data.

## Required tests

- Fake barrier/river/island/unreachable route fixtures; timeout/not-configured; rate limits and no durable provider cache/payload acceptance.
- Frozen-clock fixed-time, overnight and DST matrix; hidden venue; walking/break limits; deterministic fallback/uncertainty; real planner contract tests when wired later.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
