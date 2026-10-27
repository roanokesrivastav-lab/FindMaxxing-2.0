-- ============================================================================
-- FindMaxxing — per-category taste for "For you" places, rules-v2
-- (docs/recommendations-plan-claude.md, stage 1a).
--
-- user_taste is the viewer's own tag-weight vector, overall and per category:
--   save +1; rating 5 +2, 4 +1, 3 0, 2 -1, 1 -2; joining an event +1 (not
--   one's own); Not interested -2; a card seen three or more times and never
--   opened, saved, rated or joined -0.1; each decayed by its age in whole
--   days, exp(-days / 90); plus +1 per tag for every chosen interest.
-- A category gets its own vector once it has three actions with a nonzero
-- weight; until then the overall vector speaks for it.
--
-- recommend_places adds 3 x cosine(taste, the place's tags), so a 1-2 star
-- rating of a bar lowers the score of bars with the same tags, and a 5 raises
-- them. The flat signals and their explanations stay. Category and creator
-- diversity is applied after this, in TypeScript
-- (src/server/recommendations/diversify.ts).
--
-- user_taste is a view, computed when asked, not a table rebuilt by a job:
-- at beta size it costs a few milliseconds, a rating counts at once, and
-- there is nothing to keep in sync. It runs as the caller (security_invoker)
-- and only for auth.uid(), so nobody can read anyone else's taste.
-- Materialize it when the cost shows up in the discovery timings.
--
-- The demo twin is src/lib/data/demo/recommend.ts (demoTaste).
-- ============================================================================

create view public.user_taste with (security_invoker = true) as
with me as (select auth.uid() as id),
acts as (
  select 'place'::text as item_type, s.place_id as item_id, p.category_slug, 1.0::float8 as weight, s.created_at as at
  from public.saved_places s join public.places p on p.id = s.place_id, me
  where s.user_id = me.id
  union all
  select 'place', r.place_id, p.category_slug,
         case r.score when 5 then 2.0 when 4 then 1.0 when 3 then 0.0 when 2 then -1.0 else -2.0 end, r.updated_at
  from public.place_ratings r join public.places p on p.id = r.place_id, me
  where r.user_id = me.id
  union all
  select 'event', a.event_id, e.category_slug, 1.0, a.created_at
  from public.event_attendees a join public.events e on e.id = a.event_id, me
  where a.user_id = me.id and e.creator_id is distinct from me.id
  union all
  select h.item_type, h.item_id, coalesce(p.category_slug, e.category_slug), -2.0, h.created_at
  from public.user_interactions h
  left join public.places p on h.item_type = 'place' and p.id = h.item_id
  left join public.events e on h.item_type = 'event' and e.id = h.item_id, me
  where h.user_id = me.id and h.action = 'hide' and (p.id is not null or e.id is not null)
  union all
  select i.item_type, i.item_id, min(coalesce(p.category_slug, e.category_slug)), -0.1, max(i.created_at)
  from public.user_interactions i
  left join public.places p on i.item_type = 'place' and p.id = i.item_id
  left join public.events e on i.item_type = 'event' and e.id = i.item_id, me
  where i.user_id = me.id and i.action = 'impression' and (p.id is not null or e.id is not null)
    and not exists (
      select 1 from public.user_interactions o
      where o.user_id = me.id and o.item_type = i.item_type and o.item_id = i.item_id
        and o.action in ('view', 'save', 'rate', 'join', 'hide'))
    and not exists (select 1 from public.saved_places s where s.user_id = me.id and i.item_type = 'place' and s.place_id = i.item_id)
    and not exists (select 1 from public.place_ratings r where r.user_id = me.id and i.item_type = 'place' and r.place_id = i.item_id)
    and not exists (select 1 from public.event_attendees a where a.user_id = me.id and i.item_type = 'event' and a.event_id = i.item_id)
  group by i.item_type, i.item_id
  having count(*) >= 3
),
tagged as (
  select a.category_slug, t.interest_slug,
         a.weight * exp(-floor(extract(epoch from (now() - a.at)) / 86400.0) / 90.0) as w
  from acts a
  join (
    select 'place'::text as item_type, place_id as item_id, interest_slug from public.place_tags
    union all
    select 'event', event_id, interest_slug from public.event_tags
  ) t on t.item_type = a.item_type and t.item_id = a.item_id
),
prior as (select pi.interest_slug from public.profile_interests pi, me where pi.profile_id = me.id),
own_categories as (
  select category_slug from acts where weight <> 0 group by category_slug having count(*) >= 3
),
scoped as (
  select null::text as category_slug, interest_slug, w from tagged
  union all
  select null, interest_slug, 1.0 from prior
  union all
  select t.category_slug, t.interest_slug, t.w from tagged t join own_categories c on c.category_slug = t.category_slug
  union all
  select c.category_slug, p.interest_slug, 1.0 from own_categories c cross join prior p
)
select category_slug, interest_slug, sum(w) as weight
from scoped
group by category_slug, interest_slug;

comment on view public.user_taste is
  'The signed-in viewer''s tag weights: overall (category_slug null) and per category with 3+ actions.';
revoke all on public.user_taste from public, anon, authenticated;
grant select on public.user_taste to authenticated;

create or replace function public.recommend_places(
  p_lat double precision default null,
  p_lng double precision default null,
  p_limit integer default 12
) returns table (place_id uuid, score numeric, reason_kind text, reason_text text, reason_ref text)
language sql
stable
security invoker
set search_path = public
as $$
  with me as (select auth.uid() as id),
  my_city as (select pr.home_city from public.profiles pr, me where pr.id = me.id),
  my_interests as (select pi.interest_slug from public.profile_interests pi, me where pi.profile_id = me.id),
  my_saved as (select sp.place_id, sp.created_at from public.saved_places sp, me where sp.user_id = me.id),
  my_rated as (select r.place_id, r.score, r.updated_at from public.place_ratings r, me where r.user_id = me.id),
  my_hidden as (select h.item_type, h.item_id from public.user_interactions h, me where h.user_id = me.id and h.action = 'hide'),
  liked as (
    select place_id, created_at as at, 'saved' as how from my_saved
    union all
    select place_id, updated_at, 'rated' from my_rated where score >= 4
  ),
  liked_tags as (
    select t.interest_slug, l.place_id, l.how, l.at, p.name
    from liked l join public.place_tags t on t.place_id = l.place_id join public.places p on p.id = l.place_id
  ),
  following as (
    select f.following_id as id, pr.username from public.follows f join public.profiles pr on pr.id = f.following_id, me
    where f.follower_id = me.id and not public.is_blocked_between(me.id, f.following_id)
  ),
  event_categories as (
    select distinct e.category_slug from public.event_attendees a join public.events e on e.id = a.event_id, me
    where a.user_id = me.id
  ),
  taste as (select t.category_slug, t.interest_slug, t.weight from public.user_taste t),
  candidates as (
    select p.* from public.places p, me
    where p.status = 'published'
      and p.creator_id is distinct from me.id
      and not exists (select 1 from my_saved s where s.place_id = p.id)
      and not exists (select 1 from my_rated r where r.place_id = p.id)
      and not exists (select 1 from my_hidden h where h.item_type = 'place' and h.item_id = p.id)
      and (p.creator_id is null or not public.is_blocked_between(me.id, p.creator_id))
  ),
  signals as (
    -- Added by someone you follow.
    select c.id, 4.0::numeric as w, 'followed_added' as kind, 'Added by @' || f.username || ', who you follow' as txt, f.username as ref
    from candidates c join following f on f.id = c.creator_id
    union all
    -- Rated highly by someone you follow (the best-known rater).
    select c.id, 3.0, 'followed_rated', 'Rated highly by @' || min(f.username collate "C"), min(f.username collate "C")
    from candidates c join public.place_ratings r on r.place_id = c.id and r.score >= 4 join following f on f.id = r.user_id
    group by c.id
    union all
    -- Shares a tag with a place you saved or rated highly (the most recent one).
    (select distinct on (c.id) c.id, 3.0,
           'liked_similar',
           case when lt.how = 'saved' then 'Because you saved ' else 'Because you rated ' end || lt.name || case when lt.how = 'rated' then ' highly' else '' end,
           lt.place_id::text
    from candidates c join public.place_tags t on t.place_id = c.id join liked_tags lt on lt.interest_slug = t.interest_slug
    order by c.id, lt.at desc, lt.place_id)
    union all
    -- Your interests: 2 per matching tag, explained by the first in taxonomy order.
    select c.id, 2.0 * count(*), 'interest',
           'Matches your interest in ' || (array_agg(i.label order by i.sort_order, i.slug collate "C"))[1],
           (array_agg(i.slug order by i.sort_order, i.slug collate "C"))[1]
    from candidates c join public.place_tags t on t.place_id = c.id
    join my_interests mi on mi.interest_slug = t.interest_slug join public.interests i on i.slug = t.interest_slug
    group by c.id
    union all
    select c.id, 1.0, 'event_category', 'Like the events you join', c.category_slug
    from candidates c join event_categories ec on ec.category_slug = c.category_slug
  ),
  -- How well a place's tags fit the viewer's taste: cosine between the taste
  -- vector (its category's when that has three or more actions, otherwise
  -- the overall one) and the place's tags. -1 to 1; 0 without tags or taste.
  fit as (
    select c.id,
           coalesce(sum(v.weight) / nullif(
             sqrt((select sum(w.weight * w.weight) from taste w where w.category_slug is not distinct from s.scope))
             * sqrt(count(*)), 0), 0) as cos
    from candidates c
    cross join lateral (
      select case when exists (select 1 from taste x where x.category_slug = c.category_slug) then c.category_slug end as scope
    ) s
    join public.place_tags t on t.place_id = c.id
    left join taste v on v.interest_slug = t.interest_slug and v.category_slug is not distinct from s.scope
    group by c.id, s.scope
  ),
  nearby as (
    select c.id, 2.0 * exp(-public.distance_m(c.lat, c.lng, p_lat, p_lng) / 3000.0) as w
    from candidates c where p_lat is not null and p_lng is not null
  ),
  scored as (
    select c.id,
           round((
             coalesce((select sum(s.w) from signals s where s.id = c.id), 0)
             + coalesce((select n.w from nearby n where n.id = c.id), 0)
             + case when c.source = 'community' then 1.5 else 0 end
             + 1.5 / (1 + c.save_count)
             + 3.0 * coalesce((select f.cos from fit f where f.id = c.id), 0)
           )::numeric, 3) as score,
           (select s.kind from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as kind,
           (select s.txt from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as txt,
           (select s.ref from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as ref
    from candidates c
    where exists (select 1 from signals s where s.id = c.id)
  ),
  -- Nothing to go on yet: what people save most in the viewer's home city,
  -- newer places counting more (half-life about four months). Below 0.9,
  -- while anything with a reason scores over 1, so it only fills in behind.
  popular as (
    select c.id,
           round((0.9 * (1 - exp(-(c.save_count * exp(-floor(extract(epoch from (now() - c.created_at)) / 86400.0) / 180.0)) / 3.0)))::numeric, 3) as score,
           'popular_local'::text as kind, 'Popular with locals'::text as txt, c.city as ref
    from candidates c join my_city m on m.home_city = c.city
    where c.save_count > 0
      and not exists (select 1 from signals s where s.id = c.id)
  )
  select s.id, s.score, s.kind, s.txt, s.ref
  from (select * from scored union all select * from popular) s
  order by s.score desc, s.id
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;
