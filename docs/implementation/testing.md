# Verification commands and evidence

Use repo-installed tools and the commands in each [batch prompt](../briefs/fable-5.2/README.md). Establish baseline before editing and distinguish prior failures from new changes.

```bash
npm ci
npm run check
npm run typecheck --workspace @findmaxxing/mobile
npm run e2e
npm run a11y
npm run e2e:features
```

`npm run check` runs typecheck, lint, tests and build. Browser/feature suites need the deterministic demo setup documented in README/scripts, and the installed browser. Native web export can check bundling with `npm run export:web --workspace @findmaxxing/mobile`, but is not iOS/Android sign-off. Run only appropriate checks for the changed scope; do not repeatedly rerun an unchanged passing gate.

## Database proof

Use `tests/helpers/postgres.ts` with `TEST_DATABASE_URL` pointing to a disposable **localhost** server; the harness creates/drops throwaway databases and rejects non-local targets. CI requires it. PGlite alone cannot prove two transactions racing. A skipped race suite is NOT VERIFIED and blocks dependent contracts. Required guard/lock mutation checks must demonstrate the race tests can fail.

Relevant existing tests include event activity/session rules, event atomic create, demo repository, messaging, payments/refunds, notifications, private photos, suspension/privacy, saved lists, trips, timezone and mobile session/push/upload suites. Use actual current paths rather than stale line numbers.

## Evidence standard

For every applicable acceptance criterion record the command/result or concrete browser/device scenario; do not claim an assertion based on the implementer’s summary. Required adversarial checks cover private-data leaks, removed-member access, invite expiry, seat/paid races, decision locks, invalidated plans and unknown routing.

Browser screenshots must identify build/commit, flags, data mode and viewport. Real iOS/Android evidence identifies platform/build/device; typecheck/web export/reconstructed mockups cannot substitute. Hosted cron/push/storage/auth/payment proof needs an explicitly authorized target and real observations.

Historical planning and WIP results: [roadmap-verification](../roadmap-verification-2026-11-11.md). Packaging results and clean-branch checks are recorded in [handoff verification](handoff-verification.md). Do not report historical green results as a fresh pass.
