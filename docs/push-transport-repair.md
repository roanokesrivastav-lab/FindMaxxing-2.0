# Push transport readiness repair — batch 4

Repairs audit F9, after completing batch 3's local test/build milestone.
Preflight: **approved with required changes**: separate opt-in from readiness,
and retain unsendable work rather than merely removing the VAPID gate. Astra's
audit defines scope; no separate Claude implementation brief was available.

## Contract and changes

- Objective: Expo-only, browser-only, mixed, and disabled configurations behave
  correctly without consuming a transport that cannot send.
- Scope: runtime readiness, browser registration/settings gating, notification
  cron/senders, claim adapters and demo parity, migration `0029`, tests, and env
  documentation. No native screens, push provider boundaries, notification
  preferences, product caps, dependencies, hosted data, or deployments changed.
- Acceptance: Expo needs no browser VAPID keys; web still needs both keys; disabled
  push claims nothing; an unready kind stays pending; mixed devices can receive
  the ready kind now and the remaining kind later, with no resend or second cap
  charge. Quiet hours, permission boundaries, gone-device handling and expiration
  must remain intact. Test the actual cron path, not just sender helpers.

`featureEnabled('push')` now represents global opt-in. `pushTransportReady` checks
browser credentials separately; Expo remains independently available, with its
existing optional server-only access token. Browser settings/registration still
require both VAPID keys. Cron constructs only the ready senders; each sender
declares which device kinds it can handle.

Migration `0029_push_transport_readiness.sql` adds server-controlled
`push_claimed_kinds` to notifications and a service-only transport-aware claim
RPC. Only eligible, unclaimed device kinds are returned. Other kinds remain
pending, even on a notification already sent to one channel. The daily cap logs
the notification once, not once per transport. Unsendable oldest entries are
filtered before the batch limit so they do not starve eligible work. The previous
service-only RPC remains a compatibility wrapper; existing applied migrations
are unchanged. Ordinary users cannot update claim markers. The demo adapter
mirrors transport selection, cap accounting, quiet hours and expiry.

The existing **at-most-once** policy is retained: a ready kind is marked claimed
before its external send, so crashes/provider failures can still miss delivery.
This batch fixes unavailable-transport consumption, not general delivery retry
or receipt tracking. Pending unsendable work remains subject to the existing
24-hour expiry and user preferences. Provider acceptance is not proof of device
delivery. Real Expo push receipt collection remains a separate reliability task.

## Verification and adversarial review

- 16 new tests passed across two files.
- Focused push/notification checks: 42 tests passed across three files.
- Mobile type-check and Expo web export passed; no native source was edited.
- Final integrated checks are recorded below.

Coverage includes no VAPID/partial VAPID/full VAPID, `all`/disabled opt-in,
browser-only and Expo-only recipients, mixed recipients with staged readiness,
actual cron invocation and authorization, real Expo adapter with stubbed HTTP,
no-send/empty readiness, failure accounting, oldest-queue fairness, cap-once
accounting, quiet hours, expiry, caller permission denial, and claim-marker write
denial. Existing browser registration and push SSRF tests remain required.

The failure-focused review specifically looked for a ready Expo sender causing
browser work to be marked sent, mixed-channel resends, cap duplication, queue
starvation, direct RPC bypass, and stale pre-migration state. The per-kind claim
markers address these cases. The Expo networking skill guided the server-only
credential boundary and failure-path verification; it did not cause a native
rewrite or a new transport/provider integration.

## Final integrated gate — 2026-10-14

| Check | Result |
| --- | --- |
| Full tests | Passed: 43 files, 813 tests (46 new in batches 3–4) |
| Web type-check | Passed, rerun after the final production build |
| Lint | Passed |
| Production build | Passed with Webpack, isolated demo configuration |
| Browser end-to-end | Passed: 19/19, fresh demo store and scratch uploads |
| Accessibility | Passed: 15 pages, zero issues; keyboard focus test passed |
| Mobile type-check / Expo web export | Both passed; not proof of native-device behavior |
| Whitespace / scope review | Passed; changes confined to audited repair components |

The default Turbopack command was not rerun: previous audit/batch 1 attempts,
including escalated execution, were blocked by local port-binding `EPERM`.
Webpack success does not establish that the default build passes; CI must check
that command. Existing audit findings F1–F9 now have local repairs across batches
1–4, but their hosted/native release checks and the broader audit follow-ups are
not complete. **Ready for user code review; production release remains unapproved.**

## Rollout and outstanding checks

1. Apply migrations through `0029` to disposable staging before deploying this
   application version. Preserve claim RPC grants and notification column grants.
2. With `notifications,push` opted in, register a real Expo device without VAPID
   and verify service acceptance plus a device receipt. Restore browser VAPID and
   verify delayed web work reaches a real browser without repeating Expo work.
3. Verify disabled opt-in, both transports, a missing browser key, quiet hours,
   expiry, and simultaneous claims on real multi-connection Postgres.
4. Keep `CRON_SECRET`/scheduler operational. No new feature default is enabled.
   Review existing at-most-once send loss and Expo receipt handling separately;
   do not interpret a successful HTTP cron response as every device receiving it.

No real push was sent, hosted migration applied, or application deployed. Native
iOS/Android delivery and hosted concurrency are unverified. vexp was unavailable;
review used direct source/diff inspection and regression tests. Service reference:
[Expo Push Service contracts and receipts](https://docs.expo.dev/push-notifications/sending-notifications/).

## Follow-up self-review — 2026-10-14

Re-inspected readiness, per-kind claims, role/column grants, mixed queue recovery,
cap accounting, expiry, quiet hours and sender failure behavior. Focused combined
review tests passed; no additional confirmed batch 4 defect was found. The native
client still needs separately scoped registration/logout/device verification;
server-side readiness success does not close that migration gap. Current release
status and evidence are in `release-mobile-verification.md`.
