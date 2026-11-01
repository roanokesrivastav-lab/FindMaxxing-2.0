# Roadmap to the 80% beta — vibecoding plan

Source: the competitor research and 80-point implementation plan from 2026-10-30/31 (Corner, Mapstr, Yelp,
Infatuation, Atlas Obscura, Beli, Airbnb, Apple/Google Maps, Partiful, Luma, Meetup, Strava, Playtomic, Pinterest,
BeReal, Retro, Arc, Things 3, Linear). This file turns that plan into **tickets an agent can finish in one session**.

**The milestone journey every ticket serves:**
> A newcomer picks pickup sports, finds a beginner-friendly Saturday game that needs two more players, and joins.
> They share it with friends, vote on one of three saved cafés for afterward, and get a walking plan that respects
> the game's start time. Next week they find the same group again.

Visual direction: **Local editorial** for featured content, **Quiet utility** rows for anything people compare.
Pilot market: one compact Columbus neighborhood. Mobile web first, then native.

---

## 1. How to run a ticket (the loop)

Roles follow the protocol in [AGENTS.md](../AGENTS.md): **Claude** writes the brief, **Codex** preflights it and
verifies the result, **Astra/Sol** implement, **you** accept.

1. **Pick** the next ticket in your lane (§4). Check its `Needs:` are merged on the shared base.
2. **Reserve** its migration number through the integration owner (§6) if it has one.
3. **Claude brief**: Claude turns the ticket into an implementation brief — coding prompt, acceptance criteria,
   test cases, files likely touched, must-not-change list.
4. **Codex preflight**: Codex returns Approved / Approved with required changes / Blocked, plus the handoff
   contract. No implementation starts without an approved contract.
5. **Implement**: Astra or Sol gets the preamble (§2) + the approved contract, in a **fresh worktree cut from the
   approved base** (never this checkout while it holds unrelated staged work). It implements, runs
   `npm run check`, and writes `docs/features/<ticket-id>.md`.
   **Spec tickets** (marked `SPEC`) stop after the design; you approve it before any build ticket uses it.
6. **Independent verification**: Codex inspects the diff and runs the tests against every acceptance criterion.
   High-risk tickets (§3) also get the adversarial audit from AGENTS.md.
7. **Owner acceptance**: you click through `Done when` at 390×844. If it misses twice, **keep the failed attempt's
   branch for reference**, sharpen the brief, and restart from the approved base in a new worktree — don't stack
   patches and don't reset a branch that holds anything else.
8. **Merge** through the integration owner, tick the box, link evidence in the scoreboard (§7).

Rule of thumb for size: one ticket = one PR, at most one migration, roughly ≤ 12 files touched. If an agent's
contract lists more than that, ask it to split the ticket before coding.

---

## 2. Preamble (paste once per session)

```
Repo: FindMaxxing 2.0 (Next.js 16 + Supabase + Expo app in apps/mobile). Read docs/roadmap-80.md for context.
You are implementing a Codex-approved handoff contract (pasted below). Do not widen its scope; if it is wrong or
incomplete, stop and report instead of improvising.
Rules:
- New migrations only, using the number reserved for this ticket; never edit an existing migration. RLS on every new table,
  with PGlite tests as anon, owner, another user and a moderator.
- Keep the demo repository twins in src/lib/data/demo at parity with SQL.
- No dependency changes, deploys, pushes, or real Stripe/Expo/Anthropic/routing calls without asking.
- UI: use the primitives in src/components/ui and the tokens in globals.css (type roles, spacing scale, surface
  variants). No new one-off colors, shadows, radii or font sizes. Every screen has loading, empty and error states,
  works with no photo, long names, larger text and keyboard only.
- New features go behind a flag in the existing registry (FEATURES / featureEnabled() in src/lib/config.ts),
  off unless listed. Client components get the resolved value as a prop from a server component.
- Privacy promise: a private save, note or list never becomes visible through an outing, share, recommendation
  or notification. Test it.
- Test the real code path (route/action/RPC), not only helpers.
Process: write the contract first (objective, scope, out of scope, acceptance, required tests). Implement. Run
npm run check. Write docs/features/<ticket-id>.md with contract, changes, test results, what you could not verify.
Stop and report.
```

---

## 3. What never gets vibecoded loosely

These get a `SPEC` ticket first, real-database tests, and a hostile review before merge. Don't accept "looks fine":

| Area | Why | Proof required |
| --- | --- | --- |
| Seat claims, waitlist offers, decision locks | Two people tapping at once can overbook or overwrite | Two independent PostgreSQL connections racing in a test (harness: ticket 4.pre) |
| Legacy write paths | Web (`src/lib/data/supabase/repository.ts:1021`) and native (`apps/mobile/lib/api.ts:76`) insert/delete `event_attendees` directly; paid fulfillment also writes it | A direct PostgREST insert cannot bypass a new rule |
| Outing membership and invites | Easy to leak private saves or let a removed member keep access | Multi-user RLS tests + direct API calls |
| Itinerary feasibility | An AI that says "fits" when it doesn't breaks trust instantly | Pure deterministic validator with DST/overnight/fixed-time tests |
| Import matching | Wrong venue matches pollute the map | Nothing unconfirmed becomes public; idempotent re-import test |
| Time zones | Repo has a history of clock flakes; planner hard-codes New York | Frozen-clock tests across a DST change |

Everything else (layout, copy, hierarchy, filters, cards) is fair game for fast iteration.

---

## 4. Tickets

Size: **S** ≈ one short session, **M** ≈ one long session, **L** = split it before starting.
`Lane` decides who can run in parallel without touching the same files (see §5).

### M0 — Baseline (do first)

**0.1 Finish and verify the in-flight security batch** · M · Lane Core · **blocked until green**
Brief: [briefs/0.1-security-batch-1.md](briefs/0.1-security-batch-1.md) — proposes splitting into 0.1a (auth,
reset, deletion, geocode limits) and 0.1b (ad render beacon + billing, migration 0041). D2 approved
2026-10-31: 0.1a adds `pg` and a local-Postgres harness, which also satisfies 4.pre.
Status 2026-10-31: the staged work does not compile. `npm run check` stops in TypeScript with six errors — the ads
route, auth actions, account actions and tests still import the removed `limiters` export or its old test state.
Batch 3 (0039) has earlier passing evidence; 0040 belongs to the unfinished durable-limiter batch 1 (F2/F3/F7).
```
Finish security batch 1 (F2/F3/F7) as specified in docs/security-audit-repair.md. Migrate every caller of the
removed in-memory limiter (ads route, auth actions, account actions) and their tests to the durable limiter in
src/lib/abuseLimits.ts + 0040. Do NOT restore a compatibility export: that would make TypeScript pass while the
old in-memory protection stays active. Prove the real sign-in and /api/ads paths are limited across two clients
against one database. Run the full npm run check (typecheck, lint, tests, build) and record results in the
repair doc. Commit only when everything passes.
```



**0.2 Feature status matrix** · S · read-only, any lane
```
Produce docs/feature-status.md: for every capability in the roadmap-80 scoreboard (§7), list what exists today with
file paths, and mark each: present in source / enabled in staging (unknown if you can't tell) / verified on web /
verified on iOS / verified on Android. Cite evidence. No code changes.
```

**0.3 Pilot flags and seed** · S · Lane Core · Needs: 0.1
```
Extend the existing flag registry in src/lib/config.ts (FEATURES, featureEnabled()) — do not add a second flag
system and do not change existing defaults (off unless listed). Add pilot feature names for the roadmap
milestones. Decide and document how new pilot flags behave when a deployment uses NEXT_PUBLIC_FEATURES=all: pilot
flags must NOT turn on implicitly via "all" (add an explicit pilot allow-list or a separate opt-in), so an existing
deployment never gains unfinished features on rebuild. Enable pilot features explicitly in test and demo
configuration (env files / test helpers), not via code defaults. Pass resolved availability to clients from
server components. Add demo seed accounts: host, participant, outsider, moderator (credentials only in the seed
file). Mark seed records as pilot vs fictional. Tests: existing flags unchanged, "all" excludes pilot flags,
explicit listing enables them, required-key checks still apply.
```

### M1 — Design foundation and onboarding

**1.1 Design tokens and primitives** · M · Lane Core · Needs: 0.3
This is the most important ticket for vibecoding: every later UI prompt points at it, so screens stop drifting.
```
Define in globals.css and src/components/ui:
- Three type roles for phone: page title 28–32px (Bricolage), item title 16–18px, body/support 14–16px (Figtree).
- Spacing scale: 4/8 within an item, 16 between rows, 24–32 between sections. One left alignment edge.
- Three surfaces with fixed meaning: Raised (floating over the map / selected), Flat row (comparable items),
  Inset (tinted, for a local tip or note). Remove the default "background+border+radius+shadow on everything" card.
- Primitives: Row (title, meta line, trailing slot), SectionHeader, Surface variants, StatusLabel (text + shape,
  never color alone), DateBlock (calendar-style), PlaceGlyph (category icon fallback for no-photo cards).
- A demo-only /dev/ui page showing every primitive with long text, no photo and 200% text.
Keep the warm paper palette and current fonts. Do not restyle existing screens yet beyond what breaks.
```

**1.2 Interest picker rewrite** · M · Lane Map · Needs: 1.1
```
In src/components/onboarding/WelcomeFlow.tsx: ask "What would you go out for?" with six recognizable interests as
text rows with a small thumbnail (PlaceGlyph fallback when no image), visible checkmark state, "More interests",
and a visible skip. No minimum quota. The forward button says "Continue" (home city is next).
Fix the mismatch: the picker allows 12 but the first map uses 8 — whatever the user selects must be what the map
honours, or the UI must say which are used. Tests: zero choices, max choices, skip, returning user, keyboard-only.
```

**1.3 First-map arrival** · S · Lane Map · Needs: 1.2
```
On the first Explore visit after onboarding, show the selected interests as removable filters with "Show
everything" beside them. If a selected interest has no nearby results, say so and offer one specific widening
(bigger area or all interests). Never silently relax filters. Tests: no matches, denied location, all interests.
```

**1.4 Truthful People step** · S · Lane Map · Needs: 1.1
```
The People step already computes shared interests but shows only name/username and can include zero-overlap people.
Show "Also into coffee and art" only when true; zero-overlap people get a neutral reason or a separate section.
Suggested / followed / friends render as distinct relationships. Tests: zero matching people, partial overlap.
```

**1.5 Quiet-utility event list** · M · Lane Events · Needs: 1.1
```
Rework the Events list into Flat rows grouped under Today / Tomorrow / This weekend / Later. Row: time on a shared
left edge, title, venue, availability ("4 spots"). Tap expands in place for equipment, meeting point and host note.
Price, full, and cancelled stay visible without expanding. One attributed social line when the viewer may see it.
```

### M2 — Explore density and place decisions

**2.1 Map clustering (web)** · M · Lane Map · Needs: 1.1
```
In MapCanvas/ExploreClient add clustering at wide zooms (Mapbox and MapLibre both). Tap a cluster to zoom to its
bounds. Several records at the exact same coordinates open a list instead of zooming forever. Counts must come
from the full authorized matching set; if the query is capped, label the count as partial. Keep keyboard focus
and reduced-motion behaviour that exists today. Tests: co-located pins, capped query, hidden places excluded.
```

**2.2 Selection sync and state preservation** · M · Lane Map · Needs: 2.1
```
Selecting a pin highlights its list row and vice versa; the selected pin stays visible and distinct. Opening a
detail page and coming back restores camera, filters, selection and list scroll (URL state where sensible).
Tests: reopen after panning, back navigation, deep link with filters.
```

**2.3 Mobile bottom panel** · M · Lane Map · Needs: 2.2
```
Replace the separate mobile map/list modes with one map plus a panel: compact (selected result or summary),
half (comparable list with map visible), expanded (full list). Explicit expand/collapse buttons as well as drag.
Opening the panel never recenters the map or changes the search. Screen-reader navigable list.
```

**2.4a Intent filter presentation** · S · Lane Map · Needs: 2.3
```
Top filters are only: When (now / tonight / this weekend), Area (travel limit), Activity — all backed by data that
exists today. No wall of 20 chips. Empty states offer one specific expansion. Leave a slot for activity-specific
filters but ship none yet.
```

**2.4b Data-backed activity filters** · S · Lane Map · Needs: 2.4a, 4.2, 4.3
```
Add "Beginner-friendly" (from 4.2 structured details) and "Has room" / "Needs players" (from 4.3 capacity and
minimum). Show them only for activity kinds where the data exists. Tests: events without structured details are
neither matched nor silently excluded without saying so.
```

**2.5 Place decision summary** · M · Lane Place · Needs: 1.1
```
Reorder src/app/places/[id]/page.tsx so the first screen answers why go / will it work / what next:
1 name, category, neighborhood; 2 one "known for" sentence; 3 price, travel time, hours (unknowns said honestly);
4 rating WITH count, then friend/local evidence kept separate from community rating; 5 best for / less suitable for
(placeholder until 2.7); 6 one local tip (Inset surface); 7 Save, Add to outing (disabled until M5), Directions.
Photos and long stories follow. The no-photo version must be a complete composition. No schema changes.
```

**2.6 Tip provenance and freshness** · M · Lane Place · Needs: 2.5 · migration
```
Local tips get: author, created_at, last_confirmed_at, last_confirmed_by, and a kind: lasting story / practical tip
/ temporary condition (temporary ones need expires_at). Add "Still true?" confirm and "Suggest a correction"
actions. An edit is not a confirmation. Display "Confirmed by Maya, 2 weeks ago". Rate-limit confirmations; tests
for RLS, expiry hiding, and self-confirmation not counting.
```

**2.7 Best for / less suitable for** · M · Lane Place · Needs: 2.6 · migration
```
Contributors can add short attributed occasion notes ("Good for a relaxed second date", "Less suitable for a big
group that wants to talk") picked from a small occasion list plus free text. Multiple opinions coexist; show the
top one or two with attribution and "see all". No AI-invented experience. Tests: RLS, moderation hide, demo parity.
```

### M3 — Personal library and importing

**3.1 Richer saves** · M · Lane Place · Needs: 2.5 · migration
```
Saved places gain: private note, personal tags, source URL, recommended_by (free text), status want_to_go/visited.
All owner-only. Show "Only you" next to private fields. Separate "why I saved this" from community info on the
place page. Tests: another user, outing member (future), share link and recommendations never see these fields.
```

**3.2 Library tools** · M · Lane Place · Needs: 3.1
```
In src/app/saved: search, filter by tag/status/category, multi-select bulk edit (tag, move list, mark visited,
remove) with undo, and export (CSV + JSON, owner only). Big libraries (500 saves) stay fast — paginate.
```

**3.3 SPEC — place matching and provider** · S · Lane Place · Needs: 0.2
```
Design (no code) the place-matching service used by importers: inputs (name text, city, optional coords/URL),
candidate search against our places first, then an external provider. Compare providers we could use alongside
Mapbox/MapLibre on storage rights, attribution, display rules and cost per successful match (Google Places restricts
storage — check). Define confidence levels, dedupe keys, and what happens to unmatched text.
Define what a confident external match becomes when the venue is NOT in our catalog: bookmarks require a
FindMaxxing place_id (0001_init.sql), so specify an owner-only draft place (or another explicit private storage
path), how it is promoted to a public place (separate, deliberate flow), and test that confirming a personal save
can never silently publish a venue or the user's source note. Wait for approval.
```
Human decision needed: pick the provider.

**3.4 Notes importer** · L → split into 3.4a parse+match (Needs: 3.3 · migration), 3.4b review UI (Needs: 3.4a,
3.1 — it writes the private save note) · Lane Place
```
3.4a: Paste text → extract candidate place names (lines, bullets, "X in Y"), match via the 3.3 service in the chosen
city, and store an import batch with per-line results: matched / ambiguous / duplicate / unmatched. Re-importing
the same text must not create duplicates and must keep user edits. Unmatched lines are kept as private drafts.
3.4b: Review screen: confirm or fix each ambiguous match (show venue + neighborhood), merge duplicates, keep the
personal aside as the save's note, then commit. Nothing unconfirmed becomes a public place.
Test fixture: a note with a duplicate, two branches of one café, an unknown place and a personal aside.
```

**3.5 Link importer** · M · Lane Place · Needs: 3.4
```
Paste or share a TikTok/Instagram/other URL. Store the URL, permitted metadata and the user's own text; propose
candidates via 3.3; allow manual match; support several places from one post. If the post is private or deleted,
the save and note survive. No scraping beyond permitted metadata.
```

### M4 — Events, sports and recurring groups

**4.1 Event page hierarchy** · M · Lane Events · Needs: 1.1
```
Reorder src/app/events/[id]/page.tsx: what it is → DateBlock with time and timezone → meeting point and travel →
host and permitted social proof → cost and availability → requirements → status + one primary action. Add a
"Your first time?" block (meeting spot, who welcomes you, what to bring, solo welcome) from host-entered fields.
Fix "free to join" copy showing above a paid ticket action. Status labels: Interested / Going / Awaiting approval /
Waitlisted. No schema changes beyond the newcomer fields if they need a column (then use the claimed migration).
```

**4.0 SPEC — series, occurrences, sessions, participants** · M · Lane Events · Needs: 0.2
```
Design (no code) the data model for: series (recurring identity, hosts incl. backup, usual venue, schedule rule,
timezone); occurrence (date, venue override, cancelled, attendance); session rules (capacity, min_attendance,
decision_deadline, venue_status); participant status (interested, going, waitlisted, offered with expires_at,
declined, left). How existing events map onto it (an event = an occurrence with no series). Atomic RPCs for join,
leave, offer, accept, expire. RLS for attendee visibility. Edit-this vs edit-future semantics. Following a series
never RSVPs. Notifications on material change. DST behaviour. Test plan with concurrency cases.
Must also define:
- When an outstanding offer holds capacity (and for how long), so a free seat isn't taken while it's offered.
- Legacy write paths: web (src/lib/data/supabase/repository.ts:1021/1025) and native (apps/mobile/lib/api.ts:76/79)
  insert/delete event_attendees directly. Either route all writes through the RPCs and revoke direct
  insert/delete, or enforce capacity/offer rules in a trigger — and say how already-shipped native builds behave.
- How free sessions stay separate from paid fulfillment, which also writes event_attendees under its own rules.
Split into batches matching 4.2–4.6. Wait for approval.
```

**4.pre Two-connection PostgreSQL test harness** · S · Lane Core · Needs: 0.1 · must land before 4.4 · **delivered by 0.1a** (only add the event-specific race helpers here if needed)
```
PGlite is single-connection, so it cannot prove race safety. Add a test helper that runs selected suites against
a real local PostgreSQL with two independent connections (skipped with a clear message when unavailable, required
in CI). Apply all migrations in order. Include one sample race test against an existing RPC.
```

**4.2 Structured activity details** · M · Lane Events · Needs: 4.0
```
Shared types in packages/shared for activity details per kind: run (distance, pace range, regroup, no-drop
explained), volleyball/basketball (format, player limit, beginners welcome), pickleball (level, singles/doubles,
paddles available), walk (minimal). EventForm shows only the relevant small section; the event page and rows render
them in plain language. Validate in validation.ts. Skill = plain descriptions, no numeric rating.
```

**4.3 Minimum attendance and readiness** · M · Lane Events · Needs: 4.2 · migration
```
Add min_attendance, decision_deadline, venue_status. Row/card copy can say "8 going · 4 spots open · 2 more
needed · host confirms by 4 p.m." — each number from its own field. A cron marks sessions below minimum at the
deadline as not happening and notifies attendees (host can override). Tests: frozen clock around the deadline.
```

**4.4 Waitlist and offers** · M · Lane Events · Needs: 4.3, 4.pre · migration
```
Atomic join RPC: going if a seat is free, else waitlisted. Leaving offers the seat to the next eligible person with
an expiry; they count as going only when they accept; expired offers move on. A stale offer can never displace a
confirmed attendee. Close the legacy direct-write paths exactly as the approved 4.0 spec says (web repository and
native api.ts). Paid events keep their existing fulfillment rules. Required (two real connections): racing for the
last seat; a direct PostgREST insert racing an offer acceptance; expiry racing acceptance; double-accept; paid
fulfillment still works under its existing rules; duplicate notification delivery.
```

**4.5 Recurring series** · L → split 4.5a model+host tools, 4.5b series page · Lane Events · Needs: 4.4 · migration
```
4.5a: Host creates a series; occurrences are generated a few weeks ahead only (no months of phantom events).
Change this occurrence vs this and future. Cancel one Thursday without touching the next.
4.5b: Permanent series page: next confirmed session, past sessions, hosts, newcomer note, follow (updates only, no
RSVP). Tests: cancel one, edit future, DST change between occurrences, revoked host.
```

**4.6 Material-change notifications** · S · Lane Events · Needs: 4.5
```
Time, venue, cancellation and offer events notify only affected attendees, deduped, respecting quiet hours and
blocks. Reuse the existing notifications pipeline.
```

**4.7 Venues ↔ activities, mode-aware pins** · M · Lane Map · Needs: 2.4a, 4.3
```
Place page lists upcoming sessions at that venue. Map pin labels change with browsing mode: places = icon (name on
select), events tonight = start time, pickup = open spots, dense = count. Labels get richer only on zoom/select.
```

### M5 — Shared outings and group decisions

**5.0 SPEC — outings** · M · Lane Outings · Needs: 3.1
```
Design (no code): outing (owner, title, timezone, decision_deadline, status draft/deciding/locked), members (role
host/member, invited/joined/removed), invite tokens (expiry, revocation), shortlist items (place ref + who added +
a short public reason — never the source list, private note or tags), votes (yes / fine / can't per member per item,
one current vote), hard constraints (dietary, accessibility, budget) that veto rather than get outvoted, lock and
change log. Browser invite flow for people without the app: identity required before voting. RLS for every table,
direct-API attack cases, realtime approach (polling is fine for v1).
Anchor commitment: an outing can be started from an event occurrence ("Start outing from this event"). It stores
the occurrence ID, and its timezone and fixed start time become a locked constraint for planning. Define what
happens to the outing when the occurrence moves or is cancelled. Batch plan for 5.1–5.5. Wait for approval.
```

**5.1 Outing core and invites** · M · Lane Outings · Needs: 5.0 · migration
**5.2 Shortlist from library** · M · Lane Outings · Needs: 5.1 · (enables "Add to outing" on place page via flag)
**5.3 Voting, constraints, deadline and lock** · M · Lane Outings · Needs: 5.2 · migration
**5.4 Invite landing for signed-out friends + notifications** · M · Lane Outings · Needs: 5.3
**5.5 Start outing from an event** · S · Lane Outings · Needs: 5.1, 4.5 — button on the event page; the outing
carries the occurrence ID, timezone and fixed time; a moved/cancelled occurrence flags the outing.

Prompt for each: `Implement batch <5.x> from the approved outings spec in docs/features/5.0.md.` plus the batch's
acceptance from the spec. 5.3 must include: removed member loses access everywhere (map, page, notifications,
API), expired invite fails, simultaneous edits cannot replace a locked decision.

### M6 — Dependable itinerary

**6.0 SPEC — routing and feasibility** · S · Lane Trips · Needs: 0.2
```
Design (no code): a routing adapter interface (walking first) with a deterministic fake for tests, caching,
timeouts and an "unknown" result; compare providers on terms and cost. A pure feasibility validator: inputs = stops
(fixed or flexible, duration, opening hours), start point, window, max walking, timezone; outputs = feasible plan or
the failing constraint plus a suggested edit. How the existing planner (src/server/trips/planner.ts, tools.ts)
changes: drop the fixed New York timezone, AI proposes order, validator decides.
Persistence: today saving a trip only stores place IDs in the owner's list (src/server/actions/trips.ts). Design a
persisted, versioned itinerary owned by the outing (stops, times, fixed anchors incl. the event occurrence, route
legs, validation result, version + who changed it), readable by current members only. Wait for approval.
```
Human decision needed: routing provider.

**6.1 Routing adapter** · M · Lane Trips · Needs: 6.0
**6.2 Feasibility validator** · M · Lane Trips · Needs: 6.0 (can run parallel to 6.1 — pure TS)
```
Required cases: 6 p.m. reservation can't be reached at 6:20 and is reported infeasible; straight-line shortcut
across a river; unreachable stop; provider timeout → last valid plan kept; overnight window; DST change; venue
becomes hidden after planning.
```
**6.3 Planner integration + persisted itinerary** · M · Lane Trips · Needs: 6.1, 6.2, 5.3, 5.5 · migration —
plan from a locked outing including its anchor occurrence; save as a versioned itinerary. Acceptance: a second
member reopens the same plan after refresh; moving or cancelling the game marks the plan invalid; a removed member
loses access to it (page and API).
**6.4 Itinerary editor** · M · Lane Trips · Needs: 6.3 — pin a reservation, reorder, drop optional stop, recalculate,
clear conflict messages, uncertainty labelled; every save creates a new version.

### M7 — Local freshness and the return loop

**7.1 Flash maps** · M · Lane Place · migration — named curator, neighborhood boundary, start/end dates, auto-archive,
"past edition" label, curator can maintain without an engineer.
**7.2 Live reports pilot** · M · Lane Map · migration — only queue length, courts/seats available, temporary closure.
observed_at, expiry, corrections; no reports = "unknown", never "quiet"; pilot area only behind a flag.
**7.3 Post-visit prompt** · M · Lane Place · Needs: 2.6 — one optional action after a visit: confirm a tip, correct
it, or compare. Adapt ComparePrompt to compare within category/occasion, add "Different experiences" and "Can't
remember", keep sessions short. Declining never blocks saving or planning.
**7.4 Contributor feedback** · S · Lane Place — "Your tip helped 4 people this week". No cash, no public volume
leaderboard.

### M8 — Native parity and release

Native work continues the existing blockers (Lane C in astra-prompts.md) alongside. Each ticket's acceptance is
run on a real iOS device and a real Android device; record per-platform evidence.

| ID | Ticket | Needs | Device acceptance |
| --- | --- | --- | --- |
| 8.1a | Native Explore: event pins + persistent preview, return-to-map keeps camera | 2.2, 4.7 | Co-located pins, back navigation, denied location |
| 8.1b | Native event details: join / leave / waitlist / accept offer via the 4.4 RPCs only | 4.4 | Last-seat race with web client, offer expiry while app is backgrounded |
| 8.1c | Native outing participation: view shortlist, vote, see lock | 5.3 | Removed member loses access after relaunch |
| 8.1d | Signed-out invite deep links → sign in → land on the outing | 5.4 | Cold launch from link, link for an expired invite |
| 8.1e | View agreed itinerary (read-only) | 6.3 | Plan invalidated by a moved game shows as invalid |

**8.2 Golden-journey e2e** · M · Lane Core · **start in wave 2** — one e2e script for the milestone journey in demo
mode. Wave 2 version: onboarding → first map → first save. Extend it as each milestone merges (event join in wave
4, outing decision in wave 6, itinerary in wave 7).
**8.3 Pilot metrics** · S · Lane Core · **checkpoint events by wave 2** — instrument time to first useful save
before checkpoint 1 and shortlist → decision time before checkpoint 2; add the rest (import correction rate,
sessions cancelled below minimum, offers accepted, repeat outings, self-reported attendance) as features land.
**8.4a Prepare the release gate** · M · Lane Core — record the candidate commit and actual migration head; rewrite
docs/beta-gate.md rows for every migration through that head and every roadmap capability; update
scripts/staging-check.ts for the new features with the `--allow-staging-writes` guard. (Supersedes D1/D2, which
stop at 0038 and forbid staging runs.)
**8.4b Execute the release gate** · M · you + Codex — run the guarded staging checks against the candidate,
multi-user access checks (host, participant, outsider, moderator, removed member), backup/restore, and device
evidence for each native platform being approved. Separate go/no-go for web, iOS and Android, with evidence links
in §7.

---

## 5. Lanes and waves

Lanes own files so Astra and Sol can work at once in separate worktrees:

| Lane | Owns | Tickets |
| --- | --- | --- |
| Core | security limiter callers, globals.css, components/ui, config.ts flags, seed, test harness, e2e, gate | 0.1, 0.3, 1.1, 4.pre, 8.2, 8.3, 8.4a |
| Map | ExploreClient, MapCanvas, onboarding | 1.2–1.4, 2.1–2.3, 2.4a, 2.4b, 4.7, 7.2 |
| Place | places/[id], saved/, import, tips | 2.5–2.7, 3.1–3.5, 7.1, 7.3, 7.4 |
| Events | events/, EventForm, event types, attendee write paths | 1.5, 4.0–4.6 |
| Outings | new outings area | 5.0–5.5 |
| Trips | src/server/trips, components/trips, plan/ | 6.0–6.4 |
| Native | apps/mobile | 8.1a–8.1e |

Suggested waves with two agents (A = Astra, S = Sol). Spec tickets are cheap — run them early so your approval
isn't the bottleneck.

| Wave | Agent A | Agent S | You (non-code) |
| --- | --- | --- | --- |
| 0 | 0.1 (blocked until green, then Codex review) | 0.2 (read-only, can start now) | Pick the pilot neighborhood; name the integration owner |
| 1 | 0.3 → 1.1 | 4.0 SPEC, 3.3 SPEC, 6.0 SPEC | Approve specs; choose place + routing providers; start recruiting 3–5 hosts |
| 2 | 1.2 → 1.3 → 1.4, 8.2 (first-save e2e), 8.3 (checkpoint 1 events) | 1.5 → 4.1, 4.pre | Mobbin session; **checkpoint 1** with 5 newcomers |
| 3 | 2.1 → 2.2 → 2.3 → 2.4a | 4.2 → 4.3 | Gather real places + firsthand tips for the pilot |
| 4 | 2.5 → 2.6 → 2.7, 2.4b | 4.4 → 4.5a → 4.5b → 4.6; extend 8.2 | Hosts create real series in staging |
| 5 | 3.1 → 3.2 → 5.0 SPEC | 6.1 + 6.2; 8.1a, 8.1b | Approve outings spec |
| 6 | 3.4a → 3.4b → 3.5 | 5.1 → 5.2 → 5.3 → 5.4 → 5.5; 8.3 (checkpoint 2 events) | **Checkpoint 2**: a real 3-friend outing |
| 7 | 4.7, 7.1, 7.3, 7.4 | 6.3 → 6.4, 7.2; 8.1c–8.1e; extend 8.2 | Recruit a flash-map curator |
| 8 | 8.4a | 8.4b with you | Device testing; per-platform go/no-go |

**Checkpoints** — stop and look at the whole product, not just tickets:
- After wave 2: can a real newcomer get from onboarding to a first useful save? If not, fix before going further.
- After wave 6: can a real group agree on and attend an outing? Only then invest heavily in routing polish, live
  reports and incentives.

---

## 6. Migration ledger

One **integration owner** (you, or Codex on your behalf) reserves numbers on the shared base branch **before**
work starts, commits the ledger there, and only then cuts worktrees. Agents never edit this table in their own
worktree — two worktrees would each see the same number as free. Before every merge: check numbers are unique
across all open branches and apply every migration in order on a fresh database.

| Number | Ticket | Status |
| --- | --- | --- |
| 0039 | Security batch 3 (F4/F11/F8) | staged, earlier evidence passing |
| 0040 | Security batch 1 (F2/F3/F7), ticket 0.1 | staged, **not compiling** |
| reserve as needed | Security batches 2, 4, 5 | not started — reserve before roadmap tickets if they need migrations |
| next free | first roadmap ticket with a migration | |

---

## 7. Scoreboard (80 points)

Points are awarded when the named acceptance test passes on the required surface **and** an evidence link is
recorded — not when code merges.

| Capability | Pts | Tickets | Acceptance test | Required surface | Evidence |
| --- | --- | --- | --- | --- | --- |
| Local editorial design and onboarding | 8 | 1.1–1.5 | 8.2 e2e: onboarding (choose / skip) → first map honours choices → first save | Mobile web | ☐ |
| Explore and place decisions | 12 | 2.1–2.7, 4.7 | Co-located pins, map↔list sync, state restore, no-photo place decision | Mobile web; native 8.1a | ☐ |
| Personal library and importing | 10 | 3.1–3.5 | Import fixture (duplicate, two branches, unknown, aside) → private reviewed saves; nothing published | Authenticated web | ☐ |
| Events, sports, recurring groups | 13 | 4.0–4.6, 4.pre | Two-connection last-seat + offer races; cancel one occurrence leaves next intact | Mobile web; native 8.1b | ☐ |
| Shared outings and group decisions | 12 | 5.0–5.5 | Three users: 5 suggestions → locked choice; removed member / expired invite denied via API | Mobile web; native 8.1c–d | ☐ |
| Dependable itinerary planning | 10 | 6.0–6.4 | 6 p.m. anchor infeasible at 6:20; second member reopens plan; moved game invalidates it | Mobile web; native 8.1e | ☐ |
| Local knowledge and return visits | 7 | 7.1–7.4 | Expired report/map hidden from current discovery; declining post-visit prompt never blocks | Mobile web | ☐ |
| Platform and release readiness | 8 | 0.1, 0.3, 8.2–8.4b | 8.4b staging gate + multi-user checks + device evidence per approved platform | Staging; iOS; Android | ☐ |

**Deferred (the other 20):** paid curator marketplace (6), broader social and bulk-media imports (5), multi-city
live coverage and non-walking routing (5), richer taste matching and progression (4). Don't start these until the
pilot shows repeat outings.

---

## 8. Human-only work (agents can't do these)

- Choose the place-data provider (3.3) and routing provider (6.0) after reading the specs' terms comparison.
- Recruit 3–5 dependable hosts and one flash-map curator in the pilot neighborhood.
- Collect real places and firsthand tips with permission; keep them separate from fictional demo data.
- Mobbin research: interest pickers, map + bottom sheet, event detail with attendees, no-photo saved places.
  Capture untouched / one selected / next screen for each.
- Five-person usability tests at the two checkpoints. Record first wrong tap and whether predictions were right.
- Approve every SPEC before its build tickets start.
