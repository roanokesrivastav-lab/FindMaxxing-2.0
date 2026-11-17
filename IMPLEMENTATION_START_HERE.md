# Implement the founder-approved Must roadmap

This is the starting point for Claude, Fable 5.2 or another coding agent. The repo contains the decisions, detailed batch prompts, individual Must ticket cards, existing specs, verification rules and review templates. Founders do not need to paste the chat history.

**Team decision: 46 Must / 11 Later / no Cut questionnaire rows.** These include foundations/specs/grouped tickets and are not a completion percentage. **2.4b defaults to Has room. R4 weekly outing memories is Must.**

## One prompt to give Claude

```text
Do the next task on the FindMaxxing roadmap.
```

Claude's repository instructions expand this short prompt into the full runner. Start with the
[current checkpoint](docs/implementation/founder-fable-handoff.md) and
[progress ledger](docs/implementation/progress.md). The current starting task is 0054 for 4.5a.

## Before using the prompt

From a clean checkout, update `main`:

```bash
git switch main
git pull --ff-only origin main
```

Open the repository in Claude Code and select Fable. The runner starts a working branch from
the updated `origin/main`, completes the next ready Must ticket, and continues through the ledger
in dependency order. Preserve local changes and resume existing work on its own branch.
Coordinate with the other founders before starting the same ticket.

Commit `7aa6c48` on **`codex/deferred-waitlist-snapshot-2026-11-11`** preserves unfinished waitlist code with known failures. It is not the implementation base and must not be merged or applied to staging merely to “get everything.” See [current baseline](docs/implementation/current-baseline.md).

## Read in order

1. [Current continuation checkpoint](docs/implementation/founder-fable-handoff.md) and [runner prompt](docs/implementation/claude-runner-prompt.md).
2. [Confirmed decisions](docs/implementation/decisions.md) and [all 57 priorities](docs/implementation/feature-index.md).
3. [Delivery plan](docs/implementation/delivery-plan.md), [dependency reductions](docs/implementation/dependencies.md) and [current baseline](docs/implementation/current-baseline.md).
4. [Common coding contract](docs/briefs/fable-5.2/README.md), then [batch 00](docs/briefs/fable-5.2/00-baseline-and-spec-amendments.md).
5. [Individual Must tickets](docs/implementation/must-features.md), [progress ledger](docs/implementation/progress.md), [testing](docs/implementation/testing.md) and [review checklist](docs/implementation/review-checklist.md).
6. [Today’s visual review](docs/founder-call/2026-11-11/README.md). Screenshots are dated demo captures; mockups are proposed, not implemented.

## Authority

AGENTS.md and current explicit user instructions govern workflow. The November 11 team snapshot controls feature priority, and founder-decisions.md controls behavior. The current handoff defines the temporary review workflow and known findings. Use the historical roadmap for context and keep deferred dependencies out. Follow beta-build-rules.md for ordinary reversible choices.

The user authorized committing and pushing this handoff and preserving the existing WIP snapshot. That is not blanket authorization for future agents to deploy, merge, expose private data or mutate hosted databases. Existing build/test/integration rules still apply.
