# Feature status matrix (roadmap ticket 0.2)

Recorded 2026-11-05. Read-only inventory; no code was changed.

**Source baseline:** `tier1-owner-controls` at `c5fc858`. Paths and line numbers below refer to that
commit. The working branch `claude/magical-edison-cbsqxg` also carries the unmerged security work
0.1a (durable abuse limits). Where that matters it is called out, and it is never counted as a
feature. The base branch does not currently pass typecheck because of the unfinished security batch;
per the owner, that is excluded here and is not a feature finding.

**Scope:** every capability row of the scoreboard in [roadmap-80.md](roadmap-80.md) §7 (the version on
this branch, rewritten 2026-11-04), and every row of the Decided table plus the photo idea in
[founder-decisions.md](founder-decisions.md).

## How to read the marks

| Column | Values and what they rest on |
| --- | --- |
| Present in source | **Yes** / **Partial** / **No**, with file paths. Read from source only. |
| Enabled in staging | **Unknown** unless a dated doc records it. I had no access to staging. The latest recorded hosted run is [release-mobile-verification.md](release-mobile-verification.md) §"Authenticated staging follow-up — 2026-10-19" and §"Preview deployment follow-up": Supabase project `ebwgdjocwusxdamojarj`, Vercel **Preview** of commit **`e9497e2`** (2026-10-15), migration head **0029**, feature flags not recorded. That commit is 40 commits and 11 migrations (0030–0040) behind the baseline. "Seen 10-19" below means *observed on that older preview*, not that the current source is deployed. |
| Verified on web | **Local** = a browser suite exercises it on a local demo-mode build (`scripts/e2e.mjs`, 19 steps; `scripts/e2e-features.mjs`, 11 steps; status in [beta-gate.md](beta-gate.md) "End-to-end": "Passed locally: 19/19"). **Seen 10-19** = observed in the signed-in hosted browser check above. **No record** = no browser run found. Unit/DB tests alone are cited as evidence for *present*, not *verified*. |
| Verified on iOS / Android | **No — never run on a device.** [native-release-blockers.md](native-release-blockers.md) line 6: "nothing here has run on a phone"; [release-mobile-verification.md](release-mobile-verification.md) line 258: "Native execution: NOT RUN". **Not in app** where `apps/mobile` has no screen for it. |

## Scoreboard rows

### 1. Design foundation and onboarding (Local editorial + Quiet utility) — 8 pts, tickets 1.1–1.5

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 Tokens and primitives | Colour, radius, shadow and font tokens in `src/app/globals.css:9–55`. One generic `.card` (background + border + radius + shadow) at `globals.css:131–136`, used almost everywhere: exactly what 1.1 says to remove. No type-role or spacing tokens. None of `Row`, `SectionHeader`, `Surface`, `StatusLabel`, `PlaceGlyph` or `DateBlock` exists (search of `src/` finds none). `src/components/ui/` has `Avatar, BackButton, Badge, Button, Chip, DetailSkeleton, EmptyState, Field, ListSkeleton, PageHeader, Sheet, Stars, TaxonomyIcon, Toast`. No `/dev/ui` page. | **No** (only base tokens) | Unknown | No record | Not in app | Not in app |
| 1.2 Interest picker | `src/components/onboarding/WelcomeFlow.tsx`: four skippable steps (Interests, Home city, Location, People, `:27`). Interests are chips, not thumbnail rows (`:133–137`). Up to **12** can be picked (`:104`), but only the first **8** reach the map (`:86` `slice(0, 8)`): the mismatch 1.2 names is still there. | **Partial** | Seen 10-19 (onboarding passed, release-mobile-verification.md:23–26) | Local (e2e step "onboarding: interests, home city, location, people, then the filtered map") | Not in app | Not in app |
| 1.3 First-map arrival | Explore receives `?tags=…&welcome=1` and shows a welcome state (`src/components/explore/ExploreClient.tsx:52, 74`; `src/app/(explore)/page.tsx:43`). Selected interests become active filters. No per-interest "no results nearby" message or offered widening was found. | **Partial** | Seen 10-19 ("interest-filtered map") | Local (same e2e step) | Not in app | Not in app |
| 1.4 People step | `WelcomeFlow.tsx:177–198` lists matching people with name and @username only. No "Also into…" line, and no distinction between suggested, followed and friends. `PersonCard` elsewhere shows shared interests (`src/components/profile/PersonCard.tsx:8–9`). **On hold** by founder decision. | **Partial** | Seen 10-19 ("following only the fixture owner") | Local | Not in app | Not in app |
| 1.5 Quiet-utility Events tab | `src/components/events/EventsClient.tsx`: filter chips Upcoming / Today / This week / Joined / Been to (`:97–103`); groups by Today, Tomorrow, then a weekday date per day (`:75–88`), not Today / Tomorrow / This weekend / Later. Rows are `EventCard` cards with a calendar date block (`src/components/events/EventCard.tsx:38–42`), not flat rows; no expand-in-place. | **Partial** | Unknown | Local (e2e "create an event", "join an event" use the events pages) | Partial in app: `apps/mobile/app/(tabs)/events.tsx` (plain list); never run | Same |

Scoreboard acceptance ("8.2 e2e: onboarding → first map honours choices → first save"): the existing
e2e covers onboarding, filtered map and save-to-list as separate steps (beta-gate.md "End-to-end"). The
8.2 golden-journey script does not exist (`scripts/` has `e2e.mjs`, `e2e-features.mjs`, no golden
journey).

### 2. Explore and place decisions — 12 pts, tickets 2.1, 2.2, 2.4a, 2.4b, 2.5–2.7, 4.7

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 Clustering | No clustering in `src/components/map/` or `src/components/explore/` (search for "cluster" finds nothing). Pins: `src/components/map/Pin.tsx`. | **No** | Unknown | No record | No | No |
| 2.2 Selection and state | One-way sync: hovering a list row selects its pin (`ExploreClient.tsx:484` `onHover`); a selected pin shows `PreviewCard` (`:343`). No URL state: no `useSearchParams`/router writes in `src/components/explore/`. Camera, filters and selection are not restored on back navigation. | **Partial** | Unknown | Local (e2e "open a place from the list") | No | No |
| 2.4a Intent filters | Category chips, interest tags, kind (all/places/events) and a "Nearest" sort (`ExploreClient.tsx:71–73, 95, 267`). No When filter (now/tonight/weekend), no travel-time filter ("15 min away"). | **Partial** | Seen 10-19 (taxonomy filters rendered on preview, release-mobile-verification.md:104–105) | Local | No | No |
| 2.4b Activity filters | No "Has room", "Needs players" or "Beginner-friendly": the data does not exist (`events` table, `supabase/migrations/0001_init.sql:129–147`, has only `capacity`). | **No** | Unknown | No record | No | No |
| 2.5 Place page | `src/app/places/[id]/page.tsx`: hero photo or generated category cover first (`:70`), then name (`:97`), rating control with count (`:122`), local tip (`:125–131`), About (`:135`), photos (`:152`), reviews (`:154`), Where/mini-map (`:156`), "Happening here" events (`:175`). No travel time or hours, no "known for" line, no best for / less suited, no "Add to outing". | **Partial** | Seen 10-19 (public place details and image decode) | Local (e2e "open a place", "add a place with a photo") | Partial: `apps/mobile/app/place/[id].tsx` (name, tags, save, save-to-list; **no photos**, native-release-blockers.md "Photo gallery parity") | Same |
| 2.6 Tip provenance | A single creator-written `places.local_tip` column (`0001_init.sql:66`), edited with the place. No author, confirmation, kind, expiry or correction. | **No** | Unknown | No record | No | No |
| 2.7 Best for / less suited | Nothing (no occasion schema or UI). Blocked on open question 6. | **No** | Unknown | No record | No | No |
| 4.7 Venue sessions, mode-aware pins | "Happening here" lists upcoming events at the place (`places/[id]/page.tsx:175–195`). Pins are icon-only with an aria label (`Pin.tsx:26, 41`), with no mode-dependent labels. | **Partial** | Unknown | No record | No | No |

### 3. Personal library and importing — 10 pts, tickets 3.1–3.6

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 Richer saves | `saved_places` is `(user_id, place_id, created_at)` only (`0001_init.sql:118–123`); no later migration adds columns. Named lists exist: `saved_lists` / `saved_list_items` (`0009_saved_lists.sql:21–43`), tested in `tests/saved-lists.test.ts`. No private note, tags, source URL, recommended_by or status. A rating note exists, but it is **public** (`PlaceReviews`). | **Partial** (lists only) | Seen 10-19 (save sheet accepted a new list) | Local (e2e "save it to a new list") | Partial: save and add-to-list in `apps/mobile/app/place/[id].tsx:31`, `(tabs)/saved.tsx` | Same |
| 3.2 Library tools | `src/components/places/SavedClient.tsx`: text search and sort (Recent / Top rated / Nearest / A–Z, `:12–17, 37–59`); remove from a list (`src/components/saved/RemoveFromListButton.tsx`). No filter by tag/status, no multi-select, bulk edit, undo or export. | **Partial** | Unknown | No record | No | No |
| 3.3 Matching SPEC | No spec doc in `docs/` or `docs/briefs/`. | **No** | n/a | n/a | n/a | n/a |
| 3.4 Notes importer | Nothing found (no import route, action or table). | **No** | Unknown | No record | No | No |
| 3.5 Link importer | Nothing found. | **No** | Unknown | No record | No | No |
| 3.6 Pick from my saves | No picker. Closest: the AI trip planner's `my_saved` tool reads the person's saves to propose a plan (`src/server/trips/tools.ts:38–39, 131`), behind the `tripPlanning` flag (`src/lib/config.ts:64, 77`). | **No** (adjacent only) | Unknown | No record | No | No |

### 4. Events, sports, recurring groups — 13 pts, tickets 4.0–4.6, 4.8, 4.pre

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 4.0 SPEC | No spec doc. | **No** | n/a | n/a | n/a | n/a |
| 4.pre Two-connection harness | Not on the baseline. **On this branch only (unmerged, 0.1a):** `tests/helpers/postgres.ts` and `tests/abuse-limits-pg.test.ts`, recorded in [security-audit-repair.md](security-audit-repair.md) "Batch 1 - 0.1a". | **No** on base; Yes on branch | n/a | n/a | n/a | n/a |
| 4.1 Event page | `src/app/events/[id]/page.tsx`: title (`:89`), going / spots left (`:116–120`), price and ticket (`:123–139`), Details (`:148`), Hosted by (`:165`), Who's going (`:180`), Meeting point (`:196`). **The "Free to join. Just show up." copy still shows when a price is set** (`:120` does not check `price`; the ticket button follows at `:123`), which is the bug 4.1 names. No newcomer block. | **Partial** | Seen 10-19 (event join/leave persisted, capacity 9→8→9) | Local (e2e "join an event"; e2e-features ticket steps) | Partial: `apps/mobile/app/event/[id].tsx` (join/leave via direct table writes) | Same |
| 4.2 Structured details | Nothing: `events` has no activity-detail columns (`0001_init.sql:129–147`, `0022_payments.sql:19–20` adds price only). | **No** | Unknown | No record | No | No |
| 4.3 Minimum and readiness | Capacity only, enforced by a trigger ("This event is full", `0001_init.sql:278`; `0022_payments.sql:213, 248`). No min_attendance, deadline, venue status or cron. | **Partial** (capacity) | Seen 10-19 (capacity counts) | Local | Partial (DB-enforced capacity) | Same |
| 4.4 Waitlist and offers | Nothing. Direct writes to `event_attendees` remain on web (`src/lib/data/supabase/repository.ts:1021, 1025`) and native (`apps/mobile/lib/api.ts:76, 79`). | **No** | Unknown | No record | No | No |
| 4.5 Recurring series | Nothing (no series or occurrence schema). | **No** | Unknown | No record | No | No |
| 4.6 Material-change notifications | A notifications pipeline exists (`src/app/api/cron/notifications/route.ts`, `src/server/notifications/push.ts`, `tests/notifications.test.ts`). Whether it covers time/venue changes as 4.6 specifies was not traced. Offers do not exist. | **Partial** (pipeline only) | Unknown | Local (e2e-features "notification settings save") | Unknown | Unknown |
| 4.8 Party poster | Nothing; every event uses `EventCard` (`EventCard.tsx`). | **No** | Unknown | No record | No | No |

### 5. Shared outings and group decisions — 12 pts, tickets 5.0–5.5 (blocked, open question 2)

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 5.0–5.5 | No outing, shortlist, vote, invite-token or lock schema or UI. "outing" appears only in the trip planner's prompt text (`src/server/trips/planner.ts:55`). Messaging is direct-only: `start_direct(uuid)` (allowlisted in `tests/fixtures/function-grants.ts`), UI in `src/app/messages/`. That is the nearest thing to "friends discuss plans among themselves". | **No** | Unknown | No record (messaging: Local, e2e-features "messaging starts a permitted conversation") | No | No |

### 6. Dependable itinerary planning — 10 pts, tickets 6.0–6.4

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 6.0 SPEC | No spec doc. | **No** | n/a | n/a | n/a | n/a |
| 6.1 Routing adapter | None. Travel is straight-line: `distance` tool, "80 m/min walking, 400 m/min driving" (`src/server/trips/tools.ts:138–142`). | **No** | Unknown | No record | No | No |
| 6.2 Feasibility validator | None; the AI's plan is submitted as-is (`submit_plan`, `tools.ts:50`). | **No** | Unknown | No record | No | No |
| 6.3 Planner + persisted itinerary | An AI planner exists: `src/server/trips/planner.ts` (window hard-coded to `America/New_York`, `:82`), UI `src/components/trips/TripPlanner.tsx`, page `src/app/plan/page.tsx`, tests `tests/trips.test.ts`, flag `tripPlanning` (needs `ANTHROPIC_API_KEY`, `config.ts:77`). Saving only creates a list of the places (`src/server/actions/trips.ts:13–36`); there is no itinerary record. | **Partial** (planner only) | Unknown | No record | Not in app | Not in app |
| 6.4 Itinerary editor | None. | **No** | Unknown | No record | No | No |

### 7. Local knowledge and return visits — 7 pts, tickets 7.1–7.4

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 7.1 Flash maps | Nothing (no curator, edition or boundary schema). | **No** | Unknown | No record | No | No |
| 7.2 Live reports | Nothing. | **No** | Unknown | No record | No | No |
| 7.3 Post-visit prompt | Head-to-head comparisons exist: `src/components/places/ComparePrompt.tsx`, migrations `0037_place_comparisons.sql`, `0038_comparison_taste.sql`, tests `tests/place-comparisons.test.ts`, `tests/compare-flow.test.ts`. Not tied to a visit, and no "Different experiences" or "Can't remember" option (not in `ComparePrompt.tsx`). Tip confirm/correct needs 2.6. | **Partial** | Unknown. 0037/0038 postdate the last staging record (head 0029). | No record | No | No |
| 7.4 Contributor feedback | Nothing ("helped" / "your tip" not found in `src/`). Reputation exists (`0016_reputation.sql`, `src/app/help/reputation/page.tsx`), but it is not the 7.4 message. | **No** | Unknown | No record | No | No |

### 8. Platform and release readiness — 8 pts, tickets 0.1, 0.3, 8.2–8.4b

| Ticket | What exists today | Present | Staging | Web | iOS | Android |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1 Security batch 1 | Base: limiter SQL and helpers staged in `b1c0e20`, callers unfinished (base typecheck fails; excluded per owner). **Branch only:** 0.1a implemented, recorded in [security-audit-repair.md](security-audit-repair.md) "Batch 1 - 0.1a". 0.1b not started. | **Partial** | Unknown (0040 is undeployed per the repair doc) | n/a | n/a | n/a |
| 0.3 Pilot flags and seed | One registry, `FEATURES` / `featureEnabled()` in `src/lib/config.ts:58–95`, with no pilot flags. Seed: `src/lib/seed/seed-data.ts` has personas, moderators (`:530`) and admins (`:535`); there are no explicit host/participant/outsider roles and no pilot-vs-fictional marking. | **Partial** | Unknown (flags not recorded on preview, release-mobile-verification.md:92) | n/a | n/a | n/a |
| 8.2 Golden-journey e2e | Not present. Related suites: `scripts/e2e.mjs` (19 steps), `scripts/e2e-features.mjs` (11 steps), run in CI (`.github/workflows/ci.yml:44, 57`). | **Partial** | n/a | Local (beta-gate.md "End-to-end") | No | No |
| 8.3 Pilot metrics | Analytics funnel and admin metrics: `src/app/admin/metrics/page.tsx:55–81`, `0015_analytics.sql`, `tests/analytics.test.ts`, behind the `analytics` flag. "Time to first useful save" and "shortlist → decision" are not defined. | **Partial** | Unknown | No record | n/a | n/a |
| 8.4a Release gate prep | `docs/beta-gate.md` (decision 2026-10-14: **NOT APPROVED**; table written at "Session 9", migrations 0001–0014) and `scripts/staging-check.ts` (guarded by `STAGING_PROJECT_REF` and `--allow-staging-writes`, release-mobile-verification.md:217–218). Not updated for 0015–0040. | **Partial** | n/a | n/a | n/a | n/a |
| 8.4b Execute the gate | Not run against current source. Hosted staging gate "NOT RUN" (release-mobile-verification.md:260); native "NOT RUN" (`:258`). | **No** | Not run | Not run | Not run | Not run |

## Founder decisions vs. what exists

Each row of the Decided table in [founder-decisions.md](founder-decisions.md), plus the photo idea.

| Decision | What exists today (evidence) | Distance to the decision |
| --- | --- | --- |
| **Overall look:** Local editorial + Quiet utility in separate scenarios; Social journal structure scrapped | One undifferentiated style: `.card` with shadow on everything (`globals.css:131–136`); no editorial vs utility treatments (no primitives, see 1.1). "Social journal" appears nowhere in source or docs except founder-decisions.md, so I could not map it to code. | **Far.** Both treatments still have to be defined (ticket 1.1). Before removal can be scoped, someone needs to say which current screens "Social journal" refers to. |
| **Events tab:** Quiet utility; events you usually go to or signed up for | `/events` is a general upcoming feed with filter chips; "Joined" and "Been to" are filters, not the main view (`EventsClient.tsx:97–103`). Cards, not utility rows (`EventCard.tsx`). No notion of "usually go to" (no series or follow, see 4.5). | **Far.** The tab's purpose flips from browse to mine, and rows change from cards to flat rows. "Usually go to" has no data source yet. |
| **Event detail:** Local editorial | A functional page with sections (`events/[id]/page.tsx:89–196`); no editorial treatment; the paid-event "Free to join" copy bug (`:120`). | **Medium.** The structure exists; it needs the treatment from 1.1, the reorder in 4.1 and the copy fix. |
| **Explore map:** no list on the map tab; filter tabs such as "15 min away" and "Has room" stay | Mobile web: separate map and list modes (`ExploreClient.tsx:75` `mode`; `:276` map hidden in list mode) plus a bottom results summary on the map (`:349–352`), which already fits the decision. **Desktop web: the list is a side drawer beside the map** (`:357–362` "side drawer on desktop"). **Native: a list sits directly under the map on the same screen** (`apps/mobile/app/(tabs)/index.tsx:39–46`). Neither "15 min away" nor "Has room" exists (2.4a/2.4b). | **Mobile web: close.** Desktop and native: open question whether the decision covers them (raised in roadmap-80.md). Both named filter tabs are missing; "Has room" also needs new data (4.3). |
| **Place page:** photo first, scroll for more | A hero photo, or a generated category cover, already opens the page (`places/[id]/page.tsx:70`, `PlaceCover layout="hero"`). Further photos sit mid-page (`:152`). Native place screen has no photos at all. | **Close on web** (hero is already first; the rest is reordering for 2.5). **Far on native.** |
| **Event card:** host-toggled Party poster; Readiness row otherwise; calendar date block rejected | **Every event card uses a calendar date block** (month / day / weekday tile, `EventCard.tsx:38–42`), the design the founder rejected. Card shows attendees/capacity (`:68–73`). No poster toggle; no readiness fields (min, deadline). | **Far.** The rejected element is live and needs removing; the Readiness row needs 4.3 data; the poster needs 4.8. |
| **Group outing vote:** pushed until after events; friends discuss among themselves | No outing or vote code exists (row 5). Direct messages exist (`src/app/messages/`, `start_direct`). No group chat. | **Consistent with "pushed".** If "discuss among themselves" means in-app, only 1:1 messages exist. |
| **Cards and elevation:** role-based surfaces | Opposite today: one shadowed card for everything (`globals.css:131–136`), and also used for reviews, ratings and list panels (`PlaceReviews.tsx`, `RatingControl.tsx:119`, `ExploreClient.tsx:365`). | **Far** (ticket 1.1). |
| **Social context line:** on hold | What exists: attendee avatar stack and count on event cards (`EventCard.tsx:68–73`); shared-interest chips on `PersonCard` (`PersonCard.tsx:8–9`); onboarding People step shows no reason (`WelcomeFlow.tsx:184–193`). | **On hold.** No change wanted now. Note that the event-card avatar stack is a form of social line and stays live. |
| **Personality:** photography-led | Places: hero photo plus up to six user photos, with a generated cover when there are none (README line 1010: "Places without photos get a generated category cover"). **Events have no photo field at all** (`0001_init.sql:129–147`). Native shows no place photos. | **Medium for places, far for events.** Events need an image source before they can be photography-led. |
| **Mapstr:** save first / tags later; what vs why; who recommended it; "Pick somewhere from my saves"; bulk edit; undo; export | Save is one tap (`SaveButton`), with optional save-to-list (`src/components/places/SaveButton.tsx`; e2e "save it to a new list"). A save stores nothing but the timestamp (`0001_init.sql:118–123`). Library: search and sort only (`SavedClient.tsx`). | **Save first: done.** Everything else is missing: tags, why/note, recommended_by, picker, bulk edit, undo, export (3.1, 3.2, 3.6). |
| **Yelp:** rating next to its count; relevant recent observation; separate personal fit, friends, community; claims open their evidence; sponsored kept separate | **Rating with count: done** on cards (`PlaceCard.tsx:59–60`), preview (`PreviewCard.tsx:55`) and place page (`RatingControl.tsx:127`). Sponsored: a separate, labelled slot (`SponsoredSlot.tsx:18–44`, `aria-label="Sponsored: …"`, dashed border) that never replaces organic results (README "Sponsored cards"; `tests/ads.test.ts` organic-identical test). There is no dated "recent observation" (tips undated, 2.6), no friends block distinct from community, and no tap-through to evidence. | **Two of six done** (count, sponsored). Recent observation, the three-way split and evidence links are missing (2.5, 2.6). |
| **Friends' reviews:** no summaries; show the actual reviews (Beli-like) | "What people say" lists **every** rating note, newest first, each attributed with stars and date (`PlaceReviews.tsx`; query `repository.ts:781–784` orders by `updated_at`, notes only). There are no summaries anywhere (searches for "friends saved/rated", "saved by" and "followed by" find nothing). But friends are not distinguished from strangers. | **Medium.** Showing actual reviews and having no summaries already holds. Missing: friends' reviews surfaced or marked as friends'. Open question 8 (check Beli) applies before designing. |
| **New idea:** public photo from online + required private photo on first visit | **Name collision:** "private place photos" already exist (`0005_private_photos_and_save_counts.sql`, `src/app/api/photos/[id]/route.ts`, `tests/photo-route.test.ts`). They mean *user uploads whose visibility follows the place*, served through a checked route (README lines 192–197), not a per-person private photo. No online photo source exists; all photos are user uploads (README line 1010). No visit detection exists. | **Far, and blocked** (open questions 3, 4, 5). Choose a different name for the new concept, or the two will be confused. |

## Biggest surprises

1. **Staging evidence is old.** The last recorded hosted check was on preview commit `e9497e2`
   (2026-10-15) at migration 0029. The baseline is 40 commits, 122 changed source files and 11
   migrations ahead. Nothing from 0030 onward (comparisons, taste, interaction attribution, atomic
   event creation, grants) has a staging record.
2. **The rejected calendar date block is the live event card** (`EventCard.tsx:38–42`).
3. **The place page already leads with a hero photo**, so "photo first" is mostly reordering what
   follows. The native place screen, by contrast, shows no photos at all.
4. **"Private place photos" already means something else** than the founder's private photo idea.
5. **Nothing has ever run on a phone.** The native Explore also puts a places list directly under
   the map and shows no events, which conflicts with "no list on the map tab" if that covers native.
6. **Paid events still say "Free to join. Just show up."** above the ticket button
   (`events/[id]/page.tsx:120`).
7. **A save holds no data at all** beyond its timestamp, so every Mapstr item except "save first"
   needs a migration.
8. **Desktop Explore shows the list beside the map**, which the "no list on the map tab" decision may
   or may not cover.
9. **The onboarding 12-vs-8 interest mismatch** that ticket 1.2 names is still in the code
   (`WelcomeFlow.tsx:86, 104`).
