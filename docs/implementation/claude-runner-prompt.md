# Copy-ready Claude / Fable implementation runner

```text
Implement the confirmed Must roadmap for FindMaxxing 2.0.

Read in order: AGENTS.md; IMPLEMENTATION_START_HERE.md; docs/implementation/decisions.md; docs/founder-priorities-2026-11-11.json; docs/implementation/current-baseline.md; docs/implementation/dependencies.md; docs/briefs/fable-5.2/README.md; docs/implementation/progress.md. Then read the next batch prompt and its existing specs in full.

One shared founder decision represents all three founders. All 57 questionnaire rows are Must except the 11 Later rows in the JSON. Do not ask them to vote again. R4 weekly memories is Must. 2.4b defaults to Has room. Existing product preferences remain binding.

Resume from the latest handoff and progress ledger. Read docs/implementation/founder-fable-handoff.md for the current starting ticket and temporary review workflow. Never merge or cherry-pick the deferred waitlist snapshot into the Must base. Reuse completed work and resolve dependency reductions in explicit scoped briefs.

For each ready Must ticket: write its narrow contract; implement the applicable batch acceptance; keep demo and Supabase behavior equivalent; test the real code path, privacy and permission boundaries; run the required checks; record exact results, changed files and commit in docs/features/<ticket>.md and docs/implementation/progress.md. One commit per ticket. Never mix unrelated work, reset someone else's changes, alter applied migration history, or claim a skipped check passed.

After each ticket, inspect the ledger and continue the next independent ready Must ticket. At each batch boundary, write the review bundle and continue after the applicable checks and current review workflow are satisfied. If one ticket is blocked, record the exact dependency, verification or environment reason and continue independent ready work. Stop the run when all ready Must work is exhausted, a real permission or product ambiguity blocks everything, or the user asks to stop.

Do not ask routine questions about already-decided product preferences. Choose the existing spec's recommended reversible option, document it, and stay within scope. If a change could leak data, lose data, break deployed clients or change the selected product behavior, surface the concrete issue instead of guessing.

Respect pilot flags, privacy, known/unknown labels and installed SDK versions. No real external service calls/new keys under the deterministic build rules. Existing paid behavior stays working; no new paid scope. No Later imports, waitlists/offers, full map-state persistence, generic tip freshness, post-visit prompts, need-players alerts, clubs, X1-X4 or rejected map-plus-list panels.

Maintain loading, empty, error, pending and denied states. Record browser/mobile evidence truthfully. Real-Postgres races are mandatory for concurrent seat/decision/invite/series contracts. A typecheck or Expo web export is never native device approval.

Keep the plan and priority snapshot unchanged during implementation. Propose new product scope in a dated change-log entry; do not silently promote Later work. Leave a concise handoff at the end of each session so another founder's agent can resume from the ledger without chat history.

Do not merge, deploy, mutate hosted databases or widen sharing under this runner. Follow the existing per-ticket push rules and current session authorization. At the end report implemented/verified tickets, incomplete Must work, blockers, test evidence, commits and the next ready ticket. Release approval is separate for web/iOS/Android.
```

For a one-batch run use [the common contract](../briefs/fable-5.2/README.md) and the next named batch. Use the [current handoff](founder-fable-handoff.md) for review requirements. Subagents require separate authorization.
