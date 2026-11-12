# Prompt 08 — Fresh local information and weekly memories

Copy-ready instruction: **Follow `docs/briefs/fable-5.2/README.md`, then execute this batch.** Read the common contract before implementation.

## Objective

Add the selected return-loop features without implementing deferred freshness infrastructure or post-visit prompts.

## Tickets and prerequisites

Tickets: `7.1`, `7.2`, `7.4`, `R4`.

Prerequisites: Places/attribution and Events implemented; R4 also needs outings, private-photo boundaries and explicit self-reported attendance.

## Allowed scope

Local guide/report data and surfaces, explicit helpful feedback, opt-in weekly memory spec + implementation, relevant cron/privacy/deletion flows. Spec R4 first; new high-risk boundaries need Codex preflight.

## Acceptance criteria

1. Flash maps have named curator, bounded neighborhood, start/end, auto-archive and past-edition labels; curator maintains content without an engineer.
2. Live pilot reports only queue length, court/seat availability and temporary closure; observed_at/expiry/corrections, authorization and abuse limits. No reports means unknown. Report-specific expiry is in scope; the deferred generic tip freshness system is not.
3. Contributor feedback is based on explicit unique helpful actions on attributed contributions (such as 2.7 occasion notes), not a claim that an impression helped someone. Exclude self/duplicate/abusive feedback; private contributor aggregate, no cash/volume leaderboard. No post-visit prompt or generic tip-confirmation pipeline.
4. R4 spec covers weekly boundary/time zone, opt-in, audience, retention/deletion, content withdrawal/moderation, attendance evidence and access revocation. Only self-reported attended outings/sessions and deliberately shared own posts/photos/reviews are eligible. An RSVP/directions tap alone is not attendance.
5. Never include personal private photos, private notes or unposted content in a recap. A recap creates no broader audience or automatic public share. Co-members’ content must retain its own audience and explicit sharing contract; withdrawn/hidden/deleted content is removed. No summaries of friends’ opinions.

## Required tests

- Frozen-clock report/guide expiry, scope/role/rate-limit checks, honest unknowns, curator maintenance and demo parity.
- Helpful-counter dedupe/self-exclusion/permissions; no fabricated counts.
- R4 privacy matrix across owner/friend/member/removed/blocked/anonymous, opt-out/withdrawal/deletion, weekly DST boundary, no-RSVP inference, idempotent regeneration and no private media leakage.

## Do not change

Do not implement any Later row: 1.4, 2.2 persistence, 2.6, 3.4a, 3.4b, 3.5, 4.4, 7.3, R2, R3 or X1–X4. Do not delete existing functionality/in-flight work, rewrite applied migrations, weaken authorization or change founder priorities. Common-contract privacy/payment/flag/provider restrictions apply.

## Checkpoint and required report

Complete and verify each ticket separately, update its evidence note and commit under existing authorization. Continue within this batch only when prerequisites are verified. Stop dependent work if required proof is unavailable; record the blocker and proceed only to an independent selected ticket. At batch end provide: changed files/commits, criterion-to-evidence mapping, exact test commands/results, adversarial findings and fixes, remaining device/staging limits and independent-review readiness. Stop before the next numbered batch.
