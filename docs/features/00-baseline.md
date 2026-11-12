# Batch 00 — baseline and spec amendments

Priority: Must (tickets 0.1 / 0.3, 1.1, 3.3, 4.0, 4.2, 4.3, 4.pre, 5.0, 6.0). Run 2026-11-11 from
[the batch prompt](../briefs/fable-5.2/00-baseline-and-spec-amendments.md). Status: **baseline
verified locally; spec amendments PROPOSED and awaiting independent Codex preflight.** No application
code changed in this batch.

## Contract

- **Objective:** record the real starting point, reuse what is built, and write the narrowed
  contracts the Must scope needs so Later work is not an implicit prerequisite.
- **Allowed files:** `docs/` only.
- **Out of scope:** any Later row; executing the archived `docs/briefs/4.0-build-prompt.md`; touching
  the deferred waitlist snapshot; hosted databases; provider calls.

## 1. Checkout, as found

| Fact | Value |
| --- | --- |
| Branch | `codex/founder-implementation-handoff-2026-11-11` |
| HEAD at start | `4eea5e5` "Document the founder-approved implementation roadmap" |
| Source checkpoint | `f2eb957` (4.3). `git diff --stat f2eb957 4eea5e5 -- src tests supabase apps packages` is empty: the handoff commit is documentation only (91 files, all under `docs/` or root docs) |
| Working tree at start | Clean. No staged or unstaged files, so there was no dirty-file ownership to resolve |
| Migration head | `0051_session_rules_and_readiness.sql`. `0052` is absent |
| Deferred snapshot | `codex/deferred-waitlist-snapshot-2026-11-11` at `7aa6c48`, local branch only. Not merged, not cherry-picked, not read into this base |
| Other worktrees | Eight older `claude/*` worktrees under `.claude/worktrees/` and one detached scratch worktree. None touched |

**Blocker for the other founders (not for this run):** `git ls-remote --heads origin` lists
`beta-readiness`, `events-4.0`, `main`, `tier1-owner-controls` and two `claude/*` branches. **Neither
`codex/founder-implementation-handoff-2026-11-11` nor `codex/deferred-waitlist-snapshot-2026-11-11`
is on origin**, so the `git switch --track origin/...` step in `IMPLEMENTATION_START_HERE.md` fails
for anyone else, and the snapshot exists on one machine only. Nothing was pushed in this run; pushing
is the owner's call.

## 2. Baseline checks (unchanged source)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck, lint, tests, build | `TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres npm run check` | **exit 0.** Typecheck and lint clean; **70 test files, 1,172 tests passed, 0 skipped**; build compiled |
| Same, without a database URL | `npm run check` (first attempt) | Typecheck and lint clean; 70 files, **1,167 passed, 5 skipped** (the real-PostgreSQL suite); build **did not complete: the disk was full** (`ENOSPC`). Environment failure, not a code failure. Rerun above after space was freed |
| Mobile typecheck | `npm run typecheck --workspace @findmaxxing/mobile` | exit 0 |
| End to end | demo-mode build, then `npm run e2e` | **19/19 passed** (390×844, fresh in-memory demo store) |
| Accessibility | `npm run a11y` | **24 pages × 2 widths: 0 serious/critical, 0 other** |

The two failures recorded in the batch prompt (`tests/demo-repository.test.ts`, a full event resolving
to `waitlisted`, and the capacity message) **do not occur on this base**: they belonged to the staged
4.4 work, which is on the snapshot branch. `tests/demo-repository.test.ts` passes here.

### Environment facts the next agent needs

- **Real PostgreSQL.** The Homebrew PostgreSQL 17 on port 5432 needs a password this run did not
  have, and `TEST_DATABASE_URL` is not set in any env file. A throwaway trust-auth PostgreSQL 17.11
  cluster left by an earlier session is listening on `localhost:54329` (data directory in that
  session's scratch folder); it was used above. It is disposable and will not survive a reboot. A
  fresh one takes `initdb -U postgres --auth=trust` plus `pg_ctl start -o "-p <port>"`.
- **`.env.local` points at a hosted Supabase project.** `NEXT_PUBLIC_*` values are inlined at build
  time, so a plain `npm run build` produces a Supabase-mode build even though the demo server passes
  empty values at runtime. The first e2e attempt on such a build never started (the health check timed
  out reading the hosted `categories` table as anon; no test step ran and nothing was written).
  **Build for browser suites with the Supabase variables empty:**
  `NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= NEXT_PUBLIC_FEATURES= npm run build`.
  Never drive a browser suite against a build made with `.env.local`.
- **Disk.** The machine ran out of space during the first build. `.next/` was deleted with the
  owner's approval and is rebuilt by any build.

## 3. Reuse and reverification (no rebuild)

| Ticket | Evidence on this base | Status after batch 00 |
| --- | --- | --- |
| **1.1** tokens and primitives | `tests/ui-primitives.test.ts` passes in the run above; primitives and tokens present in `src/components/ui` and `globals.css` | IMPLEMENTED-LOCAL, reverified. Used as-is by 1.2 and 1.3 |
| **0.3** pilot flags and seed | `tests/pilot-flags.test.ts` passes; `vitest.config.mts`, `.env.development` and `scripts/lib/demo-server.mjs` still enable `pilot` | IMPLEMENTED-LOCAL, reverified |
| **0.1** security | 0.1a is built and recorded in `docs/security-audit-repair.md` ("awaits Codex verification"); its suites pass above, including the two-connection limiter race. **0.1b (signed render beacon and ad billing, migration 0041 reserved) has no brief and is not started** | 0.1a IMPLEMENTED-LOCAL; **0.1b NOT STARTED, needs a brief and preflight (security)** |
| **4.2** activity details and time zone | `tests/event-activity.test.ts` and related suites pass; migration 0050 applies on PGlite and PostgreSQL 17 | IMPLEMENTED-LOCAL, reverified |
| **4.3** attendance and readiness | `tests/session-rules.test.ts` passes; migration 0051 applies on both engines. Its own NOT VERIFIED items stand: hosted cron, push delivery, and the `decide_sessions`-vs-join race (now listed as required in 4.0 A1.6) | IMPLEMENTED-LOCAL, reverified; the three limits remain NOT VERIFIED |
| **4.pre** real-PostgreSQL harness | `tests/helpers/postgres.ts` gives two independent connections on localhost only; its self-test and the 0040 limiter race suite ran (the 5 tests that skip without a database all ran). `.github/workflows/ci.yml` provides a `postgres:17` service and sets `TEST_DATABASE_URL`, and the helper throws when `CI` is set without it | Harness IMPLEMENTED-LOCAL, reverified. **No event race suite exists yet**; each arrives with the ticket that introduces its path (4.0 A1.6) |

None of these is INDEPENDENTLY VERIFIED: that needs Codex.

## 4. Integration recommendation

1. **Use this branch as the Must base.** It is the reviewed 4.3 checkpoint plus documents, it is
   green, and it does not contain 4.4.
2. **Keep the snapshot quarantined.** Do not merge or cherry-pick `7aa6c48`. Keep 0052 reserved; the
   next Must events migration is 0053 (4.0 A1.7).
3. **0052 on hosted databases is unknown.** This run used no hosted access. Before any hosted rollout
   the integration owner checks the target's migration history. If 0052 is there, it is not dropped or
   renumbered: a reviewed compatibility migration and rollout note are written first.
4. **Push both `codex/` branches** (owner's decision) so the handoff works for the other founders and
   the snapshot has a second copy.

## 5. Contract amendments written

| Spec | Change | Commit | Preflight |
| --- | --- | --- | --- |
| [4.0](4.0.md#amendment-a1-2026-11-11--must-event-subset-without-waitlists) | Amendment A1: going-only attendees, one capacity definition, full free sessions refused, no queue or offers, legacy writes kept, reduced race list | `c06f1ad` | **Required (high risk).** Blocks 4.5a, 4.5b, 4.6, 8.1b, 5.5 |
| [5.0](5.0.md#amendment-a1-2026-11-11--after-events-means-after-the-must-event-subset) | Amendment A1: gate is the Must event subset; anchor reads `event_attendees` only; test plan re-read | `9c515b9` | **Required (membership, privacy).** Blocks 5.1–5.5 |
| [3.3](3.3.md) | Validation note: document only; B1/B2 deferred with the importers | `99f8023` | Not required (no contract change) |
| [6.0](6.0.md) | Validation note: plan-and-verdict persistence, provider unconfirmed, no purchase or call | `fbd995b` | Not required for the note. 6.3's schema is reviewed with batch 07 |

### Dependency reductions for later batches (criterion 5)

Recorded here so the batch that owns each ticket writes its contract on this basis. These are
proposed technical reductions, not new founder decisions.

- **2.7 Best for / Less suited without 2.6.** Its own table of occasion notes: author, place,
  occasion (small fixed list) plus short free text, created time, and the existing moderation status
  and report path. Display is the attributed note itself. **No** `last_confirmed_*`, "Still true?",
  correction flow, expiry, or any "confirmed" or "recent" label. New table with RLS and moderation:
  **preflight required** when batch 03 writes the contract.
- **2.4a / 2.4b filters without 2.2.** Filters act on the current surface only. No camera, selection,
  filter or scroll restoration across navigation, and no URL state added for it. The preview-only map
  layout (moving the desktop side drawer off the map tab) stays Must and belongs to batch 05; it is
  the one part of old ticket 2.2 that is not deferred.
- **8.1a native Explore without 2.2.** Pins, preview-only map and parity; no persistence.
- **8.1b native join/leave without 4.4.** The capacity-only path in 4.0 A1.3; no offer UI or
  background expiry.
- **7.4 contributor feedback without 2.6 / 7.3.** Explicit "helpful" on an attributed contribution,
  de-duplicated per viewer; no freshness, no post-visit prompt.
- **R4 weekly memories.** No spec exists. It needs one (attendance from the host-recorded
  `attended` flag, opt-in audience, retention, deletion) and a preflight before any code.

Observed while reading Explore for batch 01, for batch 05: `ExploreClient` still renders the results
list as a side drawer next to the map at desktop width, which the founder decision rules out at every
width. Not changed here.

## Acceptance evidence

| Criterion | Evidence | Result |
| --- | --- | --- |
| 1. HEAD, dirty files, migration head, baseline failures | §1, §2 | Done |
| 2. Clean-baseline recommendation excluding 4.4; 0052 rule | §4, 4.0 A1.7 | Done; hosted 0052 state NOT VERIFIED (no hosted access) |
| 3. Event contract without waitlists | 4.0 Amendment A1 | Written; **awaiting preflight** |
| 4. 5.0 after the Must event subset; tests re-read | 5.0 Amendment A1 | Written; **awaiting preflight** |
| 5. 2.7 without 2.6; filters/native without persistence | §5 list | Recorded for batches 03, 05, 09 |
| 6. 3.3 and 6.0 as documentation; no provider calls | Validation notes | Done; none made |
| 7. Preflight before dependent work; independent UI continues | §5 table; batch 01 proceeds | Preflight NOT YET OBTAINED |

## Adversarial review of the amendments

- **Overbooking through the paid path.** Reading the committed SQL showed `check_event_join` and the
  capacity floor in `guard_owner_event_change` still count attendees only, while `reserve_ticket` and
  `events_readiness` count live paid holds. A host can lower capacity under live holds on a priced
  event. A1.2 proposes the fix and a fallback; it is the main thing for the reviewer to test.
- **A fix that takes money without a seat.** Making the join trigger count holds naively would refuse
  `confirm_ticket`'s own insert. A1.2 rule 1 exempts the paid fulfilment insert and asks the reviewer
  to confirm.
- **Silent promotion of Later work.** A1.6 adds a source check that no path reads or writes
  `event_participants`, `waitlisted` or `offered`.
- **Orphaned outings.** 5.0 A1 adds "an anchored occurrence is never deleted by regeneration".
- **Old native clients.** Legacy direct writes and their policies stay, so no installed build loses
  join or leave.

## Remaining issues

- **Preflight required and not obtained:** 4.0 A1, 5.0 A1; later 2.7, R4, 0.1b.
- **Not verified:** hosted migration history (0052), hosted cron, push delivery, any device.
- **Owner actions:** push the two `codex/` branches; set a durable `TEST_DATABASE_URL` for local runs.

## Handoff

- Commits: `c06f1ad` (4.0), `9c515b9` (5.0), `99f8023` (3.3), `fbd995b` (6.0), and the commit that adds
  this file.
- Ready for independent review: yes, for the two amendments.
- Next ready ticket: **1.2**, then **1.3** (batch 01). Neither depends on a pending preflight.
