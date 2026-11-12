# Prompt 05 — Readable map and honest filters

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Improve discovery while keeping the map preview-only and deferring persistent navigation-state work.

## Tickets and prerequisites

Tickets: `2.1`, `2.4a`, `2.4b`, `4.7`.

Prerequisites: 1.1/1.3; 4.2/4.3; 6.1 adapter for actual travel-time calculations. Full 2.2 restoration is explicitly not a prerequisite.

## Allowed scope

ExploreClient/discovery routes/repositories, MapCanvas/Mapbox/MapLibre pin rendering, venue sessions, current-surface UI only, focused tests.

## Acceptance criteria

1. Authorized clusters on both map renderers; zoom-to-bounds, exact-coordinate 1-of-N selected-preview cycling, honest partial counts, keyboard/reduced-motion support.
2. No results list or bottom list panel on the map tab at any width. Move desktop/native result lists into separate results mode as a minimal layout correction, without implementing URL/camera/scroll restoration from 2.2.
3. When/Area/Activity controls replace the chip wall. Time filters use correct viewer/event zones. Travel time uses configured walking calculations; fake estimates only in clearly labeled demo, unknown/not configured states honest elsewhere. No silent filter relaxation.
4. Has room is the default availability filter option, based on current admission capacity and paid holds; do not substitute or add a Needs players filter. Beginner-friendly uses real structured data and missing-data handling is explicit.
5. Place mode icon/name-on-select, event mode start time, pickup open spots, dense count; venue page lists upcoming visible sessions. No waitlist/offer facts assumed.

## Required tests

- Authorized/hidden/capped/co-located discovery cases and server/client consistency; availability including live/expired paid holds and full/cancelled/ended events.
- Time zones, denied location, travel adapter unknown/timeout, missing activity fields, honest empty states, both map renderers and keyboard.
- Mobile + desktop no-list-on-map check and pin/venue activity flow; do not require deferred restoration tests.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
