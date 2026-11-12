# 1.3 — First-map arrival

**Team priority: Must.** Area: Design and onboarding. Recorded 2026-11-11 as one shared decision for all three founders.

## Implementation prompt

Implement only the selected scope of ticket **1.3**. First read [the common contract](../../briefs/fable-5.2/README.md), [the current decisions](../decisions.md), [dependency reductions](../dependencies.md), and [batch 01](../../briefs/fable-5.2/01-onboarding.md). That batch contains this ticket’s behavioral acceptance criteria, likely components and required tests. Follow it rather than the superseded historical order.

Reviewed baseline: **Partial**. Inspect existing code and finish only the missing selected behavior. The baseline label is dated evidence, not a fresh verification result.

## Prerequisites and scope

00 foundation inventory; existing 1.1 and flags verified.

Honor the batch’s narrow scope and the confirmed Must/Later snapshot. Do not implement a Later feature as an implicit prerequisite.

## Acceptance and verification

1. Write a ticket-specific contract with objective, allowed components, out-of-scope behavior, acceptance and tests before edits.
2. Satisfy this ticket’s applicable acceptance criteria in [the batch prompt](../../briefs/fable-5.2/01-onboarding.md#acceptance-criteria), preserving all exclusions and existing paid/privacy contracts. Do not treat other tickets in the batch as already built.
3. Exercise the real action/route/RPC and demo path; run the batch’s relevant [required tests](../../briefs/fable-5.2/01-onboarding.md#required-tests), plus the common quality gate before a ticket commit. Real-Postgres races are required where specified; skip is not pass.
4. Complete the evidence template in [implementation/evidence-template.md](../evidence-template.md) as `docs/features/1-3.md` or the existing ticket evidence file. Update [progress.md](../progress.md) with the commit and evidence, without changing priority.
5. Independent Codex review remains required by AGENTS.md. A new/revised high-risk contract must be preflighted before its implementation. Continue only independent ready Must work while blocked.

## Exclusions

All [Later features](../later-features.md), including waitlists/offers, full camera restoration, generic tip freshness and import UI, remain excluded. Preserve unfinished Later work on its own branch; do not delete existing functionality to enforce a priority label. Never merge, deploy, run hosted mutations or expose private data under this ticket.
