# Astra prompts

Reusable prompts for complex audits and multi-batch repairs. Replace `<…>`
placeholders before use.

Typical order: 1 or 2 (findings) → 4 (preflight each batch) → 5 → 6 → 7 per
batch → 8 before shipping.

## 1. Full-codebase audit

```
Audit the entire FindMaxxing 2.0 codebase for correctness, security, data integrity, and reliability defects. Do not change any code.
For each finding, give: an ID (F1, F2…), severity (critical/high/medium/low), file:line, a concrete failure scenario (inputs/state → wrong result), why it happens, and acceptance criteria for the fix.
Cover payments/Stripe, auth and Supabase RLS policies, migrations, push/notifications, cron jobs, the recommendation engine, the demo/repository adapters, and the native/web split.
Rank the findings by severity, group them into proposed repair batches that can each ship on their own, and list what you could not verify.
```

## 2. Focused area audit

```
Audit <area: e.g. Stripe webhooks / push transport / owner controls / place photos> in depth. Do not change any code.
Trace every entry point through to its persisted state. Look for duplicate or out-of-order events, retries, partial failures, races, missing authorization, and gaps between the demo adapter and the real one.
Output numbered findings, each with a file:line, a failure scenario, severity, and acceptance criteria. End with the tests that would prove each fix.
```

## 3. Security / RLS audit

```
Run a security audit. Do not change any code. Cover every Supabase RLS policy, storage bucket policy, service-role usage, API route, and server action.
For each one: who can read, write, or delete what, and whether that is intended. Flag missing ownership checks, policies with unqualified names, IDOR, secrets reaching the client, webhook signature checks, and rate limiting.
Output numbered findings with an exploit scenario, severity, and the exact policy or code fix you would make.
```

## 4. Preflight of a plan or batch

```
Preflight this repair plan before any code is written: <paste plan or "batch N for F#">.
Return a verdict: approved / approved with required changes / rejected.
Check the scope against the findings, the risk of regressions, migration safety (new migration only, never edit existing ones), demo parity, rollback, and whether the required tests actually prove the acceptance criteria.
List the required changes as a numbered list.
```

## 5. Implement a repair batch

```
Implement repair batch <N> for findings <F#, F#>, with these preflight changes applied: <paste>.
Start by writing the contract: objective, scope, explicit out-of-scope (no edits to existing migrations, no dependency changes, no deploys, no real transactions, no unrelated UI), acceptance criteria, and required tests.
Then implement it. Add a new migration if one is needed, keep the demo adapters at parity, and test the real code path (for example the actual cron or webhook handler, not just the helpers).
Run the tests, typecheck, and build. Write docs/<topic>-repair.md covering the contract, the changes, the test results, and any residual risk. Stop and report before starting the next batch.
```

## 6. Self-review after a batch

```
Self-review batch <N> as a hostile reviewer. Re-read the full diff against the contract and acceptance criteria.
Look for edge cases you missed, behavior that is now different from before, new races, test cases that pass for the wrong reason, and demo/real drift.
Output new findings in the same F# format, plus a pass/fail for each acceptance criterion. Do not fix anything yet.
```

## 7. Verify the fixes and check for regressions

```
Verify that findings <F#…> are actually fixed on the current branch.
For each one: reproduce the original failure scenario, confirm it now behaves correctly, and name the test that covers it.
Then run the full test suite, typecheck, lint, and build, and report every failure verbatim. Mark each finding fixed, partially fixed, or not fixed, with evidence.
```

## 8. Release readiness

```
Do a release-readiness audit of branch <branch> against main. Do not change any code.
Cover: pending migrations and their order, env vars and secrets the deploy needs, feature flags, a backfill or data-repair plan, rollback steps, monitoring and alerts, and open findings by severity.
Give a ship / ship-with-conditions / block verdict with reasons.
```

## 9. Complex feature from a spec

```
Build <feature> from this spec: <paste>.
Before writing code, produce a design: data model and migrations, RLS, API surface, UI states (loading, empty, error), demo adapter support, and a test plan. Then split it into batches.
Wait for my approval of the design. After that, implement one batch at a time, each with its own contract, tests, and docs/<feature>.md notes.
```

## 10. Migration review

```
Review all migrations, including <0028–00NN / unmerged ones>, for: safety against existing data, locking on large tables, idempotence, correct ordering, RLS enabled on new tables, indexes the queries need, and drift from what the code expects.
Output findings in F# format. Do not change any code.
```

## 11. Performance audit

```
Audit performance. Do not change any code. Cover N+1 queries, missing indexes, unbounded list queries or missing pagination, heavy client bundles, expensive re-renders, image handling, cron runtime, and recommendation scoring cost.
Measure where you can. Output findings with their expected impact and a suggested fix, ranked by payoff divided by effort.
```

## 12. Accessibility and UX audit

```
Run scripts/a11y.mjs and audit every screen on web and native for WCAG 2.2 AA: contrast, focus order, labels, touch target sizes, dynamic type, reduced motion, and screen-reader flow. Also check that every loading, empty, and error state exists.
Output findings with the screen, the element, the issue, and the fix. Do not change any code.
```

## 13. Test coverage audit

```
Map the test coverage of critical paths: payments, auth/RLS, notifications, owner controls, and recommendations. List the untested branches and failure modes, the tests that assert too little, and any fixtures that don't match real provider payloads (Stripe, Expo).
Propose the specific tests to add, in priority order.
```

## 14. Recommendation engine evaluation

```
Evaluate the recommendation engine (rules-v2: per-category taste, diversity pass, cold-start fallback, block awareness, interaction attribution).
Run the offline evaluation and report the metrics. Check that blocked items never appear, that cold-start behaves sensibly, that diversity doesn't bury relevance, and that attribution doesn't double-count.
Output findings and proposed tuning. Do not change production weights without approval.
```

## 15. Reusable template

```
Task: <what>
Mode: audit-only / plan-then-wait / implement batch
Scope: <files/areas>   Out of scope: <list>
Acceptance criteria: <list>
Required tests: <list>
Constraints: new migrations only; no dependency changes, deploys, or real transactions; keep demo parity; test the real code path.
Output: numbered F# findings or a contract + diff + test results + docs/<topic>.md; list anything unverified.
Stop and report before moving to the next batch.
```

---

# Work queue — 2026-10-28

Specific prompts for Astra and Sol, drawn from what is open in this repo today. Each lane touches its own files,
so two agents can run different lanes at once, each in its own worktree. **Do not run two lanes that write code
in the same worktree.** Read-only audits (lane E) can share a checkout.

Paste this preamble once per session:

```
Repo: FindMaxxing 2.0 (Next.js 16 + Supabase + Stripe + Expo app in apps/mobile). Branch: tier1-owner-controls.
Rules: new migrations only (next free number after the highest in supabase/migrations), never edit an existing one;
no dependency changes, deploys, pushes or real Stripe/Expo calls; keep the demo repository twins in
src/lib/data/demo at parity with SQL; test the real code path (the route or action, not only the helper).
Findings use F# IDs with severity, file:line, failure scenario, acceptance criteria and confidence
(Confirmed / Plausible). Repairs use a contract (objective, scope, out of scope, acceptance, required tests),
end with `npm run check`, and write docs/<topic>-repair.md. Stop and report after each batch.
```

## Lane A — Repair the 2026-10-27 security audit (F1–F11)

Source: `docs/audits/2026-10-security-and-coverage.md`. None of the findings has a repair migration yet.

**A1. Preflight and batch plan**
```
Read docs/audits/2026-10-security-and-coverage.md. Confirm each of F1–F11 is still present on this branch (cite
file:line). Then propose repair batches that each ship alone, in this order unless you find a reason not to:
(1) one durable, multi-instance limiter shared by F2 /api/ads, F3 sign-in and F7 /api/geocode;
(2) F1 interaction-log caps and server-issued request_id;
(3) F4 Supabase default function grants in the test stubs + an inventory test, F11 is_suspended, F8 cron auth tests
and a constant-time secret compare;
(4) F5/F6 storage ordering and orphaned objects;
(5) F9 campaign refunds/disputes and partial refunds, F10 Expo push receipts.
Give each batch a contract, then preflight your own plan (approved / approved with required changes / rejected).
Do not write code.
```

**A2–A6. Implement one batch at a time**
```
Implement batch <N> from docs/security-audit-repair.md (create it if missing) for findings <F#…>.
Write the contract first. For the limiter batch, prove it holds across two simulated instances (two processes or two
clients against one database), not one in-process limiter. For F1, a direct PostgREST insert with a request_id the
server never issued must be refused. Run npm run check, append results and residual risk to the repair doc, and stop.
```

**A7. Hostile self-review** — use prompt 6 above after each batch. Better: have the *other* agent (Sol reviews
Astra's batch, or the reverse) run it, with only the diff and the contract.

## Lane B — Recommendations stage 1b (comparisons)

Source: `docs/recommendations-plan-claude.md` §3 stage 1b, commits `fcc6ffb` and `37632a6`, migrations 0037–0038.

**B1. Hostile review of the comparison work**
```
Review commits fcc6ffb and 37632a6 (0037_place_comparisons.sql, 0038_comparison_taste.sql,
src/lib/ranking/bradleyTerry.ts, the comparison flow after a star rating) as a hostile reviewer. Do not change code.
Check: the binary-search insertion asks at most ceil(log2 n) questions and starts in the star bucket; skip ("too
tough") is handled; one answer per pair can't be bypassed by swapping winner/loser; comparisons are owner-only and
only between places the writer rated in the same category; editing or deleting a rating leaves no stale comparisons
or scores; the plpgsql fit and the TS twin agree on edge cases (one item, all ties, a cycle A>B>C>A, 500+
comparisons); the fit cost per request is bounded; blocked users and hidden places never surface. F# findings.
```

**B2. Finish stage 1b**
```
Finish stage 1b per the plan: demo repository twin for comparisons and scores, the stored or computed
user_place_scores, and use the 0–10 score as the taste weight in stage 1a where it exists (stars otherwise).
Add a profile list view of ranked places per category. Rerun scripts/recs/eval.ts and report rules-v2 vs the new
policy; if it loses on the demo harness, ship it behind a flag that is off and say so.
```

**B3. Abuse of ratings and comparisons**
```
Audit how a user or a ring of sock-puppet accounts could manipulate place scores, "Popular with locals", reputation
(0016) and recommendations via ratings, comparisons, saves and interactions. Consider rate limits, new-account
weighting, and what other users can see. F# findings with the cheapest attack first. No code changes.
```

## Lane C — Native release blockers

Source: `docs/native-release-blockers.md` "Still open", `docs/release-mobile-verification.md`.

**C1. Session hydration and account switch**
```
In apps/mobile, fix the Gate rendering its stack while the session loads, and clear all profile/user state on user
change (sign out then sign in as someone else must show nothing from the first account: caches, lists, push token,
drafts). Write the contract first, add tests for cold boot and account switch, and list exactly what still needs a
device to confirm.
```

**C2. Push registration**
```
In apps/mobile, stop swallowing push registration errors in Gate: surface them to observability and to a quiet
in-app state, and make registration retry safely. Read where the EAS project id must come from and make the code
fail clearly when it is missing; do not invent an id. Cover with tests and update native-release-blockers.md.
```

**C3. Photo gallery parity design**
```
Design (do not build) native photo gallery parity: toPlace returns photos: [] today and private photos are served by
/api/photos/[id] with per-request authorization. Propose how the app gets authorized photo URLs (signed URLs vs
bearer-authenticated fetch vs a token route), caching, variants (0008), and privacy. Compare options with risks and
give a batch plan. Wait for approval.
```

**C4. Web vs native feature matrix**
```
Produce a table of every user-facing feature on web (src/app) and whether apps/mobile has it: full, partial, none.
For each gap, estimate effort and say whether it blocks an App Store/Play release (store review rules: account
deletion in-app, sign-in options, payments for digital goods). Output a recommended native v1 scope for the owner.
```

## Lane D — Release gate and staging readiness

**D1. Beta gate refresh**
```
docs/beta-gate.md describes migrations 0001–0014 and an older test suite. Bring it up to date with this branch:
every gate row re-checked against current code and migrations 0001–0038, new rows for payments, push, account
deletion lifecycle, recommendations and comparisons. Run every local command that needs no credentials
(npm run check, e2e, a11y, measure-discovery, backup-restore-rehearsal, load-test) and record real results with
today's date. Mark staging rows "not yet run" honestly. Edit only docs and scripts.
```

**D2. Staging-check script audit**
```
Audit scripts/staging-check.ts and scripts/e2e*.mjs for whether they cover the features added since 2026-10-14
(payments webhook replay, push transport, account deletion jobs, interactions, comparisons). Add missing checks so
one run against staging proves the gate, with the --allow-staging-writes guard intact and cleanup verified. Do not
run against staging.
```

**D3. Performance re-measure**
```
Re-run tests/helpers/measure-discovery.ts at 50k places with all migrations through 0038, plus new measurements for
recommend_places / recommend_events (including the cold-start branch), user_taste, and fit_user_category_scores at
realistic sizes. EXPLAIN every hot query; flag any sequential scan or anything over 50 ms. F# findings with fixes.
```

## Lane E — Audits nobody has done yet (read-only, can share a checkout)

**E1. Messaging** — prompt 2 with area = `messaging (0020, src/server/actions/messages.ts, src/app/api/messages,
apps/mobile/app/chat): blocks, read access, spam, deletion cascade, realtime leaks`.

**E2. Trip planner and the Anthropic call**
```
Audit /api/trip-plan and src/server/trips: prompt injection through place names, descriptions and user notes;
cost abuse (unauthenticated or unthrottled calls, max tokens, retries); what personal data is sent to the model;
output validation before it is rendered or stored; behaviour when the API errors or times out; the model id in use.
F# findings. No code changes.
```

**E3. Owner controls and claims** — prompt 2 with area = `owner controls (0002, place claim and edit flows):
who can claim a place, verification, transfer, owner vs community content, owner removing others' photos (F5)`.

**E4. Admin and moderation privilege escalation**
```
Audit every path to admin or moderator power (0010, 0017, src/server/actions/admin.ts, moderation.ts,
src/app/admin, src/app/moderation): can any user grant themselves a role, act on content outside their scope, read
private reports, or avoid the audit trail? Can a suspended user still act through any route or RPC? F# findings.
```

**E5. Time and time zones**
```
This repo has had several time-of-day test flakes and a hydration error from dates. Audit every use of Date, now(),
time zones and DST: event times, quiet hours in notifications, cron windows, purge/retention windows, "upcoming"
filters, tests that depend on the clock. List each risk and the tests that should freeze time. F# findings.
```

**E6. Privacy and data rights**
```
Build a data inventory: every table and Storage bucket holding personal data, who can read it, retention, and
whether account deletion removes or anonymizes it. Check DNT/GPC handling, analytics opt-out vs personalization
opt-out (plan open question 3), what goes to Sentry, Stripe, Mapbox, Anthropic and Expo. Is there a data export?
Output a gap list against GDPR/CCPA basics. No code changes.
```

**E7. Demo/real parity sweep**
```
For every function in the real repository (src/lib/data, src/server/serviceRepository.ts), compare against its
demo twin: filtering, ordering, limits, block/hidden handling, error cases. List each divergence with a test that
would catch it. F# findings.
```

**E8. Test quality**
```
Find tests that pass for the wrong reason: assertions that can't fail, mocks that replace the code under test,
hand-built Stripe/Expo fixtures that don't match real payloads, tests that depend on the clock or order. For the
top 10, show the mutation to the source that the test would miss. Propose fixes in priority order.
```

**E9. Headers, CSP and dependencies**
```
Audit next.config.ts headers and CSP, cookie flags, CORS on API routes, and npm audit output. Check the service
worker (public/) and offline page for cache poisoning or caching private data. F# findings.
```

**E10. Notifications end to end**
```
Trace every notification from trigger to delivery (web push, Expo push, in-app): fan-out size, dedupe, quiet hours,
blocked users, deleted accounts, stale tokens, failure handling, and receipts (audit F10). F# findings.
```

## Lane F — Wrap-up for the day

**F1. Cross-agent review** — give each agent the other's repair docs and diffs from today with prompt 6.

**F2. Release readiness** — prompt 8 for `tier1-owner-controls`, listing every finding still open across
`docs/audits/`, `docs/native-release-blockers.md` and today's repair docs.

**F3. Docs consistency**
```
Check README.md, AGENTS.md and every file in docs/ against the code on this branch. Fix statements that are now
wrong (migration ranges, statuses, commands), and mark finished plan items done with the commit that did it.
Docs only.
```
