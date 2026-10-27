# Recommendation metrics

How to tell whether "For you" is working, offline before a change ships and online after it.
Plan context: [recommendations-plan-claude.md](recommendations-plan-claude.md) §7.

## Offline: `scripts/recs/eval.ts`

```bash
npx tsx scripts/recs/eval.ts                 # the demo dataset
npx tsx scripts/recs/eval.ts --state data/demo-store.json --k 12 --json
```

For each person it holds out the last 20% of their saves (places) and joins (events, not counting
events they host), removes everything they did from the first held-out moment on, replays the
recommender as of that moment over only the places and events that existed then, and checks whether
the held-out items were in the top k. It prints recall@k and NDCG@k averaged over people, recall per
category, and the same for people with fewer than five earlier actions.

- Two policies run through the same split: `rules-v1`, the rules alone, and `rules-v2`, what the app
  serves (the rules plus the viewer's taste from `0035_user_taste.sql`, then at most 3 per category).
  Both use the demo twins, which the parity tests keep identical to the SQL. `--policy` picks one.
  `evaluate(state, { diversity })` tries other diversity settings.
- Other people's later activity is not rewound, so a little future popularity leaks into the replay.
  It affects every policy equally.
- Demo dataset (k = 12, 2026-10-26): `rules-v1` places recall 42.9%, NDCG 0.174 over 7 people;
  `rules-v2` 42.9%, NDCG 0.178. Events recall 100% for both (NDCG 0.463). With the plan's full
  diversity (MMR λ = 0.7, at most 2 per creator) places drop to 2 of 7 hits, which is why those are
  built but off (`src/server/recommendations/diversify.ts`). The event number is saturated: the seed has fewer upcoming
  events than slots, so it says nothing yet. No seed person has fewer than five earlier actions.
- Staging and production need a service-role export in the demo-store shape; that exporter does not
  exist yet.

## Online: from `user_interactions`

Every rendering of a "For you" rail has a `request_id` and a `policy` (`rules-v1` and `rules-v1+rerank`
before 0035, `rules-v2` and `rules-v2+rerank` since);
each card's impression carries both, its zero-based `position` and its `score`
(`0033_interaction_attribution.sql`). Saves, ratings, joins and hides are rows of their own, written
when they happen. An action is credited to the most recent For you impression of the same item by the
same person before it: within 7 days for places, before the event starts for events.

Run as the service role (the table has no admin read through the API). Rows of people who opted out
of analytics are not there at all, apart from their hides.

```sql
-- Click, save, join and hide rate per impression, by policy, over the last 28 days.
with imp as (
  select i.id, i.user_id, i.item_type, i.item_id, i.request_id, i.policy, i.position, i.created_at
  from public.user_interactions i
  where i.action = 'impression' and i.surface = 'for_you' and i.request_id is not null
    and i.created_at >= now() - interval '28 days'
),
act as (
  select a.user_id, a.item_type, a.item_id, a.action, a.created_at
  from public.user_interactions a
  where a.action in ('save', 'join', 'hide', 'view')
    and a.created_at >= now() - interval '28 days'
),
credited as (
  -- Each action goes to the latest qualifying impression before it.
  select distinct on (a.user_id, a.item_type, a.item_id, a.action, a.created_at)
         imp.id as impression_id, a.action
  from act a
  join imp on imp.user_id = a.user_id and imp.item_type = a.item_type and imp.item_id = a.item_id
          and imp.created_at <= a.created_at
  left join public.events e on a.item_type = 'event' and e.id = a.item_id
  where (a.item_type = 'place' and a.created_at < imp.created_at + interval '7 days')
     or (a.item_type = 'event' and a.created_at < e.starts_at)
  order by a.user_id, a.item_type, a.item_id, a.action, a.created_at, imp.created_at desc
),
outcomes as (
  -- One row per impression, so an impression that was viewed and then saved counts once.
  select impression_id,
         bool_or(action = 'view') as viewed, bool_or(action = 'save') as saved,
         bool_or(action = 'join') as joined, bool_or(action = 'hide') as hidden
  from credited
  group by impression_id
)
select imp.policy,
       imp.item_type,
       count(*)                                                                  as impressions,
       count(distinct imp.request_id)                                            as renders,
       count(distinct imp.item_id)                                               as distinct_items,
       round(count(*) filter (where o.viewed)::numeric / count(*), 4)            as click_rate,
       round(count(*) filter (where o.saved)::numeric / count(*), 4)             as save_rate,
       round(count(*) filter (where o.joined)::numeric / count(*), 4)            as join_rate,
       round(count(*) filter (where o.hidden)::numeric / count(*), 4)            as hide_rate
from imp
left join outcomes o on o.impression_id = imp.id
group by imp.policy, imp.item_type
order by imp.item_type, imp.policy;
```

Reading it:

- **Guardrail:** a new policy must not raise `hide_rate`.
- `click_rate` counts detail views; `save_rate` (places) and `join_rate` (events) are the outcomes.
- An impression with several outcomes (viewed, then saved) counts once in each rate.
- **Coverage** is `distinct_items` over the published, visible items in the city; a policy that shows
  the same dozen places to everyone has low coverage even if its rates look fine.
- By position: add `imp.position` to the `select` and `group by` to see how much rank matters.
- Cold start: the reason is not logged, so to split out "Popular with locals" cards, compare people
  with fewer than five saves, ratings and joins before the impression against everyone else.

Per-person A/B buckets (`hash(user_id) % 100`, stamped into `policy`) are not built yet; until then
compare policies over different date ranges, not side by side.
