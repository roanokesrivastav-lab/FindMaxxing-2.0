# Prompt 02 — Complete the Must Events product

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Deliver recurring sessions and clear participant/host experiences without implementing waitlists or expiring offers.

## Tickets and prerequisites

Tickets: `4.1`, `4.5a`, `4.5b`, `4.6`, `4.8`, `1.5`.

Resume at 0054 under the [current founder handoff](../../implementation/founder-fable-handoff.md). The 0053 admission slice and existing 4.2/4.3 code are on the branch. Prove the remaining 4.3 deadline race before closing the Must Events gate.

## Allowed scope

Event pages/forms/cards, shared event types, repositories/demo twins, event migrations/cron, notifications and series UI. Read revised 4.0 and existing paid-event repair notes. Implement 4.5a before series-dependent 4.5b/4.6/1.5; keep each ticket separate.

## Acceptance criteria

1. Event detail uses Local editorial with date/time/zone, meeting point, host, cost, capacity, requirements and one honest action. Host-entered newcomer fields sit near Join. Paid events never say free.
2. Full free sessions show Full and reject admission atomically; no waitlist/offer UI, queue schema, offer notifications or expiry scheduler. Existing staged 0052 is not included silently.
3. Series support owner/backup hosts, four-week occurrence generation, event-zone DST semantics, edit-this/edit-future, cancel one/end series, and revocation/moderation. Stable occurrence IDs and independent attendance; define explicit self-reported attendance needed by memories without deferred queue states.
4. Series page shows next confirmed/pending status honestly, past sessions, hosts, newcomer note and follow. Following sends permitted updates and never RSVPs.
5. Time/venue/cancellation/schedule changes reach only affected attendees/followers, deduplicated and respecting mutes/quiet hours/blocks. Exclude offer-related types. Service/cron changes cannot bypass notifications.
6. Party poster is host-controlled and off by default; price/full/cancelled remain visible, and no-photo/long-title/large-text states work.
7. Quiet Events tab leads with joined sessions and upcoming sessions of explicitly followed series as the proposed usually-go-to rule. Label following vs going distinctly, keep Browse available, and use Today/Tomorrow/This weekend/Later flat expandable rows. No behavioral attendance inference or social context line.

## Required tests

- Real-Postgres last-seat joins/paid holds/capacity edits and relevant series-edit/generator/cancellation races under the amended contract; direct-write bypass/legacy-client checks. Waitlist race suites are not acceptance for this release.
- DST spring/fall, cancel one occurrence leaves next intact, edit future, revoked/backup host permissions, notification recipient/dedupe and cron-origin tests.
- Host-only poster toggle/default off, newcomer field validation, paid copy, missing readiness values, demo parity; browser join/full/series/follow flow and accessibility.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
