# Independent audit — 2026-10-13

## Decision and scope

**Repair preflight: Approved with required changes. Release readiness: not approved.**

Audited working tree at commit `91aa607`, using `docs/audit-baseline.md`, `docs/audit-handoff.md`, repository instructions, implementation code, migrations, tests, and CI configuration. The two input audit documents were already untracked; they were preserved. No application code, migrations, existing tests, dependencies, or configuration were changed. This report is the only repository file added by this audit. Generated build/browser artifacts are ignored by Git.

This was a risk-focused repository audit, with detailed review of auth redirects, account deletion, Storage delivery, payment actions/webhooks/refunds, messaging permissions, push delivery, and mobile data/session paths. It is not a claim that every line or every feature has been exhaustively verified. No separate Claude implementation brief or authoritative feature-completion checklist was supplied. The existing handoff defines audit scope, but cannot establish that every promised feature is complete.

Nine findings are listed below: six P1/high and three P2/medium. P1 means repair before exposing the affected feature to real users; P2 means an important correctness/privacy issue to include in the repair cycle. None is claimed to be an observed production incident. Payment/push findings require the relevant features to be enabled.

## Verification performed

| Check | Result in this audit |
| --- | --- |
| Web type-check | Passed: `npm run typecheck` |
| Lint | Passed: `npm run lint` |
| Existing tests | Passed: 31 files, 643 tests; includes embedded Postgres with all numbered migrations |
| Default production build | Environment-blocked: Turbopack failed while binding a local port (`EPERM`), including the escalated attempt |
| Alternate production build | Passed: `npm run build -- --webpack`, including font fetches and TypeScript |
| Isolated demo build | Passed with Supabase public variables and feature flags explicitly empty, using Webpack |
| Browser end-to-end | Passed: 19/19, `npm run e2e`, isolated demo data |
| Accessibility | Passed: 15 pages, zero serious/critical or other violations; keyboard focus test passed |
| Mobile type-check | Passed: `npm run typecheck --workspace @findmaxxing/mobile` |
| Mobile web export | Passed: `npm run export:web --workspace @findmaxxing/mobile` |
| Additional adversarial probes | 9/9 reproduced the asserted broken behavior; see evidence below |
| Live Supabase/Stripe, native devices | Not run |

The prior baseline's Google Fonts failure is **not a confirmed application defect**: fonts and the production build worked with Webpack in this audit. The default Turbopack build still needs verification on an unrestricted machine or CI. The successful alternate build does not prove that the default command passes.

The browser suites initially failed to bind their local ports in the sandbox, then passed with escalated execution. Their successful run used demo mode with feature flags empty, so it is not an end-to-end test of paid features, live push, or hosted Supabase. No real user records, payment transactions, or deployed systems were mutated. Existing installed dependencies were used; a fresh `npm ci` was not performed.

## Confirmed findings

### F1 — P1: Storage owners cannot complete account deletion

- **Evidence:** `src/server/accountDeletion.ts:62` calls `admin.auth.admin.deleteUser()` before the Storage removals at lines 71–72. An Auth deletion error throws immediately, so cleanup never runs. The Storage upload path uses the signed-in user's client (`src/lib/data/supabase/repository.ts:1816`).
- **Reproduction:** In a disposable Supabase project, create an account, upload an avatar or place photo as that account, then request account deletion with its correct password. The implementation attempts Auth deletion while that user still owns Storage objects. Locally, a test double enforcing this documented restriction made `deleteAccount()` throw and verified that `storage.remove()` was never called.
- **Root cause:** The deletion sequence conflicts with Supabase's ownership restriction. The embedded database helper models `storage.objects` as a minimal table and does not implement the Auth service's Storage-ownership check, so existing cascade tests cannot detect this.
- **Required fix:** Design a retryable deletion workflow that handles owned Storage objects before Auth deletion, preserves the full cleanup manifest, and records partial progress. Do not simply reorder irreversible operations without handling partial failure. Stop silently replacing failed object listings with empty arrays.
- **Acceptance/tests:** A user with an avatar, attached photos, unattached uploads, and more than one listing page can delete their account. Inject list/remove/Auth failures and retry without losing cleanup information or claiming a complete deletion prematurely. Verify with real Supabase Auth and Storage, not only PGlite.
- **Confidence:** Confirmed code/contract mismatch and local failure-path reproduction; hosted integration reproduction remains required. [Supabase user-deletion documentation](https://supabase.com/docs/guides/auth/managing-user-data#deleting-users) states that a user owning Storage objects cannot be deleted.

### F2 — P1: Deleting a host account bypasses ticket refunds

- **Evidence:** `supabase/migrations/0012_account_deletion.sql:26` cascades a deleted profile into its events. `0022_payments.sql:34` sets ticket `event_id` to null. The refund trigger at `0022_payments.sql:285` handles only status updates, not deletion. Demo deletion similarly clears `eventId` without queuing a refund (`src/lib/data/demo/account.ts:63`).
- **Reproduction:** Create a future paid event; reserve and confirm a buyer's $15 ticket; delete the host's Auth row through the deletion cascade. The isolated database probe returned `{event_id: null, status: 'paid'}` for the ticket and an empty `tickets_to_refund()` result.
- **Root cause:** Payment cancellation rules were added after account-deletion cascades, but deletion was never integrated into the refund lifecycle. The refund job only sees `refund_pending` tickets.
- **Required fix:** Before removal of a future paid event, durably queue its refunds and expire pending holds. Preserve payment identifiers through account/event deletion. Mirror the behavior in demo mode. Distinguish future canceled service from historical events that were already delivered.
- **Acceptance/tests:** Delete a host with future paid events, expired/pending holds, already-refunded tickets, and completed historical events. Eligible buyers receive exactly one refund; retries and concurrent webhooks do not lose or duplicate obligations. Preserve anonymized payment records.
- **Confidence:** Confirmed by executing the actual migrations and payment functions in PGlite.

### F3 — P1: Account deletion removes subscription records without canceling Stripe billing

- **Evidence:** `src/server/accountDeletion.ts` performs password verification, Supabase deletion, and Storage cleanup, but no Stripe subscription cancellation or durable billing cleanup. `0022_payments.sql:50` and `:55` cascade-delete customer and entitlement mappings. `src/components/profile/DeleteAccount.tsx:33` tells the user their plan is deleted. There is no subscription-cancellation call in the server source.
- **Reproduction:** In Stripe test mode, subscribe a user with no Storage uploads, then delete that account through settings. Local customer/entitlement records disappear while the implementation sends no cancellation to Stripe; the remote subscription can continue renewing, and the deleted user can no longer access the in-app billing portal.
- **Root cause:** Local account deletion treats deletion of subscription metadata as termination of a separately managed billing agreement.
- **Required fix:** Integrate subscription cancellation or a durable, retryable billing-closure process before destroying its identifiers. Handle late webhooks for deleted users without restoring access or retrying permanently against missing foreign keys. Make deletion messaging match the actual billing outcome.
- **Acceptance/tests:** With an active test subscription, account deletion prevents future renewals. Inject a Stripe timeout, retry deletion, deliver late subscription/invoice events, and verify no double cancellation, lost billing identifiers, or restored entitlement. Existing payment history must remain available as intended.
- **Confidence:** Confirmed missing lifecycle step by tracing the complete deletion path and schema. Remote renewal was not executed; this must be verified in Stripe test mode.

### F4 — P1: Duplicate or out-of-order subscription webhooks overwrite newer state

- **Evidence:** `src/server/payments/webhook.ts:64` writes the supplied subscription state before recording/checking the event ID at lines 89–90. `set_entitlement` unconditionally upserts the new snapshot (`0022_payments.sql:345`).
- **Reproduction:** Process an active subscription update, process its cancellation, then replay the original active event. The probe returned `duplicate:plan_active` and left the entitlement `active` again.
- **Root cause:** Event recording is used as an after-the-fact label, not a processing guard; subscription snapshots are applied without reconciling current remote state. A different delayed event can also overwrite current state even after duplicate IDs are handled.
- **Required fix:** Make event processing retry-safe and concurrency-safe with an atomic processing/state strategy, and reconcile subscription state against authoritative Stripe data. Simply recording the event first can lose updates if processing then crashes; ordering solely by second-resolution event timestamps is insufficient.
- **Acceptance/tests:** Active → canceled → replay active remains canceled; reversed delivery order, concurrent delivery, failure between processing stages, and events for old versus current subscriptions all converge on current Stripe state. The event ledger must not mark incomplete processing as complete.
- **Confidence:** Reproduced with the real webhook handler and isolated demo repository. The Supabase repository calls the corresponding unconditional SQL upsert. [Stripe documents retries, duplicates, and unordered delivery](https://docs.stripe.com/webhooks#event-ordering).

### F5 — P1: Unpaid checkouts grant tickets and activate campaigns

- **Evidence:** `src/server/payments/webhook.ts:27` handles `checkout.session.completed` without checking `payment_status`. Lines 31 and 40 activate campaigns or confirm tickets. Async payment success/failure event types are not handled. Checkout creation does not explicitly restrict the integration to immediate payment methods.
- **Reproduction:** Reserve a $15 ticket and attach its session, then deliver a completed-session fixture with the correct amount, a payment intent, and `payment_status: 'unpaid'`. The real handler returned `confirmed`, marked the ticket `paid`, and added the buyer to attendance. The campaign branch has the same missing payment-state gate.
- **Root cause:** Completion of the checkout UI is treated as settlement of the payment. Stripe exposes those as separate states.
- **Required fix:** Fulfill only after the payment is confirmed successful. Either explicitly restrict supported methods appropriately or implement delayed success/failure handling with safe reservation and refund behavior.
- **Acceptance/tests:** Completed/unpaid grants no ticket and activates no campaign; delayed success fulfills once; delayed failure does not fulfill; duplicates, expired holds, mismatched amounts, and canceled events remain safe. Include valid `payment_status` in fixtures.
- **Confidence:** Confirmed by handler execution. Deployment exposure depends on enabled payment methods. [Stripe's session reference](https://docs.stripe.com/api/checkout/sessions/object) explicitly separates `status: complete` from `payment_status: paid`.

### F6 — P1: Push subscriptions permit arbitrary server-side HTTPS targets

- **Evidence:** `save_push_subscription` in `0021_notifications.sql:322` accepts arbitrary HTTPS endpoints. The later device constraint in `0024_expo_push.sql` retains that rule. `src/server/actions/notifications.ts` checks URL syntax only, and `src/server/notifications/push.ts:58` passes the endpoint directly to `web-push`. Direct authenticated RPC access bypasses the server action entirely.
- **Reproduction:** As an ordinary user, register `https://127.0.0.1:8443/internal` through the subscription RPC; the database accepts it. With valid locally generated subscription and VAPID keys, the installed `web-push` library constructs a POST request to that endpoint. A notification would route that request through the server's push job.
- **Root cause:** A client-controlled outbound destination is trusted at the send boundary. HTTPS alone does not establish that a destination is a public push provider.
- **Required fix:** Validate destinations at delivery, using a carefully maintained push-provider policy or equivalent public-network egress protection that handles DNS resolution, IPv4/IPv6, ports, and redirects. Enforce compatible restrictions at registration too; previously stored rows must not bypass the fix.
- **Acceptance/tests:** Reject loopback, private, link-local, encoded-IP, credential-bearing and disallowed-port targets, including a domain resolving to a private address. Accepted provider subscriptions must still deliver. Test the RPC path and the send path independently.
- **Confidence:** Confirmed accepted input and request-construction path. No request was sent to a real internal service. Reachability and further impact depend on deployment networking and TLS; this audit does not claim response-body extraction.

### F7 — P2: Auth callback permits an external redirect using a backslash

- **Evidence:** `src/app/auth/callback/route.ts:12` rejects `//` but accepts `/\evil.example`; line 18 resolves it using the WHATWG URL parser. Similar prefix-only checks appear in auth actions/pages.
- **Reproduction:** Call `/auth/callback?code=<valid-code>&next=%2F%5Cevil.example`. In the route probe, with only the successful code exchange stubbed, the returned `Location` was `https://evil.example/`.
- **Root cause:** String-prefix validation does not match the URL parser's normalization of backslashes for HTTP(S).
- **Required fix:** Centralize same-origin redirect validation using parsed origin comparison and explicit rejection/normalization rules. Apply it to all auth entry points.
- **Acceptance/tests:** Ordinary relative paths, query strings, and fragments work; backslashes, protocol-relative paths, control characters, and encoded variants cannot produce a different origin. Verify the actual redirect response. This finding does not establish token theft.
- **Confidence:** Confirmed against the actual route with successful auth exchange mocked.

### F8 — P2: Publicly callable helper functions disclose private block relationships

- **Evidence:** `supabase/migrations/0020_messaging.sql:76` and `:81` define `is_blocked_between(a,b)` and `has_blocked(a,b)` as security-definer functions. Lines 88–90 grant authenticated users execution without binding either subject to the caller. The `blocks` table itself only reveals a caller's own blocks.
- **Reproduction:** User A blocks B. As unrelated user C, selecting A's block rows returns no rows, but `select public.has_blocked(A,B)` returns true. The database probe reproduced both responses.
- **Root cause:** Internal helpers bypass RLS and are exposed as unrestricted public-schema RPCs, defeating the table's privacy boundary.
- **Required fix:** Restrict the externally callable surface or separate private internal helpers from caller-bound queries. Preserve legitimate policy, moderation, notification, and service-role behavior; adding a naive caller restriction can break internal calls.
- **Acceptance/tests:** An unrelated authenticated user cannot query any other pair's block status through either helper or wrapper. Existing blocked-message enforcement, member visibility, notification suppression, and moderator workflows continue to work.
- **Confidence:** Confirmed under authenticated roles in the actual migrated database.

### F9 — P2: Expo push is disabled unless browser VAPID credentials exist

- **Evidence:** `src/app/api/cron/notifications/route.ts:29` wraps both senders in `featureEnabled('push')`. `src/lib/config.ts:78` requires both VAPID keys for that flag, although `expoPushSender` does not use those keys.
- **Reproduction:** Configure Expo devices and `NEXT_PUBLIC_FEATURES=notifications,push` without VAPID keys. `featureEnabled('push')` returns false and the cron passes a null sender, so no Expo pushes are claimed or delivered. The gate behavior was reproduced locally.
- **Root cause:** A browser transport's credential requirement is applied to both browser and native transports.
- **Required fix:** Separate the global opt-in from per-transport readiness. Do not claim and discard notifications for a transport that cannot send.
- **Acceptance/tests:** Expo-only configuration delivers without VAPID; browser-only and mixed configurations work; disabling the feature prevents delivery. Missing credentials do not silently consume the wrong devices' notifications. Test through the cron route as well as individual sender functions.
- **Confidence:** Confirmed configuration/control-flow defect; a real-device delivery was not attempted.

## Other risks and incomplete coverage

These are follow-up targets, not additional fully reproduced findings:

- **Native migration gaps:** place mapping sets `photos: []` and the place screen renders no photo gallery; mobile uploads raw JPEG bytes directly instead of using the web image-normalization/metadata-stripping pipeline; mobile event creation inserts the event, tags, and attendance in separate requests. Photo privacy/size parity and partial-failure behavior need explicit native acceptance tests. Device-specific outcomes were not verified.
- **Push after logout:** web/native sign-out paths do not remove the device subscription. Verify the intended privacy behavior on shared devices, including logout, account switch, permission revocation, and delivery of already-queued pushes.
- **Concurrency:** ad serving reads impression totals before acquiring its advisory lock, so concurrent budget enforcement deserves a real multi-connection Postgres test. Ticket reservation/confirmation lock ordering and retry behavior also need multi-connection testing; PGlite does not prove these races safe.
- **Subscription creation:** repeated Plus checkout requests can create multiple sessions; verify duplicate-subscription prevention with concurrent requests in Stripe test mode.
- **Queue fairness:** push claims limit the oldest pending rows before skipping quiet-hour users. Test whether a large quiet-hour backlog delays eligible users behind it.
- **Deployment checks:** hosted Auth/Storage/PostgREST, live email recovery, Stripe test-mode Connect/refunds, real push delivery, native iOS/Android builds, and all-feature browser flows remain unverified. The existing beta gate explicitly lists several of these as not run.
- **Completeness:** without the agreed product feature list and your observed error reproductions, this audit cannot certify that everything except mobile migration is finished.

## Prioritized repair plan and handoff contract

**Objective:** Repair the confirmed security, account-lifecycle, billing, and push defects while retaining the current application behavior and independent verification.

**Allowed scope:** The findings' named components, their focused tests, necessary repository-interface changes, new forward SQL migrations, and corresponding documentation. Keep batches small enough to review independently.

| Order | Repair batch | Likely components | Exit criteria |
| --- | --- | --- | --- |
| 1 | Request boundaries and privacy: F6, F7, F8 | Push registration/delivery, auth redirects, messaging helper permissions | Adversarial destination/redirect/cross-user tests pass; legitimate flows remain intact |
| 2 | Account deletion: F1, F2, F3 | Account deletion service/UI, payment lifecycle, demo account logic, new SQL migration | Retryable deletion with Storage; no lost future-event refunds or recurring subscriptions; hosted test-mode verification |
| 3 | Payment event processing: F4, F5 | Stripe adapter, webhook handler, payment repository and SQL functions, campaign activation | Duplicate/reordered/crash/delayed-payment fixtures converge correctly; unpaid sessions never fulfill |
| 4 | Push transport configuration: F9 | Feature readiness, notification cron, senders | Expo-only, web-only, mixed, and disabled tests pass without discarding unsendable work |
| 5 | Release and mobile verification | Staging gate, full feature browser flows, mobile workspace | Required hosted and native checks have recorded evidence; remaining migration gaps are explicitly scoped |

**Required tests:** Preserve all 643 existing tests. Add focused regression tests from each finding, including SQL role tests and service failure injection; run web type-check, lint, full tests, production build, e2e, a11y, mobile type-check, and Expo web export after the integrated repair. Verify default build on CI. Use real multi-connection Postgres for concurrency and a disposable Supabase/Stripe environment for service contracts that stubs cannot prove.

**Implementer must not change:** unrelated UI/design or features; paid/trust-tier product rules; secrets or production settings; existing applied migrations in place; permission safeguards to make tests pass; test assertions merely to hide failures. No deployment, store submission, production data cleanup, actual refunds, or live billing changes are authorized by this report.

**User decisions needed before release:** Define the intended feature-completion checklist and how deletion handles active subscriptions, future ticketed events, completed events, and paid campaigns. A proposed default is to stop future subscription renewals, refund undelivered future events, and retain only the required historical payment records. This is a proposal, not an implemented policy.

**Ready for user review:** Yes, the audit findings and bounded repair plan are ready for review. **Ready for production sign-off:** No. Repair and independent re-verification remain outstanding. No fixes were made during this audit.

## Reproduction evidence

Temporary probes are saved outside the repository at `/private/tmp/findmaxxing-audit-PqwvUM/probes.test.ts`, with configuration beside them. Run from the repository root:

```sh
./node_modules/.bin/vitest run --config /private/tmp/findmaxxing-audit-PqwvUM/vitest.config.mts --reporter=verbose
```

The nine probes intentionally assert the currently broken behavior; their passing result proves reproduction, not correctness. They cover the host-deletion refund gap, webhook replay, private push endpoint registration and request construction, private block disclosure, Expo gating, auth redirect, unpaid ticket fulfillment, and Storage deletion failure ordering. F3 is a source-traced finding with a specified Stripe test-mode reproduction, not a claim of a live cancellation/renewal test.

Temporary files can be removed by operating-system cleanup; the reproduction steps and observed results above are retained in this report. Browser screenshots are in the repository's ignored `.data/e2e/` folder and accessibility output in `.data/a11y/`. No vexp tools were exposed in this session, so discovery and verification used direct source inspection and the declared test commands.
