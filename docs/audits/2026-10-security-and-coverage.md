# Security and test-coverage audit — 2026-10-27

## Decision and scope

**Repair preflight: approved with required changes. No critical or high findings.**

Audited commit `9e1f37b` (`tier1-owner-controls`), following prompts 3 (security / RLS) and 13 (test coverage) of
`docs/astra-prompts.md`. That file is not committed on any branch yet; it lives in the `laughing-wilson-f4be90`
worktree. This audit's worktree branch was fast-forwarded from `c8514fb` to `9e1f37b` first, because the older base
had none of migrations `0010`–`0035`. No product code, migrations, tests or configuration were changed. This report is
the only file added.

Covered:

- Every RLS and storage policy, with detailed review of `0026`–`0035`. That includes the interaction log, attribution,
  cold start, `user_taste` and the qualified place-photo delete policy.
- Every SECURITY DEFINER function's EXECUTE grants.
- Service-role usage, all 17 API routes, all server-action modules, Stripe webhook signature handling, cron
  authorization, and database and in-memory rate limits.
- Test coverage of payments, auth/RLS, notifications, owner controls and recommendations.

Findings: **4 medium, 7 low**. "Medium" means fix before the closed beta widens. "Low" means hygiene or a bounded
risk, which can be done in the repair cycle. Each finding was checked against the code. Findings whose impact depends
on deployment facts this audit could not observe are marked **Plausible**. The rest are **Confirmed**.

## Verification performed

| Check | Result |
| --- | --- |
| Read migrations `0026`–`0035` in full; grepped every policy and grant in `0001`–`0025` | Done |
| EXECUTE-grant probe: all migrations in PGlite, with Supabase's default function privileges added to the test stubs (scratch script, not committed) | Done. Every SECURITY DEFINER function callable by `anon` or `authenticated` was listed and its body checked for an `auth.uid()`, `is_admin()` or ownership gate (see F4) |
| Read every `src/app/api/**/route.ts` and the server actions that touch payments, ads, interactions, auth, account, places and admin | Done |
| `npm test`, `npm run e2e` | **Not run.** This worktree has no `node_modules`. The coverage map comes from reading the test files. |
| Hosted Supabase, Stripe test mode, Expo push service, Vercel multi-instance behaviour | Not run |

### Checked and found sound (no finding)

- **`0032` photo delete policy.** It now compares `photo_object_stem(objects.name)`, so it cannot bind to
  `places.name`. The insert policy on `place_photos` still requires `storage_path like auth.uid() || '/%'`
  (`0004:124-128`). A place owner therefore cannot attach a row that points at someone else's object and then
  delete it.
- **`user_interactions` RLS** (`0031:54-74`, `0033:35-45`). Rows are own-only for select, insert and delete. There is
  no update grant. `created_at` has no insert grant. Items are checked through the writer's own place and event
  RLS. Clients can no longer write save, rate or join rows.
- **Training and retention functions.** `interaction_item_stats` and `purge_user_interactions` are service-only
  (`0031:139-168`).
- **`user_taste`** runs with `security_invoker` and keys on `auth.uid()` (`0035:28-95`). The `service_role` gets an
  empty set.
- **Recommendation functions.** `recommend_places` and `recommend_events` are security invoker. They leave out hidden
  items and anyone blocked in either direction, using the viewer-bound `is_blocked_between` (`0026:55-62`).
- **New lifecycle and payment functions.** Every function new in `0027`, `0028` and `0029` is revoked from `public`,
  `anon` and `authenticated` and granted only to `service_role` (`0027:213-218`, `0028:95-99`, `0029:55-56`). The
  probe confirms none of them is reachable by API roles.
- **Stripe webhook.** It verifies the signature over the raw body before parsing (`route.ts:23-29`). It claims the
  event before any work and fails closed while busy. Payment-mode fulfilment requires `payment_status === "paid"`
  (`webhook.ts:56`).
- **Cron routes.** All four refuse requests without `Bearer $CRON_SECRET`, and refuse everything when the secret is
  unset.
- **Service role.** `createSupabaseAdminClient` is used only by crons, the webhook, account deletion,
  `/api/ads`'s `serve` call and checkout-session attachment. Each of those runs after the viewer has been
  authorized.
- **Client environment variables.** The client only receives `NEXT_PUBLIC_*`: the Supabase URL and anon key, the
  Mapbox public token and style, the feature flags, and the site URL.
- **Photo delivery.** `/api/photos/[id]` re-authorizes on every request and gives a 404 before any 304.
  `/api/uploads/[name]` is demo-only and restricted to an allowlist of file names.

## Findings

### F1 — Medium: The interaction log accepts about 60,000 client-written rows per hour per account, with forgeable attribution

- **Evidence:**
  - The rule is `('interactions', 600, 3600)` (`supabase/migrations/0031_user_interactions.sql:80-81`), and each tick
    allows a batch of up to 100 rows (`:94`).
  - `authenticated` can insert `request_id`, `policy`, `score` and `propensity` (`0033_interaction_attribution.sql:32`).
    The insert policy checks only the owner, the action and the item's visibility (`0033:36-45`).
  - The server action passes client-supplied `requestId`, `policy` and `score` straight through
    (`src/server/actions/interactions.ts:14-26`). `propensity` is not in the action's schema, but PostgREST accepts it
    from any signed-in client (`src/lib/data/supabase/repository.ts:1386-1390`).
  - Nothing ties a `request_id` to a rail the server actually rendered.
- **Exploit scenario:** A signed-in user takes their JWT from the browser and loops
  `POST /rest/v1/user_interactions` with 100 `impression` or `view` rows per call, 600 calls an hour, on any visible
  places, with made-up `request_id`, `policy: "rules-v2"`, `score` and `propensity`. That is about 1.44 million rows
  per day per account in a beta-sized database. These rows feed `interaction_item_stats` (the planned training
  aggregate) and the offline evaluation in `scripts`/`recs-eval`. Fabricated propensities can push inverse-propensity
  estimates in either direction. Ranking today does not read other users' rows: `0034` popularity uses `save_count`,
  and `0035` taste is own-only. So the current impact is storage and cost, plus corrupted evaluation data, not live
  manipulation of rankings.
- **Suggested fix:** Split the limit into a per-hour batch cap (about 60) and a per-day row cap enforced in
  `limit_interaction_batches`. Have the server issue `request_id` when it renders a "For you" rail, for example in an
  `issued_rec_requests(user_id, request_id, item_ids, policy, scores, propensities, expires_at)` table. Then let a
  BEFORE INSERT trigger copy `policy`, `score` and `propensity` from that table, and drop any client-supplied values.
  Revoke the column grant on `policy`, `score` and `propensity`.
- **Acceptance:** A direct PostgREST insert with a `request_id` the server never issued, or with an item that was not
  in that rail, stores no attribution. The default is to drop the row. Client-supplied `score` and `propensity` are
  never stored. One account cannot store more than N rows a day. Legitimate rails still record one impression per
  request and item.
- **Confidence:** Confirmed in code and grants. Row volume is arithmetic from the rule, not load-tested.

### F2 — Medium: Anonymous callers can drain paid ad campaigns through `/api/ads`

- **Evidence:**
  - `GET /api/ads` needs no session. Every call that passes the limiter runs `serve_ad`, which records an impression
    (`src/app/api/ads/route.ts:29-31`, `0023_ads.sql:208-213`).
  - The only brake is `AD_SERVE_LIMIT = 120/hour` (`src/lib/rateLimits.ts:79`). It is held in process memory for each
    serverless instance (`src/server/limiters.ts:13-19`) and keyed on the first `x-forwarded-for` value
    (`src/server/http/clientIp.ts:11`). Its key map evicts the oldest key after 10,000 keys
    (`src/lib/rateLimits.ts:82,95`).
- **Exploit scenario:** A competitor scripts `GET /api/ads?slot=places&bbox=<area>&category=<cat>`. A $20 campaign
  over 7 days has a daily cap of about 572 impressions. One IP hitting one warm instance exhausts that cap in about
  5 hours. A few IPs, or requests spread over several instances, do it within an hour, every day of the run. The
  advertiser pays the full budget for impressions that bots consumed. On hosts other than Vercel, which do not
  overwrite `x-forwarded-for`, a single client can rotate the header and bypass the limit entirely.
- **Suggested fix:**
  - Count an impression only on a client render beacon that carries a short-lived, signed, one-time token issued with
    the card. Dedupe it per token.
  - Move the per-IP cap into Postgres: a service-role table keyed by an IP hash and the day, shared across instances.
  - Add a per-campaign, per-IP-hash daily cap, for example at most 3 impressions.
  - Do not trust `x-forwarded-for` unless the platform is known to overwrite it.
- **Acceptance:** 1,000 serve calls from one IP spread across two simulated instances record no more impressions than
  the per-IP cap allows. Serves without a render beacon record no impressions. Concurrent serves never exceed budget
  or the daily cap (see the prior audit's note on ad-serve concurrency).
- **Confidence:** Confirmed in code. The instance count on Vercel is **Plausible**: it was not observed.

### F3 — Medium (Plausible): Sign-in has no app-side limit, and Supabase Auth's per-IP limits see the server's IP

- **Evidence:**
  - `signInAction` calls `supabase.auth.signInWithPassword` from the server with no limiter
    (`src/server/actions/auth.ts:23-36`). The account-deletion password re-check does the same
    (`src/server/accountDeletion.ts:44-45`).
  - Sign-up has only the in-memory per-instance limiter (`auth.ts:54-56`).
  - The README tells operators to rely on Supabase's per-IP Auth limits, for example 30 sign-ups per 5 minutes
    (`README.md:95`). Those calls come from Vercel's egress IPs, not the user's, and nothing forwards the client
    address.
- **Exploit scenario:** Either way the per-IP limit fails:
  - **If Supabase keys its limits on the server's IP:** one attacker sending sign-in or sign-up attempts uses up the
    shared budget, so every real user's sign-in or sign-up fails for 5 minutes at a time. That is a launch-day
    lockout.
  - **If egress IPs rotate:** the Supabase limit barely applies, and credential stuffing against beta accounts is
    limited only by request throughput.
- **Suggested fix:** Add a durable limiter (shared with F2), keyed per client IP and per email, in front of sign-in,
  sign-up, password reset and the account-deletion password check. Turn on Supabase CAPTCHA for sign-in and sign-up,
  passing the token from the client. Confirm in the Supabase dashboard which IP Auth sees for server-side calls, and
  record the answer in the README.
- **Acceptance:** The sixth failed sign-in for an email within the window returns a rate-limited error without
  calling Supabase. Attempts from one IP do not affect sign-in from a different IP. A test proves the limiter is shared
  across two limiter instances.
- **Confidence:** Confirmed: no app-side sign-in limit. **Plausible:** the shared-IP behaviour of Supabase's limits,
  which was not observed on the hosted project.

### F4 — Medium: The test database does not model Supabase's default function grants, so privilege tests can pass while production differs

- **Evidence:**
  - `SUPABASE_STUBS` sets default privileges for tables only (`tests/helpers/pglite.ts:20`).
  - Hosted Supabase also grants EXECUTE on new `public` functions to `anon`, `authenticated` and `service_role` by
    default. A migration that only runs `revoke ... from public` therefore leaves `anon` and `authenticated` able to
    call the function in production, while PGlite shows them denied.
  - The probe in this audit, which adds that default, finds `create_place_with_details`, `update_place_with_tags`,
    `update_event_with_tags`, `discover_place_text_ids` and `discover_event_text_ids` executable by `anon` in
    production but not in tests.
  - Each of these checks `auth.uid()` or the viewer's visibility, so **nothing is exploitable today**.
- **Failure scenario:** A future service-only definer function, for example a new `confirm_*` or `purge_*`, is written
  with `revoke all ... from public` and `grant ... to service_role`, which is the `0005` style. The test "is
  service-only" passes in PGlite, but in production any signed-in user can call it through `/rest/v1/rpc/<name>`.
- **Suggested fix:** Add
  `alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;` to the
  stubs. Add a grant-inventory test that lists every non-trigger SECURITY DEFINER function in `public` with its
  `anon` and `authenticated` EXECUTE privilege, and compares that list against a checked-in allowlist. Always revoke
  `from public, anon, authenticated` explicitly. `0005`, `0004` and `0010`/`0016` revoke from `public` only.
- **Acceptance:** With the stub change, the inventory test fails if any new definer function is callable by an API
  role and not on the allowlist. The current allowlist is reviewed once and checked in.
- **Confidence:** Confirmed by the probe. The production default is Supabase's documented behaviour; confirm it once
  with `select has_function_privilege('anon', 'public.update_event_with_tags(...)', 'execute')` on the hosted project.

### F5 — Low: Community photos removed by a place owner leave the uploader's objects in Storage indefinitely

- **Evidence:** `removePhoto` deletes the row. It returns a storage path only when the caller is the uploader, and the
  comment says "orphan cleanup is an admin job" (`src/lib/data/supabase/repository.ts:803-814`). No such job exists
  anywhere in `src`, `scripts` or `supabase`. After the row is gone, the object falls back to the
  uploader-folder exception (`0005:93-102`).
- **Failure scenario:** An owner removes another user's photo of their place, for example a photo of a person. The
  object and its `.sm` and `.md` variants stay in `place-photos`. They can no longer be viewed by others, but they are
  retained without limit until the uploader deletes their account.
- **Suggested fix:** Owner removal enqueues the object stem for deletion by the service role. Alternatively, a
  scheduled sweeper deletes `place-photos` objects that no `place_photos` row references and that are older than 24
  hours.
- **Acceptance:** After an owner removes another user's photo, all three sizes are gone within one cron cycle. The
  sweeper never deletes an attached object or an upload younger than the grace period.
- **Confidence:** Confirmed.

### F6 — Low: Place deletion removes Storage objects before the authorized row delete

- **Evidence:** `places.delete` lists photo paths and removes every object (`repository.ts:735-738`). Only then does
  it run `delete ... eq("creator_id", creatorId)`, and it reports "forbidden" when no row was deleted (`:739-740`).
- **Failure scenario:** The objects are already gone if the row delete then fails. Three ways it can fail:
  - **Suspended owner:** `block_suspended_writes` raises on `places`, but Storage deletes are not blocked.
  - **Concurrent rate limit or closing account:** same result.
  - **Transient error.**

  The place stays published with broken photos. Separately, a non-owner calling `deletePlaceAction` deletes their own
  uploads on that place before being told "forbidden".
- **Suggested fix:** Snapshot the paths, delete the row first (ownership is checked by `creator_id`), then remove the
  objects, retrying on failure through the same queue as F5.
- **Acceptance:** A failed or unauthorized delete leaves every object in place. A successful delete removes all sizes.
- **Confidence:** Confirmed by reading. Not executed.

### F7 — Low: `/api/geocode` is an unauthenticated, unthrottled proxy when Mapbox is configured

- **Evidence:** With a Mapbox token, every request whose cache key is not already cached calls Mapbox
  (`src/app/api/geocode/route.ts:98-104`). There is no session check and no limiter. Nominatim calls are serialized
  at 1 per second only per instance (`:53-63`).
- **Failure scenario:** A script sends unique `q` values to bypass the 500-entry cache. That uses up the Mapbox
  geocoding quota and leads to billing, or in Nominatim mode it gets the deployment's IP blocked under Nominatim's
  usage policy, which breaks address entry for everyone.
- **Suggested fix:** Add a per-IP durable limit (shared with F2 and F3). Optionally require a session, since only
  place and event creation uses the proxy.
- **Acceptance:** More than N lookups per IP per minute return 429 without calling the provider.
- **Confidence:** Confirmed. The cost impact depends on the Mapbox plan.

### F8 — Low: Two cron routes have no authorization tests, and the secret comparison is not constant-time

- **Evidence:** No test calls `/api/cron/purge-analytics` or `/api/cron/refresh-reputation`. The `notifications`
  and `payments` crons do have 401 tests. All four compare with `!==` (for example
  `src/app/api/cron/purge-analytics/route.ts:14`).
- **Failure scenario:** A refactor drops the check from an untested cron. That route then lets anyone purge analytics
  or recompute reputation, using the service role. A timing attack on `!==` over the network is impractical, so the
  comparison is listed for hygiene only.
- **Suggested fix:** Extract one `requireCronSecret(req)` helper that uses `crypto.timingSafeEqual` over equal-length
  digests, and test it for each route.
- **Acceptance:** Each of the four routes returns 401 for a missing header, a wrong secret and an unset
  `CRON_SECRET`, and returns 200 for the correct secret.
- **Confidence:** Confirmed.

### F9 — Low: Refunds and disputes of campaign charges, and partial refunds, are ignored

- **Evidence:** `charge.refunded` only calls `markRefunded`, which updates tickets, and only when
  `charge.refunded === true` (`src/server/payments/webhook.ts:94-101`). No branch handles `charge.dispute.*`.
  `activate_ad_campaign` has no counterpart that deactivates a campaign (`0023:163-174`).
- **Failure scenario:** An advertiser's campaign payment is refunded from the Stripe dashboard, or the advertiser
  files a chargeback. The campaign stays `active` and keeps being served for free. A partial refund of a ticket leaves
  the ticket `paid` with no record of it.
- **Suggested fix:** On `charge.refunded` or `charge.dispute.created` for a campaign payment intent, set the campaign
  to `ended`, or to a new `refunded` status, through a service-only RPC. Log partial ticket refunds for operator
  review.
- **Acceptance:** A refunded or disputed campaign PI stops serving within one webhook. A replayed event is idempotent.
  A partial refund is visible to operators and does not grant or revoke attendance.
- **Confidence:** Confirmed in code. That dashboard refunds will happen during the beta is an assumption.

### F10 — Low: Expo push receipts are never fetched

- **Evidence:** `expoPushSender` reads only the push ticket (`src/server/notifications/push.ts:22-36`). Expo reports
  most APNs and FCM delivery failures, including `DeviceNotRegistered` for uninstalled apps, `MessageRateExceeded` and
  `InvalidCredentials`, in receipts fetched later from `/--/api/v2/push/getReceipts`. Nothing calls that endpoint.
- **Failure scenario:** Uninstalled devices stay in `push_subscriptions` indefinitely. Each one keeps counting toward
  the 10-device cap (`0024:24-27`) and adds a send on every claim. A credential misconfiguration
  (`InvalidCredentials`) goes unnoticed, because every ticket says `ok`.
- **Suggested fix:** Store ticket ids per send. In the notifications cron, fetch receipts after 15 minutes or more.
  Drop `DeviceNotRegistered` devices and report the other errors.
- **Acceptance:** A receipt with `DeviceNotRegistered` removes that device. A receipt with `InvalidCredentials` raises
  a reported error. Receipts are fetched once per ticket.
- **Confidence:** Confirmed in code. The receipt semantics come from Expo's documentation and were not exercised.

### F11 — Low: `is_suspended(uuid)` tells any signed-in user whether any other account is suspended

- **Evidence:** It is SECURITY DEFINER, with no viewer binding, and granted to `authenticated` (`0017_admin.sql`; see
  the probe). The UI shows suspension only to the account itself (`src/components/profile/ProfileView.tsx:43-47`).
  `account_is_closing` was bound to the caller in `0027:22-27`, but `is_suspended` and `is_plus` were not. `is_plus`
  is public by design because of the Plus badge.
- **Exploit scenario:** `POST /rest/v1/rpc/is_suspended {"p_user": "<uuid>"}` for any profile id reveals moderation
  status, which is private moderation data.
- **Suggested fix:** Bind it to the caller the same way `account_is_closing` does, returning false when
  `auth.uid()` is not null and differs from `p_user`. Internal callers that need any user's status should call a
  copy in `findmaxxing_private`.
- **Acceptance:** As user A, `is_suspended(B)` returns false whatever B's state. Suspension enforcement in triggers,
  `reserve_ticket`, `count_upload` and similar is unchanged (covered by the existing suspension tests).
- **Confidence:** Confirmed.

## Proposed repair batches

Each batch can ship on its own. Follow the existing contract: a new migration rather than editing old ones, demo
parity, then a self-review.

| Batch | Findings | Objective | Out of scope |
| --- | --- | --- | --- |
| **B1 — Privilege fidelity** | F4, F11 | Model Supabase's function defaults in PGlite, add the grant-inventory test, bind `is_suspended` to the caller, and add explicit `anon, authenticated` revokes to older definer functions. | Changing any function's behaviour beyond grants and caller binding. |
| **B2 — Durable abuse limits** | F2, F3, F7 (and F1's per-day cap) | One Postgres-backed limiter for unauthenticated or IP-keyed paths (ad serve, sign-in, sign-up, reset, geocode, deletion password check), a render-beacon ad impression with a signed token, and a CAPTCHA hook. | Changes to ad pricing or targeting. |
| **B3 — Trusted attribution** | F1 | Server-issued rec requests, a trigger that copies attribution from them, revoked attribution column grants, and a per-day row cap. Evaluation scripts ignore rows without an issued request. | New ranking policies. |
| **B4 — Photo object lifecycle** | F5, F6 | Delete the row first, then the objects; add a service-role object-removal queue and an orphan sweeper. | Image pipeline changes. |
| **B5 — Payment and push tails** | F9, F10 | Campaign refund and dispute handling, a partial-refund log, and Expo receipt polling. | Changes to ticket refund policy. |
| **B6 — Cron hygiene (tests and helper)** | F8 | A shared constant-time `requireCronSecret`, with 401 and 200 tests for all four crons. | — |

Suggested order: B1, then B2, B3, B6, B4 and B5. B1 comes first because it makes every later privilege test
trustworthy.

## Test-coverage map

The suite has 52 Vitest files (about 9,700 lines). 26 of them run all migrations in PGlite. There is also Playwright
e2e. The paths below are what the tests exercise, as read from the files. The suite was not run.

| Area | Well covered | Untested branches and failure modes | Tests that assert too little | Fixture mismatches |
| --- | --- | --- | --- | --- |
| **Payments** (`payments`, `payment-event-processing`, `payment-event-db`, `payment-review-regressions`, `ads`, `account-deletion-*`) | Replay, ordering, leases and busy handling; unpaid → delayed success or failure; subscription reconciliation and pagination; refunds on host deletion and cancellation; signature over raw body; campaign mismatch/unknown refund; closing-account fences | `checkout.session.expired` (no test names it); direct owner deletion of a *future* paid event through `refund_before_event_delete` (only the account-cascade path is tested); past-event deletion must *not* refund; `charge.refunded` with `refunded: false`; campaign PI refund or dispute (F9); `account.updated` without metadata; a ticket checkout replaced and then both sessions paid | `ads.test.ts:285` "caps cards per IP" runs one in-process limiter, so it cannot catch F2 | Stripe fixtures are hand-built objects; none comes from `stripe fixtures` or recorded API versions. Re-check `payment_status` and `amount_total` against the pinned API version. |
| **Auth / RLS** (`schema`, `security-boundaries*`, `adversarial-security-db`, `rate-limits`, `auth-redirects`, `email-link`, `account-deletion-auth`) | RLS enabled on every table; locals tier; private photos and variants; block privacy; push endpoints; forged metadata; rating identity | Function EXECUTE inventory (F4); a *positive* `0032` test in which an owner deletes all three sizes of another uploader's photo on their own place; sign-in limits (F3); `is_suspended` leak (F11); storage `UPDATE` (upsert) denied | `adversarial-security-db.test.ts:64` only asserts the attacker's delete returns `[]`. It would still pass if `0032` denied owners too. | PGlite `storage.objects` has no RLS unless a test opts in, and has no `owner_id` column. The Storage API's silent "remove of a denied path" is not modelled. |
| **Notifications** (`notifications`, `push-readiness*`, `push-transport`, `security-boundaries`) | Claim once per transport, quiet hours, daily cap, batching, block and mute suppression, retention, cron 401, web-push redirect pinning | Expo HTTP 4xx, 429 and 5xx responses; receipts (F10); `notify_trip_plan_ready` called repeatedly by a user; purge running only in the 04:00–04:15 UTC window, so a skipped run misses a whole day | — | Expo fixtures only return a single-object `data` with HTTP 200. There is no array-shaped response, no `errors` envelope and no receipt payload. |
| **Owner controls** (`schema`, `demo-repository`, `demo-uploads`) | DB policies: owner hides, non-owner refused, owner removes community photo row, moderation statuses refused | **No tests for the server actions** `setPlaceStatusAction`, `setPlaceVisibilityAction`, `deletePlaceAction`, `removePlacePhotoAction`, `updateEventAction`, `cancelEventAction`, `deleteEventAction`; none for the Supabase repository's `places.delete` and `removePhoto` (F5, F6); the owner deleting objects under `0032` | Demo-repository tests cover the logic only in demo mode | — |
| **Recommendations** (`recommendations`, `user-interactions`, `interaction-attribution`, `taste`, `recs-eval`) | Own-only rows, opt-out, visibility, batch tick, retention, hide and undo, block filtering for places, SQL and demo parity, taste privacy, cold start, rerank fallback | Forged `request_id`, `policy`, `score` and `propensity` through direct inserts (F1); blocked users in `recommend_events`' `followed_going` and `saved_place` reasons; `user_taste` as `service_role` returning empty; `p_now` misuse on `recommend_events` | `interaction-attribution.test.ts:33` inserts its own policy and score, which encodes trust in client attribution | — |

## Missing tests, in priority order

1. **Grant inventory** (B1, F4): add Supabase's function default to `SUPABASE_STUBS`. Assert the exact set of
   non-trigger SECURITY DEFINER functions that `anon` and `authenticated` can execute.
2. **Positive `0032` path**: an owner deletes `x.webp`, `x.md.webp` and `x.sm.webp` uploaded by another user on the
   owner's place. A non-owner cannot delete them. The existing negative test is kept.
3. **Owner-control server actions** against the Supabase repository with a PGlite-backed client, or the demo
   repository at minimum. Each action is tried as owner, non-owner and suspended owner, and the test asserts the
   resulting rows and objects (F6).
4. **Direct deletion of a future paid event** queues `refund_pending` for paid tickets and expires holds. Deleting a
   past event does not refund.
5. **Interaction attribution forgery** (F1): a direct insert with a non-issued `request_id`, or with client `score` or
   `propensity`, is not stored as attribution. A per-day row cap is enforced.
6. **Cron authorization for all four routes** (F8): missing header, wrong secret, unset secret, and the correct
   secret.
7. **Durable limiter tests** (F2, F3, F7): two limiter instances share one budget; ad serve, sign-in and geocode each
   return the limited response.
8. **Webhook branches**: `checkout.session.expired`; `charge.refunded` with `refunded: false`; campaign refund and
   dispute (F9); `account.updated` without metadata, which should be a no-op.
9. **Expo transport**: HTTP 429 and 500 responses, an `errors` envelope, an array-shaped `data`, and receipt polling
   that drops `DeviceNotRegistered` (F10).
10. **Recommendations privacy**: `recommend_events` never names or counts a blocked user in `followed_going`.
    `user_taste` read as `service_role` is empty.
11. **`is_suspended` caller binding** (F11).
12. **Concurrency** (carried over from the 2026-10-13 audit): multi-connection Postgres tests for `serve_ad` budget
    enforcement and for `reserve_ticket` against `confirm_ticket`. PGlite cannot prove these.

## Severity count

| Severity | Count | Findings |
| --- | --- | --- |
| Critical | 0 | — |
| High | 0 | — |
| Medium | 4 | F1, F2, F3 (Plausible), F4 |
| Low | 7 | F5, F6, F7, F8, F9, F10, F11 |
