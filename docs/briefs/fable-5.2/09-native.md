# Prompt 09 — Native parity for the selected journey

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Implement selected native parity while excluding deferred camera restore and offer UI.

## Tickets and prerequisites

Tickets: `8.1a`, `8.1b`, `8.1c–e`.

Prerequisites: Verified web/database contracts for each native flow; native join safety must be coordinated before any incompatible server migration is released.

## Allowed scope

apps/mobile routing/screens/session/data/media/push/deep-link code and shared contracts; installed Expo SDK guidance; no broad SDK upgrade.

## Acceptance criteria

1. Explore has event/place pins, selected preview and separate results mode, denied-location handling and accessible co-located selection; full cross-navigation camera/selection restoration is Later.
2. Native join/leave uses the approved capacity-only contract where RPCs are required and is compatible with web and paid fulfillment. Full means Full; no waitlist/offer actions or background offer-expiry implementation.
3. Native shortlist/vote/lock and signed-out invite → sign-in → intended outing work; removed members and expired/revoked invites are denied after relaunch.
4. Read-only agreed itinerary shows current/stale/invalid state; moved/cancelled game and membership loss update access. Authorized personal-photo delivery/gallery must honor the selected photo contract.
5. Address existing secure storage, sign-out push cleanup, upload handling, session hydration/account switching and push readiness blockers within explicitly scoped tickets. Profile editing/settings/tickets/Plus remain web-only unless separately scoped; do not invent parity commitments beyond the selected rows.
6. Record iOS and Android runtime evidence separately. Unavailable devices mean NOT VERIFIED, never substitute an Expo web export or screenshots of reconstructed native screens.

## Required tests

- npm run typecheck --workspace @findmaxxing/mobile; affected shared/mobile privacy/auth/upload/push tests and API contracts.
- Real web/native last-seat race and permissions; real-device cold launch, account switch, deep links, background/return, photo upload/delivery, signed-out push behavior and accessibility. No deferred offer-expiry acceptance.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
