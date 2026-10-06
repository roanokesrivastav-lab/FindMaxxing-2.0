-- ============================================================================
-- FindMaxxing — "For you": rule-based recommendations.
--
-- Invoker rights: every row goes through the places / events policies, so a
-- recommendation can never surface something the viewer is not allowed to see.
-- The functions read only what RLS already lets the viewer read: their own
-- interests, saves, ratings and joined events, and public signals from the
-- people they follow (places those people added or rated, events they host or
-- joined). Other people's saves stay private, so they are never a signal.
--
-- Each candidate gets a score from these signals, and the strongest one
-- becomes its explanation:
--   places  +4 added by someone you follow       "Added by @x, who you follow"
--           +3 rated 4+ by someone you follow    "Rated highly by @x"
--           +3 shares a tag with a place you saved / rated 4+  "Because you saved X"
--           +2 per tag matching your interests   "Matches your interest in Hiking"
--           +1 same category as events you join  "Like the events you join"
--           +0..2 nearby (decays over ~3 km)     "Close to you"
--   events  +4 at a place you saved              "At X, which you saved"
--           +4 hosted by someone you follow      "Hosted by @x, who you follow"
--           +2 someone you follow is going       "@x is going"
--           +2 per tag matching your interests
--           +1 on the weekday you usually go out (Columbus time)
--           +0..1.5 soon (decays over ~3 days), +0..2 nearby
-- Diversity, so the rail is not the most-saved list again:
--   places  +1.5 if a person added it (not seed data), and
--           +1.5 / (1 + saves): lesser-known places get the most lift
--   events  +0.5 for small events (under five going)
-- Candidates need at least one personal signal; the viewer's own places and
-- events, and what they already saved, rated or joined, are left out. Scores
-- are rounded to 1/1000 so the demo store (src/lib/data/demo/recommend.ts)
-- orders them the same way; ties go to the id.
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
  my_interests as (select pi.interest_slug from public.profile_interests pi, me where pi.profile_id = me.id),
  my_saved as (select sp.place_id, sp.created_at from public.saved_places sp, me where sp.user_id = me.id),
  my_rated as (select r.place_id, r.score, r.updated_at from public.place_ratings r, me where r.user_id = me.id),
  liked as (
    select place_id, created_at as at, 'saved' as how from my_saved
    union all
    select place_id, updated_at, 'rated' from my_rated where score >= 4
  ),
  liked_tags as (
    select t.interest_slug, l.place_id, l.how, l.at, p.name
    from liked l join public.place_tags t on t.place_id = l.place_id join public.places p on p.id = l.place_id
  ),
  following as (select f.following_id as id, pr.username from public.follows f join public.profiles pr on pr.id = f.following_id, me where f.follower_id = me.id),
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
  )
  select s.id, s.score, s.kind, s.txt, s.ref
  from scored s
  order by s.score desc, s.id
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;

create or replace function public.recommend_events(
  p_lat double precision default null,
  p_lng double precision default null,
  p_limit integer default 12,
  p_now timestamptz default now()
) returns table (event_id uuid, score numeric, reason_kind text, reason_text text, reason_ref text)
language sql
stable
security invoker
set search_path = public
as $$
  with me as (select auth.uid() as id),
  my_interests as (select pi.interest_slug from public.profile_interests pi, me where pi.profile_id = me.id),
  my_saved as (select sp.place_id from public.saved_places sp, me where sp.user_id = me.id),
  following as (select f.following_id as id, pr.username from public.follows f join public.profiles pr on pr.id = f.following_id, me where f.follower_id = me.id),
  -- The weekday (Columbus time) of most of the events you joined, if any.
  usual_day as (
    select extract(dow from e.starts_at at time zone 'America/New_York')::int as dow
    from public.event_attendees a join public.events e on e.id = a.event_id, me
    where a.user_id = me.id and e.creator_id is distinct from me.id
    group by 1 order by count(*) desc, 1 limit 1
  ),
  candidates as (
    select e.* from public.events e, me
    where e.status = 'published'
      and coalesce(e.ends_at, e.starts_at) >= p_now - interval '1 hour'
      and e.creator_id is distinct from me.id
      and not exists (select 1 from public.event_attendees a where a.event_id = e.id and a.user_id = me.id)
  ),
  signals as (
    select c.id, 4.0::numeric as w, 'saved_place' as kind, 'At ' || p.name || ', which you saved' as txt, p.id::text as ref
    from candidates c join my_saved s on s.place_id = c.place_id join public.places p on p.id = c.place_id
    union all
    select c.id, 4.0, 'followed_host', 'Hosted by @' || f.username || ', who you follow', f.username
    from candidates c join following f on f.id = c.creator_id
    union all
    select c.id, 2.0, 'followed_going', '@' || min(f.username collate "C") || ' is going', min(f.username collate "C")
    from candidates c join public.event_attendees a on a.event_id = c.id join following f on f.id = a.user_id
    where a.user_id is distinct from c.creator_id
    group by c.id
    union all
    select c.id, 2.0 * count(*), 'interest',
           'Matches your interest in ' || (array_agg(i.label order by i.sort_order, i.slug collate "C"))[1],
           (array_agg(i.slug order by i.sort_order, i.slug collate "C"))[1]
    from candidates c join public.event_tags t on t.event_id = c.id
    join my_interests mi on mi.interest_slug = t.interest_slug join public.interests i on i.slug = t.interest_slug
    group by c.id
    union all
    select c.id, 1.0, 'usual_day', 'On ' || to_char(c.starts_at at time zone 'America/New_York', 'FMDay') || ', when you usually go', null
    from candidates c join usual_day u on u.dow = extract(dow from c.starts_at at time zone 'America/New_York')::int
  ),
  scored as (
    select c.id,
           round((
             coalesce((select sum(s.w) from signals s where s.id = c.id), 0)
             + 1.5 * exp(-greatest(extract(epoch from (c.starts_at - p_now)), 0) / 259200.0)
             + case when p_lat is null or p_lng is null then 0 else 2.0 * exp(-public.distance_m(c.lat, c.lng, p_lat, p_lng) / 3000.0) end
             + case when (select count(*) from public.event_attendees a where a.event_id = c.id) < 5 then 0.5 else 0 end
           )::numeric, 3) as score,
           (select s.kind from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as kind,
           (select s.txt from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as txt,
           (select s.ref from signals s where s.id = c.id order by s.w desc, s.kind collate "C" limit 1) as ref
    from candidates c
    where exists (select 1 from signals s where s.id = c.id)
  )
  select s.id, s.score, s.kind, s.txt, s.ref
  from scored s
  order by s.score desc, s.id
  limit least(greatest(coalesce(p_limit, 12), 1), 50);
$$;

revoke all on function public.recommend_places(double precision, double precision, integer) from public, anon;
revoke all on function public.recommend_events(double precision, double precision, integer, timestamptz) from public, anon;
grant execute on function public.recommend_places(double precision, double precision, integer) to authenticated;
grant execute on function public.recommend_events(double precision, double precision, integer, timestamptz) to authenticated;
