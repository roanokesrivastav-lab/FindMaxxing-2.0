# Personalized recommendations: staged plan

Status: planning only. Written against `tier1-owner-controls` @ e33d1ec. Nothing here is applied.
Interaction logging is **in progress** in a parallel session (branch `claude/laughing-wilson-f4be90`,
draft migration `0031_user_interactions.sql`, uncommitted when this was written). Section 2 describes that
draft; if it changes before merge, the migration wins and this doc should follow.

## 1. Current state

"For you" is two `SECURITY INVOKER` SQL functions in `supabase/migrations/0018_recommendations.sql`,
mirrored line-for-line in `src/lib/data/demo/recommend.ts` (`recommendDemoPlaces`, `recommendDemoEvents`).
`src/server/recommendations/index.ts` (`forYouPlaces`, `forYouEvents`) gates them on sign-in and the
`recommendations` flag; with `aiRerank`, `rerank.ts` (`rerankPlaces`) asks Claude to reorder the 12 places
and rewrite the reason, falling back to rule order on any failure (`applyOrder` trusts nothing).

| Signal | Places | Events |
|---|---|---|
| Followed person added / hosts it | +4 | +4 |
| Followed person rated it ≥4 / is going | +3 | +2 |
| Shares a tag with something I saved or rated ≥4 | +3 | — |
| At a place I saved | — | +4 |
| Per tag matching `profile_interests` | +2 each | +2 each |
| Same category as events I joined / my usual weekday | +1 | +1 |
| Distance `2·exp(-d/3 km)` | 0..2 | 0..2 |
| Soon `1.5·exp(-Δt/3 days)` | — | 0..1.5 |
| Diversity: `source='community'` +1.5, `1.5/(1+save_count)` / <5 going +0.5 | ✓ | ✓ |

**Gaps.** No record of what was shown, so no negatives ("seen, ignored") and no way to measure anything.
No hide/"not for me". Low ratings (1–2) only exclude a place; they never push similar places down. Taste is
one global tag set, not per category (loving loud bars says nothing about study spots). No learning: weights
are hand-set. Cold users with no interests, follows or saves get an empty rail. No set-level diversity (12
coffee shops can win). Distance scale is 3 km for every category. No opening hours in the schema, so no
"open now". Weekday logic is hard-coded to `America/New_York`. `blocks` (0020) is not consulted, so places
and events from someone the viewer blocked can still be recommended.

## 2. Data to collect now

### Why `analytics_events` (0015) cannot be reused
`analytics_events.actor` is a salted hash with the salt unreadable by clients, rows are admin-only, the
`name` list has no impression/hide, `props` is ≤1 KB, it is skipped for `analytics_opt_out` users and purged
at 180 days. That is deliberate product-analytics privacy: it must stay unjoinable to a profile. A
recommender needs the opposite: rows keyed by the real `user_id`, readable by the owner, joinable to
`places`/`events`. Keep them separate; do not add a user id to `analytics_events`.

### `public.user_interactions` (in progress: draft `0031_user_interactions.sql`)

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint generated always as identity` PK | |
| `user_id` | `uuid not null default auth.uid()` → `profiles(id) on delete cascade` | insert policy forces `= auth.uid()` |
| `item_type`, `item_id` | `text` (`place`/`event`), `uuid` | no FK; `forget_item_interactions()` triggers on `places`/`events` delete clean up |
| `action` | `text` check in `impression, view, save, unsave, rate, directions, share, join, leave, hide` | save/unsave/rate/directions place-only; join/leave event-only |
| `surface` | `text null` check in `for_you, list, map, search, detail, saved, profile` | |
| `position` | `integer null` 0–999 | zero-based list position |
| `value` | `smallint null` 1–5 | required iff `action='rate'` |
| `created_at` | `timestamptz default now()` | not client-writable (column grants) |

- **RLS:** owner-only `select` and `delete`; `insert` only for own rows on items the writer can currently see
  (the subquery runs under the `places`/`events` policies, so locals-only ids cannot be invented); no
  `update`; no admin read. Service role has select/insert/delete.
- **Abuse:** `block_suspended_writes()` trigger (so closing accounts from 0027 cannot write); one
  `check_rate_limit('interactions')` tick per insert statement (600/h), ≤100 rows per batch.
- **Opt-out:** reuses `profiles.analytics_opt_out`; when set, only `hide` is recorded.
- **Hides:** "Not interested" is a `hide` row; the draft re-creates `recommend_places` / `recommend_events`
  (and the demo twin) to exclude hidden items. Undo deletes the hide rows. Retention never touches hides.
- **Retention:** `purge_user_interactions(365)` (service role) deletes `impression`/`view` older than a year;
  other actions stay until the account or item is deleted.
- **Deletion:** account deletion cascades via `profiles`; deleting a place/event deletes everyone's rows
  about it (also covers places/events removed by the 0027 lifecycle).
- **Indexes:** `(user_id, created_at)`, `(item_type, item_id)`, partial `(user_id, item_type, item_id) where action='hide'`.
- **Training read:** `interaction_item_stats(since)`, service role only, per-item counts and distinct people, never who.

**What the draft did not have (closed by `0033_interaction_attribution.sql`, Task 1, except the opt-out question):**

| Gap | Why it matters | Proposed fix |
|---|---|---|
| No `request_id` | cannot tie a save back to the impression/list that caused it (section 7) | `request_id uuid null`, unique `(user_id, request_id, item_type, item_id) where action='impression'` |
| No `policy` / `score` | cannot compare `rules-v1` vs `rules-v1+rerank` vs later models, or replay offline | `policy text null` (≤40), `score real null`, `propensity real null` for exploration slots (section 6) |
| save/rate/join written by the client | can be missed (client crash) or fabricated without a real save | `after insert/delete` triggers on `saved_places`, `place_ratings`, `event_attendees`; revoke those actions from client inserts |
| Opt-out shared with analytics | turning off analytics silently degrades recs | decide (open question 3) |
| `blocks` not applied in `recommend_*` | blocked people's content can be recommended | add exclusion in the same re-create |

Impression definition for the client: card ≥50% visible for ≥1 s, once per `request_id`.

## 3. Staged roadmap

| Stage | Users | Algorithm | Runs in | Effort | Bar to move on |
|---|---|---|---|---|---|
| 0 | 0–50 | Rules (existing) + logging + hides + cold-start fallback | Postgres fn | S | logging live 2 weeks, ≥2k impressions |
| 1 | beta 50–200 | Per-category content taste profiles; Beli-style pairwise ratings | Postgres fn + nightly job | M | ≥30% of active users have ≥5 positive actions in one category |
| 2 | 500+ active in one city | pgvector item embeddings; item-item CF on implicit feedback | pgvector + nightly job | M | item-CF beats content on offline recall@20 by ≥10% relative |
| 3 | thousands | User-user taste match; two-stage retrieval + learned ranker | nightly job + external trainer | L | ≥50k impressions/week, stable A/B infra |

### Stage 0: rules (existing), made measurable
*Why:* with no data, hand weights with explanations are the right model; learning is impossible.
*Do:* land 0031 (hides already excluded there) and the 0033 gaps in section 2, incl. `blocks` exclusion,
and a fallback for empty profiles: top community places by `save_count` decayed by age within the viewer's
`home_city`, labelled "Popular with locals". Stamp `policy='rules-v1'` on impressions.

### Stage 1a: per-category content taste profiles
*Why:* at 50–200 users there is plenty per user but nothing across users. Content features (tags, category,
neighborhood, price, `creator_reputation`) generalize from ~5 actions.
*Inputs:* `saved_places`, `place_ratings`, `event_attendees`, `user_interactions` (hide = −, impression
without click after 3 sightings = small −), `place_tags`, `event_tags`.
*Model:* for each `(user, category_slug)`, a tag-weight vector
`w[tag] = Σ action_weight · exp(-age/90 d)`, weights save +1, rate 5 +2, 4 +1, 3 0, 2 −1, 1 −2, join +1,
hide −2, ignored-impression −0.1. Score = cosine(w, item tags) per category, falling back to the global
vector when the category has <3 actions. Replaces the flat "+3 shares a tag" / "+2 per interest" with a graded
term; `profile_interests` becomes a prior (+1 per tag at stage 1).
*Where:* materialized table `user_taste(user_id, category_slug, tag, weight)`, rebuilt nightly by a service
function `refresh_user_taste()` (pg_cron) and incrementally on save/rate via the 0033 triggers. Owner-only RLS.

### Stage 1b: Beli-style pairwise ratings within a category
Beli's mechanism, as far as public sources show:

| Claim | Status |
|---|---|
| A new place is first put in one of three groups (liked / fine / didn't like) | Verified (press + user write-up): [Spoon University](https://spoonuniversity.com/recipe/rate-save-and-recommend-restaurants-on-app-beli), [HackerNoon](https://hackernoon.com/belis-binary-search-rating-system-explained) |
| Then repeated head-to-head "which did you prefer" against places you already ranked, with a skip ("too tough") | Verified (observed behaviour): [HackerNoon](https://hackernoon.com/belis-binary-search-rating-system-explained), [Spoon University](https://spoonuniversity.com/recipe/rate-save-and-recommend-restaurants-on-app-beli) |
| The comparisons are a binary-search insertion (≈log₂ n per new place) | Assumption (author's reconstruction, consistent with observed comparison counts) |
| The 0–10 score is derived from list position (e.g. linear within bucket) | Assumption (author's inference); a 6.2/10 shown as 76th place is [reported](https://www.thecrimson.com/article/2026/2/26/beli-inquiry/) |
| Two scores per place: predicted for you, and how your friends rated it | Verified (secondary): [Wikipedia](https://en.wikipedia.org/wiki/Beli_(app)) |
| Separate lists for bars, bakeries, coffee, ice cream | Verified (secondary): [Harvard Crimson](https://www.thecrimson.com/article/2026/2/26/beli-inquiry/) |
| Recommendations come from users with similar taste, not only nearby/friends | Verified as reported, internals unknown: [Long Beach Post](https://lbpost.com/esd/?p=74448), [Wikipedia](https://en.wikipedia.org/wiki/Beli_(app)) |
| Personal recs start after ~15 ranked places | Reported once (Spoon University), unconfirmed: treat as assumption |
| Any specific model (Elo, Bradley-Terry, matrix factorization) | Assumption: nothing public |

For FindMaxxing: within a `category_slug`, after a 1–5 `place_ratings` row the UI offers up to ⌈log₂ n⌉
comparisons against the user's own rated places in that category (binary search, start in the bucket the
star score implies). Store `place_comparisons(user_id, category_slug, winner_id, loser_id, created_at)`,
owner-only RLS. Derive a per-user per-category 0–10 score.

| | Elo | Bradley-Terry (chosen) |
|---|---|---|
| Fit | online, order-dependent; needs K tuning | batch MLE (MM iterations); order-independent |
| Sparse data (≤10 comparisons/item) | noisy, early games dominate | stable with a weak prior anchored to star bucket |
| Re-rank after an edit/delete | must replay history | refit; ~30 items × 20 iters, trivial |
| Cross-user use (stage 2/3) | scores not comparable | log-strengths are a clean per-user utility to feed CF |

Pick **Bradley-Terry with a Gaussian prior centred on the star rating** (`μ = (stars−3)`), fit in a
`plpgsql` function `fit_user_category_scores(user, category)` on each new comparison (n is small). The
rescaled strength becomes `user_place_scores(user_id, place_id, score_0_10)`, which (a) shows on the
profile like Beli's list, (b) replaces raw stars as the taste weight in 1a. Effort M.

### Stage 2a: pgvector embeddings
*Why:* tags are coarse (15 categories, ~30 interests). Text embeddings of `name + description + local_tip +
tags + neighborhood` separate "quiet study café" from "loud brunch café" and give new items a vector on day one.
*Where:* `create extension vector`; `places.embedding vector(N)` / `events.embedding`, filled by a job on
insert/update via an embedding API (external call; public fields only, same allow-list as `candidatePayload`).
User vector per category = weighted mean of liked item vectors minus hidden ones. HNSW index; retrieval
`order by embedding <=> $user_vec limit 200` inside the RLS-checked candidate set. Effort M.

### Stage 2b: item-item collaborative filtering on implicit feedback
*Why:* at 500+ actives in one city, co-occurrence becomes meaningful and captures what content can't
("people who save this climbing gym also go to that taco place"). Item-item beats user-user at this size
(items are fewer and stabler than users; neighbours are explainable: "Because you saved X").
*Inputs:* positive set per user = saves, rates ≥4, BT score ≥6, joins (events map to their `place_id`).
*Model:* `sim(i,j) = |U_i∩U_j| / sqrt(|U_i|·|U_j|)` with shrinkage `n/(n+10)`, keep top-50 neighbours with
≥3 co-users. Nightly service job writes `item_neighbors(place_id, neighbor_id, sim)`. Precomputed
neighbours are aggregate, not per person; enforce k-anonymity (≥3 co-users) so no single person's saves can be
inferred (section 8). Effort M. Not for events (they expire); events inherit via venue and host.

### Stage 3a: user-user taste match
*Why:* Beli's "people with your taste" story; useful once users overlap on ≥5 rated places per category.
Similarity = Pearson on BT scores over co-rated places, ≥5 overlap, per category. Used only as an
aggregate signal ("people with your taste rate this 8.4"), never naming or exposing those users unless they
are public raters and followed. Nightly job, `taste_neighbors` table service-only. Effort M.

### Stage 3b: two-stage retrieval + learned ranker
*Why:* with thousands of users and ≥50k impressions/week, the hand weights in `recommend_*` become features.
Retrieval (union, ~300 candidates): rules, taste profile, pgvector kNN, item-CF neighbours, exploration pool.
Ranker: gradient-boosted trees (LightGBM, LambdaMART objective) on logged impressions → save/join labels,
features = each retriever's score + context (section 5) + item stats. Trained offline weekly (external job
reading a service-role export), served as a small model in the Next.js server or as a coefficient table for
a linear approximation in SQL. Keep Claude rerank only as a reason writer. Effort L.

## 4. Events cold start
A new event has no attendees and no history. Score it from what *is* known at creation:

| Signal | Weight | Source |
|---|---|---|
| Host followed by viewer | +4 (existing) | `follows`, `events.creator_id` |
| Host's past events joined by viewer | +2 per (cap 4) | `event_attendees` ⋈ prior `events` |
| At a saved / highly-scored place | +4 saved, +0.4·BT score | `saved_places`, `user_place_scores` |
| Recurring series the viewer attended | +3 | needs `events.series_id` (new; today none) |
| Category taste | +3·cosine(taste, tags) | `user_taste` (stage 1) |
| Followed people going | +2, +0.5 each extra (cap 4) | `event_attendees` |
| Host quality | +0.5·`creator_reputation` | `profiles.reputation_level` |
| Starts soon | `1.5·exp(-Δt/3 d)`, ×0 after start+1 h | `starts_at` |
| Distance | `2·exp(-d/s_cat)` | section 5 |
| Nearly full | −1 when `capacity` − going ≤ 1 | `capacity` |

Series: add `events.series_id uuid` set when a host duplicates an event; a join on one occurrence counts for
the series. Until then, approximate series as same `creator_id` + same `place_id` + same weekday.

## 5. Context signals by category

| Category group | Distance scale `s_cat` | Time fit | Open now | Solo vs group |
|---|---|---|---|---|
| `coffee-study` | 1.5 km | weekday daytime ×1.2 | required (−∞ if closed) | solo boost |
| `food`, `date-spot` | 3 km | meal windows 11–14, 17–21 ×1.2 | required | group / date |
| `nightlife`, `music`, `sports-bar` | 5 km | Thu–Sat after 20:00 ×1.3; mornings ×0.5 | required | group |
| `pickup-sports`, `fitness` | 4 km | match to user's usual hour ±2 h | events only | solo OK (games need people) |
| `outdoors` | 25 km | weekend daytime ×1.3; after dark ×0.3 | n/a | either |
| `arts`, `community`, `gaming-hobby`, `college` | 5 km | evenings/weekends | events only | either |

Needs: viewer local time zone (from `profiles` or the request; drop the hard-coded `America/New_York`),
`places.hours jsonb` (new; until present, treat as unknown, not closed), and a solo/group toggle on the rail
stored only in the request (not persisted). Log the bucketed context on impressions so stage 3 can learn
these multipliers instead of hand-setting them.

## 6. Diversity and exploration
- **MMR** over the final list: pick next item maximizing `λ·score − (1−λ)·max_sim(item, picked)`, `λ=0.7`;
  `sim` = 1 for same category + 0.5·tag Jaccard (stage 2: embedding cosine). Plus hard caps: ≤3 per
  category and ≤2 per creator in 12. Runs in TypeScript after the SQL call (keeps SQL and demo parity simple).
  Replaces neither the `1.5/(1+save_count)` long-tail term nor the community bonus.
- **Exploration:** reserve slots 4 and 9 for ε-greedy picks from an "unproven" pool (community places <30 days
  old or with <5 impressions) that pass visibility and distance filters. Log `policy='explore'` and the
  selection probability so offline evaluation can correct for it (inverse propensity). Drop to one slot once
  stage 2 is live.

## 7. Evaluation
- **Offline:** time-split: for each user, hold out the last 20% of saves (places) and joins (events) by
  `created_at`; train on the rest; recompute candidates as of the split time. Metrics recall@12 and
  NDCG@12, per category and for users with <5 actions separately. Baseline = `rules-v1` replay. Script:
  `scripts/recs/eval.ts` reading a service-role export; runs on demo/staging data too.
- **Online:** per policy and surface, from `user_interactions` joined on `request_id`:
  save rate / impression, join rate / impression, hide rate / impression, click-through, and coverage
  (distinct items shown / eligible). Guardrail: hide rate must not rise. A/B assignment by
  `hash(user_id) % 100` with the bucket stamped in `policy`.
- **Logging this requires:** impression rows with `request_id`, `position`, `policy`, `score`, and
  exploration probability; actions attributed to the impression within 7 days (place) or before
  `starts_at` (event); server-time timestamps.

## 8. Privacy limits (consistent with existing RLS)
1. Per-viewer functions stay `SECURITY INVOKER` and only read what the viewer may read, as 0018 does. Every
   candidate, from any retriever, passes `can_view_place` / `can_view_event` before ranking. Locals-only,
   `trusted` and `followers` places never reach a non-qualifying viewer, even via pgvector or CF.
2. Other people's `saved_places` are private and never a per-person signal ("@x saved this" is forbidden).
   Public signals only: places someone added, ratings (public), events joined (visible attendees).
3. Aggregate models (item-CF, taste neighbours, the stage-3 ranker) may train on everyone's saves via
   service-role jobs only, with ≥3 co-users per pair, no per-user output exposed, and reasons phrased as
   "People who saved X also save this", never naming them.
4. Locals-only items are excluded from training co-occurrence unless both items share the same city and
   visibility tier, so a public recommendation cannot leak a locals-only place's existence.
5. `blocks` in either direction excludes that person's content and their signals.
6. Claude rerank keeps its current contract: viewer's own data plus candidates' public fields only.
7. Opt-out disables collection and personal models for that user; deletion cascades (section 2).

## 9. Next 3 tasks (one coding session each)

**Task 1: Close the 0031 gaps for evaluation** — done in `0033_interaction_attribution.sql` (0032 was taken by
the photo delete policy fix). Saves/rates/joins written by triggers no longer see DNT/GPC or the feature flag.
Files: new migration `0033_interaction_attribution.sql` (`request_id`, `policy`, `score`, impression dedupe
index, triggers on `saved_places` / `place_ratings` / `event_attendees`, `blocks` exclusion in re-created
`recommend_*`), `src/server/recommendations/index.ts` (mint `request_id`, set `policy`),
`src/components/recommendations/ForYouRail.tsx`, demo twins (`src/lib/data/demo/interactions.ts`, `recommend.ts`).
Accept: each rail render has one `request_id`; a duplicate impression for the same request is rejected;
saving through the normal UI writes exactly one `save` row server-side and a client-sent `save` is refused;
blocked users' content never appears; SQL/demo parity and owner-only RLS tests pass.

**Task 2: Offline evaluation harness + cold-start fallback** — done: `scripts/recs/eval.ts`,
`0034_cold_start_fallback.sql` (all published places, not only community ones, since the seed has none),
online query in `docs/recommendations-metrics.md`.
Files: `scripts/recs/eval.ts`, `tests/recs-eval.test.ts`, `recommend_places` fallback branch + demo twin.
Accept: on the demo dataset `eval.ts` prints recall@12 / NDCG@12 for `rules-v1` from a time split; a brand-new
user with only `home_city` gets ≥6 places labelled "Popular with locals"; metrics query for save/hide rate
per impression documented in `docs/`.

**Task 3: Per-category taste profiles (stage 1a) + MMR**
Files: migration `0033_user_taste.sql` (`user_taste`, `refresh_user_taste()`, pg_cron), updated
`recommend_places` term, demo twin, `src/server/recommendations/diversify.ts`.
Accept: rating a 1–2 star bar lowers similar bars' scores; no category exceeds 3 of 12; `rules-v2` beats
`rules-v1` (or ties) on Task 2's harness; parity and RLS tests pass.

## 10. Open questions for the owner
1. Ship Beli-style comparisons as a new rating UX, or keep 1–5 stars and only use comparisons on the profile list?
2. One launch city? Stage gates assume per-city density; several thin cities delay stage 2 a lot.
3. Personalization opt-out: the 0031 draft reuses `analytics_opt_out`. Keep that, or split it (recommended: separate toggle, so declining analytics does not silently turn off personal recs)?
4. May aggregate jobs train on private saves at all (section 8.3), or only on public ratings and joins?
5. Embedding provider and budget for stage 2a (per-item cost is small; data leaves the database).
6. Should "popular" ever appear for cold users, given the thesis favours community and lesser-known places?
7. Add opening hours to `places` (needed for "open now"), and who maintains them?
8. Add `events.series_id` for recurring events?
