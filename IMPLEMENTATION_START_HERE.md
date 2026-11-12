# Implement the founder-approved Must roadmap

This is the starting point for Claude, Fable 5.2 or another coding agent. The repo contains the decisions, detailed batch prompts, individual Must ticket cards, existing specs, verification rules and review templates. Founders do not need to paste the chat history.

**Team decision: 46 Must / 11 Later / no Cut questionnaire rows.** These include foundations/specs/grouped tickets and are not a completion percentage. **2.4b defaults to Has room. R4 weekly outing memories is Must.**

## One prompt to give Claude

```text
Implement the founder-approved Must roadmap in this repository. Read IMPLEMENTATION_START_HERE.md and follow docs/implementation/claude-runner-prompt.md. Use the confirmed November 11 priority snapshot, begin with batch 00, reuse completed work, and continue through ready Must tickets in dependency order. Record progress and evidence in the repo. Do not implement Later features or reopen the founders’ choices. Pause only affected work for actual blockers or required independent reviews, and continue independent ready work. Do not merge or deploy.
```

## Before using the prompt

Use the clean handoff branch **`codex/founder-implementation-handoff-2026-11-11`**:

```bash
git fetch origin
git switch --track origin/codex/founder-implementation-handoff-2026-11-11
```

If you have local work, do not reset/clean or force a checkout. Ask the agent to inspect the checkout and use a separate worktree. If the branch already exists, switch to it normally and verify its upstream; do not create a duplicate or force-update it.

Commit `7aa6c48` on **`codex/deferred-waitlist-snapshot-2026-11-11`** preserves unfinished waitlist code with known failures. It is not the implementation base and must not be merged or applied to staging merely to “get everything.” See [current baseline](docs/implementation/current-baseline.md).

## Read in order

1. [Runner prompt](docs/implementation/claude-runner-prompt.md) — how to work without repeated product questions.
2. [Confirmed decisions](docs/implementation/decisions.md) and [all 57 priorities](docs/implementation/feature-index.md).
3. [Delivery plan](docs/implementation/delivery-plan.md), [dependency reductions](docs/implementation/dependencies.md) and [current baseline](docs/implementation/current-baseline.md).
4. [Common coding contract](docs/briefs/fable-5.2/README.md), then [batch 00](docs/briefs/fable-5.2/00-baseline-and-spec-amendments.md).
5. [Individual Must tickets](docs/implementation/must-features.md), [progress ledger](docs/implementation/progress.md), [testing](docs/implementation/testing.md) and [review checklist](docs/implementation/review-checklist.md).
6. [Today’s visual review](docs/founder-call/2026-11-11/README.md). Screenshots are dated demo captures; mockups are proposed, not implemented.

## Authority

AGENTS.md and current explicit user instructions govern workflow. The November 11 team snapshot controls feature priority; founder-decisions.md controls behavior. New scoped technical amendments require the existing preflight where high risk. Historical roadmap/specs are reference material, not permission to implement deferred dependencies. Ordinary reversible implementation choices are preauthorized under beta-build-rules.md; record them rather than repeatedly asking founders.

The user authorized committing and pushing this handoff and preserving the existing WIP snapshot. That is not blanket authorization for future agents to deploy, merge, expose private data or mutate hosted databases. Existing build/test/integration rules still apply.
