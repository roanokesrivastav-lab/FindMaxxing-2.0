# Starting code and deferred snapshot

## Intended founder handoff base

The clean handoff branch is `codex/founder-implementation-handoff-2026-11-11`, built from reviewed-source checkpoint `f2eb957` plus the documentation handoff. That checkpoint includes committed 4.2 structured activity/timezone and 4.3 attendance/readiness, and earlier foundation/spec work. A documentation commit is not proof that all existing app behavior is green; rerun starting checks.

## Preserved unfinished code

The separate branch `codex/deferred-waitlist-snapshot-2026-11-11` preserves the 16 application/test/migration files that were already staged when this handoff was requested. It includes `0052_waitlist_and_offers.sql`, participant/demo/repository/payment changes and adjusted tests. This is WIP for a Later feature, not reviewed release code. Do not merge it as an implementation prerequisite or apply its migration to a hosted database.

Historical broad `docs/briefs/4.0-build-prompt.md` is archived with a warning. It includes 4.4 and must not be executed instead of the new prompt pack.

## Known results from the WIP checkout

- Earlier named-test run: 40 files; 39 files passed / 1 failed; 802 tests passed / 2 failed. Demo capacity test received `waitlisted` rather than a full rejection; another assertion mismatched the capitalized capacity message.
- Packaging `npm run check` stopped at TypeScript: `tests/messaging.test.ts:268` expects `Promise<void>` but the WIP join returns `Promise<JoinResult>`. No code/test fix was made to hide this failure.
- These are results from the deferred WIP state. They are not automatically failures on the clean handoff branch. Preserve that distinction when reporting/checking the actual candidate.
- Hosted migrations, cron/push/provider calls and actual phone runtime were not verified by packaging this handoff.

Inspect the actual branch/HEAD/status and migration list before work. Do not reset local work to match a prose baseline. On an unexpected branch or dirty tree, select an appropriate isolated worktree and coordinate file ownership.
