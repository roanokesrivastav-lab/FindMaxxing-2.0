# 6.1 — Real walking routes

**Team priority: Must.** Area: Dependable walking plans. Recorded 2026-11-11 as one shared decision for all three founders.

## Implementation prompt

Implement only the selected scope of ticket **6.1**. First read [the common contract](../../briefs/fable-5.2/README.md), [the current decisions](../decisions.md), [dependency reductions](../dependencies.md), and [batch 04](../../briefs/fable-5.2/04-routing-foundation.md). That batch contains this ticket’s behavioral acceptance criteria, likely components and required tests. Follow it rather than the superseded historical order.

Reviewed baseline: **Planned**. Inspect existing code and finish only the missing selected behavior. The baseline label is dated evidence, not a fresh verification result.

## Prerequisites and scope

00 routing spec revalidated; no outing UI needed for these pure/adapted foundations.

Honor the batch’s narrow scope and the confirmed Must/Later snapshot. Do not implement a Later feature as an implicit prerequisite.

## Acceptance and verification

1. Write a ticket-specific contract with objective, allowed components, out-of-scope behavior, acceptance and tests before edits.
2. Satisfy this ticket’s applicable acceptance criteria in [the batch prompt](../../briefs/fable-5.2/04-routing-foundation.md#acceptance-criteria), preserving all exclusions and existing paid/privacy contracts. Do not treat other tickets in the batch as already built.
3. Exercise the real action/route/RPC and demo path; run the batch’s relevant [required tests](../../briefs/fable-5.2/04-routing-foundation.md#required-tests), plus the common quality gate before a ticket commit. Real-Postgres races are required where specified; skip is not pass.
4. Complete the evidence template in [implementation/evidence-template.md](../evidence-template.md) as `docs/features/6-1.md` or the existing ticket evidence file. Update [progress.md](../progress.md) with the commit and evidence, without changing priority.
5. Independent Codex review remains required by AGENTS.md. A new/revised high-risk contract must be preflighted before its implementation. Continue only independent ready Must work while blocked.

## Exclusions

All [Later features](../later-features.md), including waitlists/offers, full camera restoration, generic tip freshness and import UI, remain excluded. Preserve unfinished Later work on its own branch; do not delete existing functionality to enforce a priority label. Never merge, deploy, run hosted mutations or expose private data under this ticket.
