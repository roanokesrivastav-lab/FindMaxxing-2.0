# Proposed founder roadmap — 2026-11-11

**Founder priorities: confirmed. Delivery order: proposed.** One shared decision represents all three founders: Must for every row in today’s questionnaire except the named Later items. No separate votes, vote averages or missing-ballot placeholders remain. No Cut items were selected.

## Read this before starting

This roadmap supersedes the historical build order only where the November 11 priorities conflict. Behavioral decisions in [founder-decisions.md](founder-decisions.md) remain binding, including **Has room** as the default 2.4b availability filter. Priority is separate from implementation/verification status. The questionnaire contains 57 grouped rows: **46 Must and 11 Later**, including already-built foundations/specs and grouped tickets. These counts are not completion points or a promise of 46 new builds.

Machine-readable decisions: [founder-priorities-2026-11-11.json](founder-priorities-2026-11-11.json). Copy-ready execution contract: [Fable 5.2 start here](briefs/fable-5.2/README.md).

## Codex preflight: Approved with required changes

Approved for this proposed plan and prompt pack; no application implementation is approved merely by creating it. Required changes before the affected code starts:

1. Resolve the dirty/staged 4.4 baseline without discarding or shipping deferred waitlist work. Verify current HEAD, actual migrations and in-flight ownership.
2. Amend and independently preflight series/native participant contracts so Must work does not require waitlist/offer states, while preserving capacity, legacy-client and paid fulfillment safety.
3. Split minimal map-layout corrections from deferred selection/camera/filter/scroll persistence. Filters and native preview-only layout do not need full 2.2.
4. Split contributor occasion-note authorship/moderation from deferred tip confirmation/freshness. Contributor helpfulness feedback must not implement 2.6 or 7.3 implicitly.
5. Write/preflight the R4 weekly-memories privacy/attendance/audience contract before code. Must is priority, not evidence that the former stub is implementation-ready.

The team need not revote these priorities. Technical contract reviews remain required under AGENTS.md; a newly proposed dependency reduction is not a blanket approval to improvise a risky database design.

## Handoff contract

- **Objective:** implement the confirmed Must experience in reviewable batches, leaving Later work out.
- **Allowed scope:** the selected tickets below, minimal explicitly reviewed prerequisites, demo parity, pilot flags, meaningful checks and evidence notes.
- **Likely components:** onboarding/Explore/map, event/series/notifications, places/saves/media, routing/itineraries, new outings/local modules, shared contracts, Supabase migrations and apps/mobile. Each prompt narrows its files.
- **Acceptance:** each batch’s listed behavior plus privacy, capacity, time-zone, API and compatibility invariants; every Must row traced to code/spec/evidence or an explicit blocker.
- **Required tests:** focused real-code-path tests, npm run check per implementation ticket; appropriate e2e/a11y, mobile checks, role-separated RLS, real-Postgres races and separate hosted/device proof.
- **Must not change:** Later priorities, rejected design directions, unrelated staged work, private data boundaries, existing paid behavior, migration history or production state.

## Recommended sequence

The default is sequential prompts 00–10. Safe independent work may move earlier after its prerequisites are verified; no automatic parallel-agent instruction is given. Outings follow the **Must Events subset**, so deferred 4.4 does not hold all of M5 hostage. Routing foundations may run before map travel filters; metrics start with the first useful-save flow.

| Batch | Deliverable | Ticket scope | Copy-ready prompt |
| --- | --- | --- | --- |
| 00 | Baseline and remove deferred dependency assumptions | 0.1 / 0.3, 1.1, 3.3, 4.0, 4.2, 4.3, 4.pre, 5.0, 6.0 | [00-baseline-and-spec-amendments.md](briefs/fable-5.2/00-baseline-and-spec-amendments.md) |
| 01 | Onboarding and first useful map | 1.2, 1.3 | [01-onboarding.md](briefs/fable-5.2/01-onboarding.md) |
| 02 | Complete the Must Events product | 4.1, 4.5a, 4.5b, 4.6, 4.8, 1.5 | [02-events-and-series.md](briefs/fable-5.2/02-events-and-series.md) |
| 03 | Places and a useful private library | 2.5, 2.7, 2.8, 3.1, 3.2, 3.6 | [03-places-and-library.md](briefs/fable-5.2/03-places-and-library.md) |
| 04 | Walking adapter and deterministic feasibility | 6.1, 6.2 | [04-routing-foundation.md](briefs/fable-5.2/04-routing-foundation.md) |
| 05 | Readable map and honest filters | 2.1, 2.4a, 2.4b, 4.7 | [05-explore-and-filters.md](briefs/fable-5.2/05-explore-and-filters.md) |
| 06 | Shared decisions after the Must Events release | 5.1, 5.2, 5.3, 5.4, 5.5 | [06-outings.md](briefs/fable-5.2/06-outings.md) |
| 07 | A plan the group can reopen and edit | 6.3, 6.4 | [07-shared-itinerary.md](briefs/fable-5.2/07-shared-itinerary.md) |
| 08 | Fresh local information and weekly memories | 7.1, 7.2, 7.4, R4 | [08-local-and-memories.md](briefs/fable-5.2/08-local-and-memories.md) |
| 09 | Native parity for the selected journey | 8.1a, 8.1b, 8.1c–e | [09-native.md](briefs/fable-5.2/09-native.md) |
| 10 | Measure the whole journey and prepare release evidence | 8.2, 8.3, 8.4a/b | [10-journey-and-release.md](briefs/fable-5.2/10-journey-and-release.md) |

## Dependency changes for this release

| Old coupling | Proposed Must path | Remains Later |
| --- | --- | --- |
| 4.5a series → 4.4 waitlist | Revised occurrence/series + capacity/paid contract, independently preflighted; reject full sessions honestly | Queues, seat offers, offer expiry and offer UI |
| 2.4a filters / 8.1a native → 2.2 | Current-surface selection + preview-only map layout; separate results mode | Restoring camera/selection/filter/scroll across navigation |
| 2.7 → 2.6 | Independent contributor occasion note with author, moderation and evidence link | Generic tip confirmation/freshness/correction system |
| 7.4 contributor feedback → provenance/post-visit | Explicit helpful action on attributed contribution, honest deduped aggregate | 2.6 freshness and 7.3 post-visit prompt |
| M5 after all historical M4 | After independently verified Must event contracts/series/notifications | 4.4 remains a later extension |
| 8.1b grouped RPC + offers | Safe native join/leave and compatible admission contract | Waitlist/offer UI and background expiry |
| R4 stub → unspecified future | Spec, privacy/attendance tests, then opt-in shared-content implementation | No private/unposted content or inferred attendance |

## Complete priority record

The implementation statuses below are the November 11 source-review baseline, not results of running this roadmap.

### Design and onboarding

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 1.1 | Design tokens and primitives | **Must** | Built locally |
| 1.2 | Six-interest thumbnail picker | **Must** | Partial |
| 1.3 | First-map arrival | **Must** | Partial |
| 1.4 | Social context line | **Later** | On hold |
| 1.5 | Quiet Events tab | **Must** | Partial |

### Explore and place decisions

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 2.1 | Map clustering | **Must** | Planned |
| 2.2 | Selection and camera restore | **Later** | Partial |
| 2.4a | Time and travel filters | **Must** | Partial |
| 2.4b | Has room availability filter | **Must** | Planned |
| 2.5 | Photo-first place decisions | **Must** | Partial |
| 2.6 | Tip provenance and freshness | **Later** | Planned |
| 2.7 | Best for / less suited | **Must** | Planned |
| 2.8 | Public and personal photos | **Must** | Planned |
| 4.7 | Intent-aware pins and venue sessions | **Must** | Partial |

### Personal library and imports

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 3.1 | Richer saves | **Must** | Partial |
| 3.2 | Library tools | **Must** | Partial |
| 3.3 | Matching/provider specification | **Must** | Spec only |
| 3.4a | Parse pasted Notes | **Later** | Planned |
| 3.4b | Confirm private imports | **Later** | Planned |
| 3.5 | Single-link importer | **Later** | Planned |
| 3.6 | Pick from my saves | **Must** | Planned |

### Events and recurring groups

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 4.0 | Event foundation specification | **Must** | Spec only |
| 4.1 | Editorial event detail | **Must** | Partial |
| 4.2 | Structured activity details | **Must** | Built locally |
| 4.3 | Attendance and readiness | **Must** | Built locally |
| 4.4 | Waitlist and expiring offers | **Later** | In progress |
| 4.5a | Recurring series and host tools | **Must** | Planned |
| 4.5b | Permanent series page | **Must** | Planned |
| 4.6 | Material-change notifications | **Must** | Partial |
| 4.8 | Optional Party poster | **Must** | Planned |
| 4.pre | Real-Postgres concurrency harness | **Must** | Partial |

### Shared outings, after Events

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 5.0 | Outings specification | **Must** | Spec only |
| 5.1 | Outing core and invites | **Must** | Planned |
| 5.2 | Private-save shortlist | **Must** | Planned |
| 5.3 | Yes / Fine / Cannot + lock | **Must** | Planned |
| 5.4 | Browser invite and sign-in return | **Must** | Planned |
| 5.5 | Start outing from an event | **Must** | Planned |

### Dependable walking plans

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 6.0 | Routing and feasibility spec | **Must** | Spec only |
| 6.1 | Real walking routes | **Must** | Planned |
| 6.2 | Deterministic feasibility checks | **Must** | Planned |
| 6.3 | Shared versioned itinerary | **Must** | Planned |
| 6.4 | Itinerary editor | **Must** | Planned |

### Local knowledge and return visits

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 7.1 | Flash maps | **Must** | Planned |
| 7.2 | Live reports pilot | **Must** | Planned |
| 7.3 | Optional post-visit action | **Later** | Partial |
| 7.4 | Contributor feedback | **Must** | Planned |

### Native and release

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| 0.1 / 0.3 | Security, flags and pilot seed | **Must** | Partial |
| 8.1a | Native Explore parity | **Must** | Planned |
| 8.1b | Native event RPC and offer UI | **Must** | Planned |
| 8.1c–e | Native outing, invite and itinerary | **Must** | Planned |
| 8.2 | Full golden-journey e2e | **Must** | Partial |
| 8.3 | Pilot metrics | **Must** | Partial |
| 8.4a/b | Candidate release gate | **Must** | Not approved |

### Research extras and deferred work

| Ticket | Feature | Team decision | Reviewed baseline |
| --- | --- | --- | --- |
| R2 | Opt-in need-players alerts | **Later** | Stub |
| R3 | Lightweight clubs | **Later** | Stub |
| R4 | Weekly outing memories | **Must** | Stub |
| X1–X4 | Deferred 20 points | **Later** | Deferred |

## What Later means

Do not start these extensions in the Must run. Keep existing corresponding behavior working; do not delete the staged waitlist work or remove existing comparisons/messages/payments.

- **1.4 — Social context line**.
- **2.2 — Selection and camera restore**.
- **2.6 — Tip provenance and freshness**.
- **3.4a — Parse pasted Notes**.
- **3.4b — Confirm private imports**.
- **3.5 — Single-link importer**.
- **4.4 — Waitlist and expiring offers**.
- **7.3 — Optional post-visit action**.
- **R2 — Opt-in need-players alerts**.
- **R3 — Lightweight clubs**.
- **X1–X4 — Deferred 20 points**.

The deferred-20 row expands to X1 paid curator marketplace, X2 broader social/bulk-media imports, X3 multi-city and non-walking routes, and X4 richer taste/progression. All four are Later. R4 weekly outing memories is **Must**, not silently deferred alongside R2/R3. Ticket 2.3’s map-plus-list bottom panel stays dropped under the earlier behavioral decision; “everything else Must” does not resurrect a rejected/non-questionnaire feature.

## Recorded product choices carried forward

- Mix Local editorial and Quiet utility by task; photography-led, role-based surfaces, warm paper palette/current fonts. No Social journal or calendar date block.
- Six thumbnail onboarding interests, More interests, Skip; accepted choices match first-map filtering. Social context line is Later.
- Map is preview-only at all widths with a separate results mode. Has room is the default availability filter, distinct from the number needed to reach minimum attendance. No default Needs players filter.
- Events emphasizes joined/followed usual sessions with explicit states. Follow never RSVPs. Readiness by default; host-selected Party poster off by default. Newcomer logistics near the action.
- Places lead with a photo/fallback. Rating and count stay together; personal/friends/community evidence separated; friends’ actual reviews first. No opinion summaries or friend scores.
- Best for/Less suited stays attributed. Generic tip provenance/freshness is Later, so no invented confirmation/recency labels.
- Public photos team-uploaded/permissioned. Personal private photo only at first rating/review, library allowed; never gates save/join/plan/Visited and never leaks to friends/groups/shares.
- One-tap saves first, optional organization later; separate community place facts from owner-only reasons/tags/source/recommender. Bulk edit/undo/export/picker Must; import flows Later.
- Outings follow Events, retain the vote and walking-plan journey, with hard constraints that cannot be outvoted.
- Routing is walking-first behind adapters/fakes until configured. The 6.0 spec permits persisting our plan/verdict only, not restricted provider legs; revalidate on open and label unknowns honestly.
- Local pilot includes flash maps, expiring live reports, evidence-backed contributor feedback and opt-in weekly memories. Need-players alerts/lightweight clubs/post-visit prompts remain Later.

## Review checkpoints

1. **After batch 01:** five newcomers try choose/skip → first useful save. Record first wrong tap, expected result vs actual and time to useful save. Capture current mobile screens.
2. **After batches 02–05:** hosts create recurring sessions; founders inspect onboarding/map/place/library/event states together, including no-photo/full/cancelled/denied states.
3. **After batch 07:** three friends complete a real permitted test outing → decision → anchored plan. Compare predicted vs actual logistics; record host effort and time to decision.
4. **After batch 09 and before release:** review Must coverage, local/shared privacy evidence and separate web/iOS/Android gate results. No automatic release approval.

At each checkpoint keep this November 11 priority snapshot unchanged. Record new requests in a dated change log with the affected ticket, behavior to change, reason/evidence, and explicit Must/Later/Cut change if any. Update individual completion evidence separately. No calendar reminder or scheduled review is created by this plan.

## Completion ledger at creation

- This turn creates planning artifacts and records the shared decision. No Fable execution was dispatched.
- Existing 1.1, 4.2 and 4.3 are reuse/verify candidates, not newly completed by this plan. Specs 3.3/4.0/5.0/6.0 are not functioning product features.
- Staged 4.4 is Later and remains untouched. Application code, migrations and existing test changes are outside this planning edit.
- Current hosted deployment and actual phone runtime have not been reverified; release remains unapproved.

## Human inputs that cannot be faked

Pilot neighborhood, permissioned real photos/tips, 3–5 dependable hosts/curator and real usability participants. Provider credentials/terms and hosted/device execution remain explicit integration tasks; deterministic demos cannot stand in for them. The Beli reference check may inform a future iteration but does not block friends’ actual reviews first.

## Verification of this planning update

All 57 feature rows were checked against the priority snapshot; all 11 batch prompts have objective, scope, acceptance, tests and exclusions; local Markdown links resolve. The shared-decision artifact’s filters/export and preservation of previous local scratch data were exercised offline; its browser layout was not reverified.

Repository-named baseline tests ran against unchanged staged application code: **40 files, 802 passed / 2 failed**; both failures are in the existing demo-repository event work. Batch 00 records the full-event `waitlisted` behavior and capacity-message mismatch. Application code was not fixed or declared green. See [verification evidence](roadmap-verification-2026-11-11.md).
