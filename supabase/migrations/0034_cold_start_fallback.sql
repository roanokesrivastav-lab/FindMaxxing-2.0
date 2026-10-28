-- ============================================================================
-- FindMaxxing — a cold-start fallback for "For you" places
-- (docs/recommendations-plan-claude.md, stage 0).
--
-- Someone who has just signed up has no follows, saves, ratings or events,
-- and maybe no interests, so recommend_places returned nothing. Now places
-- without a reason of their own, in the viewer's home city, are filled in by
-- popularity: save_count decayed by the place's age (in whole days, so SQL
-- and the demo twin agree), explained as "Popular with locals". They score
-- below every place that has a reason, so they never push one out. Places
-- nobody has saved are not "popular" and stay out. Otherwise exactly 0033.
--
-- The demo twin is src/lib/data/demo/recommend.ts.
-- ============================================================================

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
