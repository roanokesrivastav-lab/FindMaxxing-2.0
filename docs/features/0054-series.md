# 0054 — Recurring series and occurrences (4.5a)

Priority: Must. Branch `codex/0054-series-2026-11-16` from `main` at `debaee4` (the founder handoff base;
`origin/codex/founder-implementation-handoff-2026-11-11` is an ancestor of it). Status: **IMPLEMENTED-LOCAL, gate incomplete** (see Tests; the session hit its usage limit before `npm run check`, mobile typecheck and the demo-browser checks finished). Review workflow: Fable self-review under the
[founder handoff](../implementation/founder-fable-handoff.md); independent Codex checkpoints are paused.

This note is the scoped contract the handoff asks for before any schema edit, and then the evidence.
Sources: [4.0 §3, §4, §8, §10 and Amendment A1.4, A1.6, A1.9](4.0.md), the
[revision 3 preflight](amendments-r3-codex-review.md#40-events) items 2 and 3, the
[0053 verification](0053-admission.md), [batch 02](../briefs/fable-5.2/02-events-and-series.md).

## Contract

### Objective

A host can make a session repeat. The series is a template plus a weekly rule; each occurrence is an
ordinary row in `events` (D-A) with a stable id, its own attendees, chat, tickets and readiness. The
database generates occurrences four weeks ahead, idempotently, in the series' zone with the
first-instant DST rule, and lets the owner and authorized backup hosts edit one occurrence, edit this
and future ones, cancel one, or end the series, without ever deleting something a person touched.
Following a series is a separate state from going and never creates an attendee row.

### Allowed components and files

- `supabase/migrations/0054_event_series.sql` (new): tables, columns, one unique index, policies for
  the new tables, functions and triggers listed below; redefinitions of `guard_owner_event_change`,
  `enforce_rate_limit`, `prepare_account_deletion`, `set_event_price`, `set_session_rules`,
  `confirm_session`, `findmaxxing_private.can_host_event`, `findmaxxing_private.require_active_account`
  and `moderate_target`, each only as stated in this contract.
- Shared types (`packages/shared/src/types.ts`), the repository interface and both repositories
  (`src/lib/data/repository.ts`, `src/lib/data/supabase/repository.ts`, `src/lib/data/demo/*`), the
  demo store (new state version), server actions for events, the event form and event page (host entry
  points only), the notifications cron route (calls the generator), the function-grant allowlist fixture.
- Tests: new `tests/event-series.test.ts` (PGlite logic, RLS, demo parity) and
  `tests/event-series-pg.test.ts` (real PostgreSQL races and guard removals); existing suites updated
  only where this slice changes an inventory they assert.
- This note and the progress ledger.

### Prerequisites verified

- 0053 is independently verified locally (ledger). The 28-case 0053 race suite passes on this
  machine's disposable PostgreSQL 17.11 before any 0054 change (baseline, 2026-11-16).
- Migration numbers: 0054 for this slice; 0055 reserved for notifications; 0052 reserved and absent.

### Out of scope (stays where the handoff puts it)

- **0055 / 4.6:** `change_seq`, the per-change dedupe key, the `series_update` type, the private
  viewer-aware `can_view_event`, any new send rule. In this slice the existing trigger
  `notify_on_event_change` is the only sender for going recipients on authenticated changes (A1.5),
  and service-origin changes (the generator) send nothing (D-F: followers are not told about routine
  generation).
- **4.5b** series page, **1.5** Events tab, **4.1** newcomer block, **4.8** poster (`card_style` is
  not added to the template here; 4.8 adds it under its own write contract), **5.x** Outings (only
  the compatibility hook below), **6.3** itinerary persistence, every Later row (waitlists, offers,
  imports, tip freshness, post-visit prompts, clubs, X1–X4).
- Series-level pricing. An occurrence can be priced with the existing `set_event_price`.
- Native (`apps/mobile`) series UI (8.1b). The native direct insert and delete keep working.
- Any hosted database, deploy, merge or push.

### Schema

`event_series`: `id`, `owner_id` (→ profiles, cascade), `title`, `description`, `category_slug`,
`place_id` (→ places, set null), `location_name`, `address`, `lat`, `lng`, `time_zone` (validated
by `valid_time_zone`), `rule` jsonb (`{"freq":"weekly","interval":1–4,"weekdays":[1–7 ISO,
distinct, non-empty],"start_local":"HH:MM","duration_minutes":15–720}` checked by
`valid_series_rule`), `starts_on` date, `ends_on` date null, `capacity`, `min_attendance`,
`decision_lead_minutes` (null or 15–10080), `activity_details` (same check as events), `status`
(`active` / `paused` / `ended` / `removed`), `rule_version` int, `created_at`, `updated_at`.
`event_series_tags(series_id, interest_slug)`. `event_series_hosts(series_id, user_id, role
owner|backup, added_at)`, exactly one owner row equal to `owner_id` (trigger).
`event_series_followers(series_id, user_id, created_at)`.

`events` gains `series_id` (→ event_series, cascade), `series_local_date` date, `overridden text[]
not null default '{}'`, `removed_with_series boolean not null default false`; check
`(series_id is null) = (series_local_date is null)`; **plain unique index**
`events_series_local_date_key (series_id, series_local_date)` (the `on conflict` arbiter).
`event_attendees` gains `attended boolean` (null = not recorded). None of the new `events` columns is
in the column-level update grant; they change only through the functions below.

Interval anchor: "every N weeks" counts ISO weeks (Monday start) from the week of `starts_on`.
Occurrence start = `series_local_date + start_local` in `time_zone` resolved to the **first instant**
(D-G; the spring-forward gap resolves to the same clock reading in the earlier offset), `ends_at =
starts_at + duration`. The shared vector for SQL and TypeScript: 2026-03-08 02:30 New York →
07:30Z; 2026-11-01 01:30 New York → 05:30Z. Generation horizon: local today to local today + 28 days.

### Lock order (A1.9) and the resolution of preflight item 2

One order for every path that this migration adds or replaces:

1. `account_close:<user>` advisory locks, ascending user id: the acting user and the series owner
   (the owner is the user every generated attendee row is for);
2. the series row `for update`;
3. event rows, ascending `id`;
4. ticket rows (reached only through existing triggers);
5. attendee rows;
6. conversation rows, in the order of their events, then messages and notifications.

**The recorded cycle.** A legacy direct write by a signed-in user locks its row first and takes
the caller's account lock afterwards, inside the row-level `block_suspended_writes` trigger: a direct
leave holds the attendee tuple, a direct owner edit or cancel holds the event row, a direct tag write
holds the tag row, and only then waits for `account_close:<caller>`. A series path that already
holds the owner's account lock and wants that row would wait forever against the owner's own direct
write, and PostgreSQL would abort one side.

**Resolution: legacy actors take their account lock before any row is locked.** 0054 adds one
statement-level `before` trigger function, `findmaxxing_private.lock_actor_account()`, which takes
`account_close:<auth.uid()>` and nothing else, and attaches it `for each statement` to `events`
(update, delete), `event_attendees` (insert, delete) and `event_tags` (insert, update, delete).
Statement-level `before` triggers run before the statement touches or locks any row, so the direct
web and native writes keep their statements, policies, grants, row triggers, error strings and
results exactly as they are, and now hold their account lock first. Advisory transaction locks are
re-entrant within a session, so the existing row-level lock in `block_suspended_writes` is then a
no-op. A service caller (`auth.uid()` null) is unaffected. This is the preflight's first suggested
option ("taking legacy actors' account locks before row mutation"); no nonblocking retry is needed
for the host RPCs because every participant now agrees on the order.

The functions that take an event lock and then write it are made consistent the same way, at their
start: `set_event_price` takes the caller's account lock first; `set_session_rules` and
`confirm_session` take the acting user's and the event creator's account locks (ascending) through
`findmaxxing_private.lock_event_actors()`; `prepare_account_deletion` locks the closing user's series
rows ascending and then their events ascending before cancelling them (A1.7).

**The batch generator** (`generate_series_occurrences(null, p_now)`, service role, cron) is the one
path that visits many series in one transaction. Holding one owner's account lock while blocking for
another owner's would take a line-1 lock after line-2 and line-3 locks. It therefore never waits:
for each active series in ascending id it tries `pg_try_advisory_xact_lock` on the owner's account
lock and `for update nowait` on the series row, and **skips** a series it cannot take at once (the
next cron run, 15 minutes later, catches up). After that it only inserts rows it created itself, so
it cannot wait on anyone. The per-series call (`generate_series_occurrences(p_series, p_now)`) and
the host RPCs take blocking locks in the order above.

**Audit of every path against the order** (checked against the migrations at head 0095):

| Path | Order after 0054 | Finding |
| --- | --- | --- |
| Direct join (insert) | account (statement trigger, then the row trigger again) → event (`check_event_join`) → attendee | consistent |
| Direct leave (delete) | account (statement trigger) → attendee row | consistent; was row → account |
| Direct owner edit, cancel, delete; `update_event_with_tags` | account (statement trigger) → event → tickets (`refund_on_cancel`) / cascades | consistent; was event → account |
| Direct tag write | account (statement trigger) → tag row | consistent |
| `set_event_price` | account → event → (no ticket writes) | consistent; was event → account |
| `set_session_rules`, `confirm_session` | actor and creator accounts → event | consistent; was event → account |
| `reserve_ticket`, `confirm_ticket` (0053) | account → event → ticket → attendee | unchanged |
| `decide_sessions`, `expire_checkout`, `mark_ticket_refunded`, `schedule_event_reminders` (service) | event only or ticket only | unchanged |
| `prepare_account_deletion` | account → profile → the user's series ascending → the user's events ascending → tickets | ordered; was unordered events |
| Profile delete cascade | profile → series (cascade) → events (cascade) → children | relies on `reserve_ticket` refusing the creator; occurrences carry `creator_id = owner_id`, so a series owner never holds a ticket on their own occurrence |
| Message send | sender's account (row trigger before insert) → key-share on the conversation (RI check) | consistent with the series paths, which lock the conversation last |
| `moderate_target` (event) | moderation advisory lock → event → moderator's account | unchanged, same-user only (a moderator joining the event they moderate); pre-existing |
| `create_event_series`, `update_occurrence`, `update_series_from`, `cancel_occurrence`, `end_event_series`, `set_series_status`, host add/remove, `record_attendance` | accounts (actor, owner; ascending) → series → events ascending → conversations in event order | new, in order |
| `generate_series_occurrences` (batch) | try-lock account → try-lock series → inserts only | never waits |

### The backup-host write path (preflight item 3)

`security definer` keeps `auth.uid()`, so the creator-only owner guard would refuse a backup host
even after a series RPC accepted them. 0054 therefore:

- adds `public.is_series_host(p_series, p_user)` (definer, stable, granted to `authenticated` and
  `service_role`; host names are public per 4.0 §14) and extends
  `findmaxxing_private.can_host_event(p_event, p_user)` to a current series host of the event's
  series;
- each host RPC rechecks the role **after** taking its locks (`is_series_host` under the series
  lock, `can_host_event` under the event lock), refuses suspended and closing accounts through
  `require_active_account()` (which now also takes the caller's account lock), and then marks the
  transaction with `set_config('findmaxxing.series_write', 'on', true)` around its own writes only,
  resetting it afterwards;
- `guard_owner_event_change` accepts a non-creator **only** when that flag is on, the row has a
  `series_id`, and `is_series_host(old.series_id, auth.uid())` is true at the moment of the write.
  Every other guard rule (future published only, valid status, cancel cannot change details, no
  delete with other attendees) still applies to the backup host. The guard is `security invoker`, so
  the host check it calls is the public definer function, not a private one;
- a direct backup write stays denied twice: RLS on `events` shows only the creator's rows for update
  and delete, and even a row the policy allowed is refused by the guard because the flag is off.
  `update_event_with_tags` refuses with "You do not own this event";
- revocation is immediate: removing the `backup` row makes `is_series_host` false for the RPC's
  check and for the guard's recheck, in the same transaction order as any other write.

`enforce_rate_limit` skips `events` inserts while the flag is on: a series creation counts **one**
`events` hit for its owner instead of one per generated occurrence (the 50-a-day limit would
otherwise be spent by a single seven-day series).

### Committed and uncommitted (A1.4), and the Outings hook

Classified under the occurrence's event lock, by `findmaxxing_private.occurrence_committed(p_event)`:
(a) any attendee other than the owner; (b) any ticket; (c) any message in its conversation, re-read
after the conversation lock; (d) `findmaxxing_private.occurrence_anchors(p_event) > 0`; (e) status
not `published`, or started; (f) `overridden` not empty, `decision` not `open`, `attended` recorded
on any row, or `price_cents` set (a host acted on it); (g) an `ad_campaigns` row references it. Rule g
is enforced by a test that reads every foreign key to `events` from the catalog and fails on one that
this classification does not name.

**Outings compatibility hook.** `findmaxxing_private.occurrence_anchors(p_event uuid) returns
integer` is defined here and returns 0. The Outings migration (5.0 Amendment A1) redefines it to count
live anchors in its private anchor table; nothing else in the series code changes. The test asserts
the function exists, is private, and returns 0 at this head.

### Schedule change (A1.4, two phases)

`update_series_from(p_event, p_patch)`: under the locks above, a plan is computed read-only (retained
dates; movable committed occurrences; candidate dates of the new rule from the effective local date
to the horizon minus retained dates, future only; assignment: keep own date, else nearest unclaimed
candidate within six days with a tie to the later; no destination → kept in place and its date
retained, recomputed until stable; final dates pairwise distinct or the function raises). Only then:
uncommitted future occurrences and their empty conversations are deleted; moving rows set
`series_local_date = null` first and then their final date and instants; kept rows get `schedule` in
`overridden` and are reported; missing dates are generated with `on conflict do nothing`; no row of
the series may end with a null date. The result lists moved, kept, deleted and created occurrence ids
and any occurrence whose capacity could not be lowered (A1.2 rule 4: the capacity-floor trigger
refuses it; the edit continues and reports it).

Non-schedule template edits (title, description, venue, category, capacity, session rules,
activity, tags) apply to future occurrences on or after the effective date, skipping each field in
that occurrence's `overridden`. `update_occurrence` changes one row and records the fields in
`overridden`. `cancel_occurrence` sets `cancelled` (`host`). `end_event_series` sets `ended` and
cancels later published occurrences with `series_ended`. `set_series_status` pauses or resumes
generation. `record_attendance` is host-only, after the occurrence ends, for current attendees, and
is never inferred (A1.4; it does not satisfy R4). Series-level moderation (D-J): `moderate_target`
takes a `series` target; removing it marks the series `removed` and removes its future published
occurrences (`removed_with_series`); restoring reverses exactly those.

Following: own rows only, direct insert and delete under RLS on `event_series_followers` with the
account-lock trigger; no function or trigger writes `event_attendees` from a follow.

### Acceptance criteria

1. Schema, generation, idempotency, horizon, cancelled dates never recreated, paused and ended
   series generate nothing, DST vectors (SQL = TypeScript), first-instant fall-back.
2. Owner and backup hosts act only through RPCs; direct backup writes denied; revocation immediate;
   guard recheck proven by removing the RPC's own check.
3. Edit-this records overrides; edit-future skips overridden fields; schedule change moves committed
   occurrences in place with stable ids, deletes uncommitted ones, keeps colliding ones, never
   violates the unique index; cancel-one leaves the next intact; end-series cancels with
   `series_ended` and refunds through the existing path.
4. Following never creates attendee rows; follow and going are separate in the read model.
5. Legacy web and native direct writes keep their grants, policies, strings and results, and now
   take the account lock first (statement-trigger proof).
6. A1.6 cases 10, 11, 13, 14, 19, 20 on real PostgreSQL with controlled interleaving, plus the host
   leave/edit versus regeneration orderings from preflight item 2, a date that becomes retained
   during assignment, backup-host RPC success / direct denial / post-revocation denial, account
   closure of the owner and of a backup host against the series paths, and A1.6 case 12
   (`decide_sessions` racing a join). Guard-removal proofs for: the conversation lock before the
   empty-chat check (case 20), the retained-date rule (case 19), the statement-level account lock
   (the legacy cycle reappears), the guard's host recheck, and the try-lock in the batch generator.
7. Demo twin at parity on the same scripts; `npm run check`; mobile typecheck; demo-browser checks
   for the host flows this slice adds.

### Assumptions and recorded choices

- Capacity, minimum and lead time are template fields; the per-occurrence `decision_deadline` is
  `starts_at − decision_lead_minutes` set at generation (and recomputed on a move).
- A series whose owner is suspended or closing is skipped by the generator (nothing is generated,
  nothing is deleted); its status is unchanged.
- The generator's skipped-series count is not an error; the cron route logs the generated count.
- Occurrences keep the event's existing visibility rules; a series is visible when its usual place is
  visible (`can_view_series`), like `can_view_event`.

## Changes (as implemented, 2026-11-16)

- `supabase/migrations/0054_event_series.sql`: everything in the contract. Tables `event_series`, `event_series_tags`,
  `event_series_hosts`, `event_series_followers`; `events.series_id/series_local_date/overridden/removed_with_series`
  and the plain unique index; `event_attendees.attended`; rule and first-instant zone functions; the statement-level
  account-lock trigger on `events`, `event_attendees`, `event_tags`; the marked backup-host path in
  `guard_owner_event_change`; `enforce_rate_limit` counting a series once; the committed test and the
  `occurrence_anchors` hook; the generator (per-series blocking, batch try-lock); `create_event_series`,
  `update_occurrence`, `update_series_from` (two-phase plan), `cancel_occurrence`, `end_event_series`,
  `set_series_status`, `add/remove_series_host`, `record_attendance`; `set_event_price`, `set_session_rules`,
  `confirm_session`, `prepare_account_deletion` reordered; `moderate_target('series')`; end-of-migration checks.
  **One deviation from the contract text:** the check constraint is `series_id is not null or series_local_date is
  null`, not an equivalence, because the two-step move sets the date null inside the transaction; the function
  asserts no null date remains.
- Shared: `packages/shared/src/series.ts` (rule schema, `seriesDates`, `occurrenceWindow`); series types in
  `types.ts`; `Event.seriesId/seriesLocalDate/overridden`; `EventDetail.series`.
- Repositories: `series` namespace on the interface; Supabase and demo implementations (`src/lib/data/demo/series.ts`,
  demo store v18, account-deletion and moderation twins).
- App: repeat fields on the create form and an apply-to choice on a series occurrence's edit (pilotEvents),
  `SeriesHostTools` (cancel this session; owner: end series) and a series line on the event page; the
  notifications cron calls the generator. Grant allowlist and cron test updated.

## Tests (local, 2026-11-16)

| Command | Result |
| --- | --- |
| `npx vitest run tests/event-series.test.ts` | **39/39** (34 PGlite logic/RLS/DST/moderation/closure cases + 5 demo-parity scripts) |
| `TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres npx vitest run tests/event-series-pg.test.ts` | **22/22**, four runs in a row (16 as written incl. A1.6 cases 10–14, 19, 20, preflight orderings (i) and (ii), lock-order holds, owner closure both orders, backup host, case 12; 6 guard-removal runs) |
| `…/event-admission-pg.test.ts` | 28/28 before and after 0054 (regression) |
| 15 existing suites the migration touches (grants, schema, account deletion, session rules, cron, moderation, demo, payments, messaging, admission, security boundaries) | 318/319 → the one failure (cron mock lacked the generator) fixed; cron 44/44 |
| `npm run typecheck` | exit 0 |
| `eslint` on changed files | 0 errors, warnings fixed |
| `npm run check` (full, with the race database) | **NOT COMPLETED**: started, session cut off before it finished |
| mobile typecheck, demo build, `e2e`, `e2e:event-detail`, a browser check of the repeat/cancel flow | **NOT RUN** |

PostgreSQL is the embedded 17.11 build in this session's scratchpad (no server binary exists on this machine;
`initdb --auth=trust`, port 54329). It does not survive the session.

### Guard-removal outcomes (real PostgreSQL)

| Guard removed | Outcome |
| --- | --- |
| statement-level account lock on `event_attendees` | the owner's leave holds its tuple while waiting; one side **deadlocks** |
| statement-level account lock on `events` | the owner's edit holds the event while waiting; one side **deadlocks** |
| the 0022 `set_event_price` (event first) | waits for the account **holding the event** |
| try-lock in the batch generator | the batch run **waits** on a held owner account instead of skipping |
| the function's own host check | the guard still refuses a revoked host (`You do not own this event`) |
| the conversation lock before the empty-chat check | **outcome unchanged** (recorded finding below) |

**Finding for the amendment's table (A1.6).** The only person who can write to an uncommitted occurrence's chat is
its owner, and every series function takes the owner's account lock before any row; so the owner's send and the
schedule change are already serialized by the account lock, and removing the conversation lock cannot change case
20's outcome. The lock is kept as specified; the proof row should say so.

**A1.4 step 5, as proven.** A movable occurrence's own date is either a candidate (it keeps it in step 4) or not a
candidate (nobody could have been assigned it), so a date that becomes retained during assignment never changes an
earlier assignment; the recompute is a no-op by construction. The test shows the kept occurrence reported and every
other assignment unchanged.

## Adversarial review (self)

- Date identity: a one-off edit of an occurrence's time keeps its `series_local_date` as its slot, so a later
  schedule change never lands another session on it (retained via `schedule` in `overridden`).
- A new occurrence whose lead-time deadline has already passed is created with no deadline, never born cancelled.
- A suspended or closing owner's series is skipped by the generator; a closing owner refuses backup-host changes.
- Direct backup writes: RLS returns zero rows; the guard refuses even an allowed row; `update_event_with_tags`
  refuses. Series columns are not in the column-level update grant (checked at the end of the migration).
- Not re-examined for lack of time: the edit form's "this and future" path through a real browser; native (`api.ts`)
  reads the new columns through `*` but has no series UI (8.1b).

## Remaining issues

- Finish the gate: `npm run check`, mobile typecheck, demo build, `e2e`, `e2e:event-detail`, and a scripted browser
  check of the repeat fields, series line and cancel-this-session (not written yet; follow `scripts/e2e-event-detail.mjs`).
- NOT VERIFIED: hosted Supabase; the real cron; push.
- 0055 next (notifications: `series_update`, per-change keys); 4.5b page carries the follow UI.

## Handoff

- Commit: one WIP commit on `codex/0054-series-2026-11-16` (see the ledger). Nothing pushed, merged or deployed.
- Ready for independent review: not yet; the gate above must finish first.
- Next ready ticket: finish 0054's gate, then 0055 / 4.6.
