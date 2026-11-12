# Prompt 06 — Shared decisions after the Must Events release

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Let friends invite, shortlist, express constraints and lock a choice without exposing their private collections.

## Tickets and prerequisites

Tickets: `5.1`, `5.2`, `5.3`, `5.4`, `5.5`.

Prerequisites: Must Events subset independently verified; 3.1; revised 5.0 preflight. 4.4 is not a prerequisite.

## Allowed scope

Approved outings-spec batches, RLS/RPCs, public-place shortlist, invite landing/auth return, event anchors, notifications and outing chat. Use 5.0’s recommended defaults unless amended in 00.

## Acceptance criteria

1. Revocable hashed invite links, seven-day default expiry (1–14), up to 12 members, roles/removal and no joining after lock. Signed-out invite returns to the right outing after sign-in; expired/revoked links reveal no private data.
2. Shortlist only permitted public published places: place ID + deliberate fresh shared reason; never source private note/tag/list. Two items to open voting, twelve max; hidden/removed place access updates propagate.
3. One current Yes/Fine/Can’t vote per member/item; hard dietary/accessibility/budget constraints veto; deadline and atomic host lock. No automatic winner for tie/all-vetoed, notify host instead. Recommended one logged reopen.
4. Event-anchor creation stores occurrence ID/zone/fixed time; moved/cancelled anchor flags outing and notifies only authorized recipients. Follow does not equal RSVP.
5. Removed/blocked members lose pages/APIs/polling/chat/notification access. Polling only while visible; no private data in tokens/previews or logs.

## Required tests

- All §11 tests in the amended docs/features/5.0.md, including eight real-Postgres races: lock/vote, lock/add, two locks, sweep/manual lock, claim/revoke, last member slot, removal/vote, anchor update/create. Multi-role direct API attack matrix, privacy, expiry/DST, demo parity; three-friend five-suggestion-to-lock browser journey.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
