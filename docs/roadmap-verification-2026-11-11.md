# Roadmap planning verification — 2026-11-11

Scope: founder priorities, proposed roadmap, Fable 5.2 prompt pack and today’s local review artifact. No Fable run, application implementation, migration execution or hosted deployment was dispatched.

## Planning checks

- Confirmed 57 unique questionnaire rows: 46 Must, 11 Later, no Cut, matching the user’s everything-except rule. R4 is Must; X1–X4 are all Later.
- Verified every row’s title/priority appears in the roadmap and all local links resolve.
- Verified each numbered batch has objective, ticket/prerequisites, allowed scope, acceptance, required tests, exclusions and handoff.
- Extracted artifact JavaScript and checked/exercised it in Node with a minimal DOM harness: default 57 rows, Must filter 46, Later filter 11, R4 included/4.4 excluded in Must, multiline export with confirmed team priorities, no invented Founder 2/3 ballots, and existing saved notes/votes preserved.
- `git diff --check`: passed. Verified 16 pre-existing staged application/test/migration files remained identical to their index content after this planning edit. Existing staged docs/briefs/4.0-build-prompt.md was left untouched.
- No browser visual verification of the companion was performed. Screenshots remain the dated local demo captures; native/target mockups are illustrative source reconstructions/proposals.

## vexp and application baseline

MCP `run_pipeline` / `verify_done` were unavailable in this tool session. The task’s existing file names allowed targeted reads. Ran the local fallback `vexp-core verify --json`; report saved at `.data/founder-review-2026-11-11/vexp-plan-verification.json`.

The report has no parse errors, flags 77 potential import references and 20 untouched dependents across the pre-existing staged source, and names 40 runnable test files. The semantic/import warnings have not been confirmed by a fresh compiler run and must not be described as 77 proven broken imports. They are baseline investigation leads for batch 00, outside this documentation change.

Ran the named tests with `node node_modules/vitest/vitest.mjs run --maxWorkers=2 <the 40 paths in .data/founder-review-2026-11-11/vexp-named-tests.json>`.

Result: exit 1; 39 files passed, 1 failed; 802 tests passed, 2 failed; 34.35 seconds. Both failures are in `tests/demo-repository.test.ts`:

1. `prevents duplicate joins and enforces capacity` at line 82: expected full rejection, received resolved `waitlisted` from in-flight event behavior.
2. `preserves attendees on edit, validates capacity, cancels, and restricts deletion` at line 157: lowercase `/capacity/` assertion versus `Capacity cannot be below the existing attendee count`.

Log: `.data/founder-review-2026-11-11/vexp-named-tests.log`. The test command/list/result are preserved beside it. No source/test changes were made to force these checks green.

Not run: full `npm run check`, new Fable implementation checks, hosted Supabase/cron/push/payment/provider calls, staging mutation/recovery and real iOS/Android execution. This planning deliverable is ready for review; the application baseline/release is not declared verified.
