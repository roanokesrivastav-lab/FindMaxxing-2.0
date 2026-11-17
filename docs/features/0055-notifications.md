# 0055 — Material-change notifications (4.6)

Priority: Must. Branch `codex/0054-series-2026-11-16` after `d2b34f5` (0054 gate finished).
Status: **IMPLEMENTED-LOCAL** (self-review only; not independently verified).

Review workflow: independent Codex checkpoints are paused for the founders' Fable run
([handoff](../implementation/founder-fable-handoff.md)). The "Self-review" section records my own
inspection; it is not an independent sign-off.

## Contract

- **Objective:** a change to when or where a session happens, or its cancellation, reaches the
  people going exactly once per change; a series schedule change, a cancelled occurrence or an ended
  series reaches followers who are not going to the affected sessions, once. Mutes, quiet hours,
  the daily push cap and blocks apply. No path, signed-in or service, sends twice or skips silently.
- **Controls:** [4.0 Amendment A1.5](4.0.md#a15-notifications-46-one-path-per-change) and the
  decision on open point 2 (one notification per change; retries deduplicated).
- **Allowed files:** migration `0055_event_change_notifications.sql`; the shared notification types
  and wording (`packages/shared`); the demo twin; tests; this note and the ledger.
- **Out of scope:** the series page and its follow button (4.5b); the Events tab (1.5); new push
  transport; waitlist or offer types (4.4, Later); Outings notifications; any hosted database.

## Decisions

1. **What counts as a change.** `events.change_seq` (not client-writable) goes up by one in a
   `before update` trigger when the start, the end or any venue field changes, or the status leaves
   `published`. Description, title and capacity edits are not material.
2. **Keys.** `event_changed:<event>:<change_seq>` (dedupe, replacing today's batch key, so a second
   edit is its own notification and is pushed again); `event_cancelled:<event>` and
   `event_not_happening:<event>` (unchanged); `series_update:<series>:v<rule_version>` (schedule),
   `series_update:<series>:cancel:<event>` (one occurrence cancelled),
   `series_update:<series>:ended` (series ended). `notify()` already drops a repeated dedupe key.
3. **One sender per change.**
   - Signed-in session: the row trigger `notify_on_event_change` sends to people going, and also sends
     the follower `series_update` for a single cancelled occurrence (so a host's legacy direct cancel
     reaches followers too, not only `cancel_occurrence`).
   - Bulk series changes set a transaction flag so the trigger does not send one follower message per
     occurrence: `update_series_from` sends one schedule update; `end_event_series` sends one
     "ended". People going still get one event notification per affected session.
   - Service session (`auth.uid()` null): the trigger stays silent, as since 0021, and every service
     path that makes a material change calls the same private sender explicitly: `decide_sessions`
     (below minimum) and `prepare_account_deletion` (a closing host's future sessions and series).
     The generator only inserts.
4. **Checks per recipient, in the sender**, because a null actor skips `notify()`'s own block check:
   still going (or still following); not blocked either way with the responsible host (the series
   owner, else the event's creator); and can see the event or series **now, as that person**. The
   last uses the existing `can_view_event` / `can_view_series`, evaluated with the recipient set as
   the request's subject for the duration of the call and then restored, so the visibility rules
   stay in one place.
5. **Followers who are going.** For a schedule change, a follower going to any session that moved
   gets the event notification only. For a cancelled occurrence, the person going gets
   `event_cancelled` only. For an ended series, anyone going to a cancelled session gets
   `event_cancelled` only.
6. **Content.** The label is the event or series title only. A `series_update` carries
   `detail` = `schedule` / `cancel` / `ended` for the wording, and links to the next upcoming session
   (or to the Events list when there is none). No names, reasons or notes.

## Changes

- **Migration `0055_event_change_notifications.sql`:** the `series_update` type (type check, settings
  check, push default, and added to the pushed types of anyone who has event changes pushed);
  `events.change_seq` with its trigger; `findmaxxing_private.visible_to` (asks the existing visibility
  rules as the recipient, then puts the caller back); two private senders,
  `notify_event_audience` and `notify_series_followers`; `notify_on_event_change` replaced; and four
  functions re-created with their sends added and nothing else changed: `decide_sessions` (0051),
  `prepare_account_deletion`, `update_series_from` and `end_event_series` (0054). No grant, table
  privilege or policy change; the new private functions are revoked from every API role.
- **Shared:** `series_update` in `NotificationType`, the settings list and the wording
  ("Thursday run club has a new schedule", "One Thursday run club session was cancelled",
  "Thursday run club has ended").
- **Demo twin:** the same two senders in `src/lib/data/demo/notifications.ts` (change counter,
  per-change keys, the three recipient checks), used by the demo series, event and session paths;
  store version 19 adds `series_update` to pushed types the same way.

## Acceptance (batch 02 criterion 5)

| Requirement | Evidence | Result |
| --- | --- | --- |
| Time, venue, cancellation and schedule changes reach only affected people going and followers | `tests/event-notifications.test.ts`: "people going to one session", "followers of a series" | Pass |
| Deduplicated; a second legitimate change notifies again; a retry does not | per-change keys asserted; retried send adds nothing; two concurrent edits on real PostgreSQL give exactly two notifications each | Pass |
| Mutes, quiet hours, blocks | mute case; blocks either way with the host, for people going and for followers. Quiet hours and the daily cap are applied by the existing push claim, unchanged, which reads `push_state` set here | Pass for mutes and blocks; quiet hours not re-tested (unchanged code) |
| No offer-related types | the type list adds `series_update` only | Pass |
| Service and cron changes cannot bypass | the deadline decision and the deletion job each notify, once, however often run; the generator (insert only) tells nobody | Pass |
| Revoked visibility | a session moved to a place the person can no longer see; a removed series | Pass |
| Follower and attendee overlap | a follower going to the cancelled or moved session gets the event notification only | Pass |
| Demo parity | one script on SQL and the demo twin, identical results; the deadline decision on the demo | Pass. The demo has no closing phase for accounts, so the deletion-job case is SQL-only |

## Tests (local, 2026-11-17)

| Command | Result |
| --- | --- |
| `npx vitest run tests/event-notifications.test.ts` | **21/21**, twice |
| `TEST_DATABASE_URL=… npx vitest run tests/event-notifications-pg.test.ts` | **2/2**, twice (two edits at once; the deadline cron against the host's cancel, both orders) |
| `TEST_DATABASE_URL=… npm run check` | **exit 0.** 81 files, **1,462 tests, 0 skipped**, build |
| `npm run typecheck --workspace @findmaxxing/mobile` | exit 0 |
| Demo build: `e2e:series` 7/7, `e2e:features` 11/11, `e2e:event-detail` 9/9, `e2e:onboarding` 13/13, `a11y` 0 issues | pass |
| `npm run e2e` | **14/19, FAILS — and fails the same way on the previous commit `d2b34f5` without 0055** (checked by setting the 0055 work aside and rebuilding). See below |

**Guard removals** (each run with one guard taken out, then restored): without counting changes,
nobody going is told about a change at all; without the block check, a person the host blocked is
told; without the bulk flag, ending a series sends followers one message per session plus one; without
the explicit send, the deletion job tells nobody.

**Found by the tests and fixed:** on a host's account closure, a follower who was also going to one
of the host's *other* cancelled events was skipped for the series message, because the affected set
was every cancelled event instead of that series' own.

## Self-review

- **Asking visibility as the recipient** sets `request.jwt.claim.sub` for one call and restores it.
  Checked: the caller's `auth.uid()` is the same afterwards. On hosted Supabase `auth.uid()` reads
  this setting first, then `request.jwt.claims`, so the override takes precedence there too.
  **NOT VERIFIED on hosted Supabase.** If a future Supabase changes `auth.uid()` to read only the
  claims JSON, this check would silently ask as the caller; the alternative is copying the rules with
  a user argument.
- **`event_changed` is no longer batched.** Two edits to one session are two notifications (decided
  in A1.8). The existing notifications test that asserted one row per attendee still passes because
  it makes one material edit.
- **The host is told** when the deadline decision or the deletion job cancels their own session
  (actor null). That was already true for the deadline decision.
- Ending a series links the follower message to the Events list; there is no series page yet (4.5b).

## Remaining issues

- The golden-journey failure noted here was a test fault and is fixed (see the ledger, 2026-11-17).
- NOT VERIFIED: hosted Supabase, the real cron, real push delivery, quiet hours end to end.
- 4.5b (series page and follow button) and 1.5 can now start.
