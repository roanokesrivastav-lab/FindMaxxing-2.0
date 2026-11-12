# Existing specifications and source precedence

Read a spec fully before implementing its contract; old source line numbers are hints, not guaranteed current locations.

| File | Role / caveat |
| --- | --- |
| [AGENTS.md](../../AGENTS.md) | Repository workflow, preflight and independent verification |
| [founder priorities](../founder-priorities-2026-11-11.json) | Confirmed feature inclusion; one shared team decision |
| [founder decisions](../founder-decisions.md) | Accepted behavior, updated November 11 |
| [new proposed roadmap](../proposed-roadmap-2026-11-11.md) | Must delivery sequence and deferred dependency reductions |
| [batch contract](../briefs/fable-5.2/README.md) | Shared implementation and evidence rules |
| [beta-build-rules](../beta-build-rules.md) | Existing flags/testing/commit/provider restrictions; new priority banner applies |
| [historical roadmap](../roadmap-80.md) | Technical reference only where consistent with current priorities |
| [1.1](../features/1.1.md), [0.3](../features/0.3.md) | Existing design primitives/flags; reuse and reverify |
| [3.3](../features/3.3.md) | Matching/provider design only; actual import flows are Later |
| [4.0](../features/4.0.md) | Approved historical event spec; queue/offer dependencies must be narrowed/preflighted for the Must release |
| [4.2](../features/4.2.md), [4.3](../features/4.3.md) | Existing committed activity/readiness implementation evidence |
| [5.0](../features/5.0.md) | Outing spec; after Events now means the verified Must subset |
| [6.0](../features/6.0.md) | Walking/feasibility and provider-storage constraints; adapter fake until configured |
| [paid flow repair](../payment-event-repair.md) | Existing payment/seat invariants to preserve |
| [native blockers](../native-release-blockers.md) | Dated native gaps, not proof of runtime parity |
| [beta gate](../beta-gate.md) | Historical release checklist; update to actual candidate/head and platform evidence |

A spec being present does not mean its feature is implemented. Later has priority over an older Needs edge. Do not execute `docs/briefs/4.0-build-prompt.md` wholesale: it includes deferred 4.4. Revised high-risk contracts still need preflight rather than being implicitly approved by this index.
