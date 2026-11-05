-- ============================================================================
-- FindMaxxing — attribution for the interaction log (0031), so the
-- recommender can be evaluated (docs/recommendations-plan-claude.md §2, §7).
--
--   * request_id ties every card in one rendered rail to that rendering;
--     policy names what produced it (rules-v1, rules-v1+rerank, ...), score
--     is what that policy gave it and propensity is the chance an
--     exploration slot had of showing it. One impression per request and
--     item: a repeat is dropped, not stored twice.
--   * save, unsave, rate, join and leave are written by the database itself
--     when the person saves, rates or joins, so they cannot be missed (a
--     crashed client) or made up (no real save). Clients can no longer insert
--     them. Only the person's own action is recorded (not a seed, a service
--     job or a cascade), the analytics opt-out still applies, and these rows
--     cost no rate-limit tick.
--   * "For you" leaves out anyone blocked either way: places and events they
--     made, and their saves, ratings, hosting and attendance as reasons.
--
-- The demo twins are src/lib/data/demo/interactions.ts and recommend.ts.
-- ============================================================================

alter table public.user_interactions
  add column request_id uuid,
  add column policy     text check (policy ~ '^[a-z0-9][a-z0-9.+_-]{0,39}$'),
  add column score      real,
  add column propensity real check (propensity > 0 and propensity <= 1);

create unique index user_interactions_impression_once_idx
  on public.user_interactions (user_id, request_id, item_type, item_id)
  where action = 'impression' and request_id is not null;

grant insert (request_id, policy, score, propensity) on public.user_interactions to authenticated;

-- Clients write only what the database cannot see happen.
drop policy "own interactions on visible items" on public.user_interactions;
create policy "own interactions on visible items" on public.user_interactions for insert
  with check (
    user_id = auth.uid()
    and action in ('impression', 'view', 'directions', 'share', 'hide')
    and (action = 'hide' or not exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.analytics_opt_out))
    and case item_type
          when 'place' then exists (select 1 from public.places p where p.id = item_id)
          when 'event' then exists (select 1 from public.events e where e.id = item_id)
        end
  );

-- A repeated impression for the same request is dropped (the unique index
-- still settles a race between two batches).
create or replace function public.skip_repeat_impressions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.action = 'impression' and new.request_id is not null and exists (
    select 1 from public.user_interactions i
    where i.user_id = new.user_id and i.request_id = new.request_id and i.action = 'impression'
      and i.item_type = new.item_type and i.item_id = new.item_id
  ) then
    return null;
  end if;
  return new;
end $$;
create trigger user_interactions_skip_repeats
  before insert on public.user_interactions
  for each row execute function public.skip_repeat_impressions();

-- Rows the triggers below write cost the person no rate-limit tick: the save,
-- rating or attendance was already limited (or not) on its own table.
create or replace function public.limit_interaction_batches()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return null;
  end if;
  if (select count(*) from inserted) > 100 then
    raise exception 'Too many interactions in one batch' using errcode = 'P0001';
  end if;
  perform public.check_rate_limit('interactions');
  return null;
end $$;

-- save / unsave / rate / join / leave, from the tables that hold them.
create or replace function public.record_own_interaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- One function for three tables: read the row as json.
  r jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  who uuid := (r ->> 'user_id')::uuid;
  kind text := case tg_table_name when 'event_attendees' then 'event' else 'place' end;
  item uuid := (r ->> case tg_table_name when 'event_attendees' then 'event_id' else 'place_id' end)::uuid;
  what text := case
    when tg_table_name = 'place_ratings' then 'rate'
    when tg_table_name = 'event_attendees' then case tg_op when 'DELETE' then 'leave' else 'join' end
    when tg_op = 'DELETE' then 'unsave' else 'save' end;
begin
  -- The person's own action on an item that still exists (cascades from a
  -- deleted account or item have neither), unless they opted out.
  if auth.uid() is distinct from who
     or not exists (select 1 from public.profiles pr where pr.id = who and not pr.analytics_opt_out)
     or (kind = 'place' and not exists (select 1 from public.places p where p.id = item))
     or (kind = 'event' and not exists (select 1 from public.events e where e.id = item)) then
    return null;
  end if;
  insert into public.user_interactions (user_id, item_type, item_id, action, surface, value)
  values (who, kind, item, what, null, case when what = 'rate' then (r ->> 'score')::smallint end);
  return null;
end $$;
revoke all on function public.record_own_interaction() from public, anon, authenticated;

create trigger saved_places_record_interaction
  after insert or delete on public.saved_places
  for each row execute function public.record_own_interaction();
create trigger place_ratings_record_interaction
  after insert or update of score on public.place_ratings
  for each row execute function public.record_own_interaction();
create trigger event_attendees_record_interaction
  after insert or delete on public.event_attendees
  for each row execute function public.record_own_interaction();

-- ----------------------------------------------------------------------------
-- "For you" without anyone blocked either way. Otherwise exactly 0031.
-- ----------------------------------------------------------------------------
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
  my_hidden as (select h.item_type, h.item_id from public.user_interactions h, me where h.user_id = me.id and h.action = 'hide'),
  following as (
    select f.following_id as id, pr.username from public.follows f join public.profiles pr on pr.id = f.following_id, me
    where f.follower_id = me.id and not public.is_blocked_between(me.id, f.following_id)
  ),
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
      and not exists (select 1 from my_hidden h where h.item_type = 'event' and h.item_id = e.id)
      and (e.creator_id is null or not public.is_blocked_between(me.id, e.creator_id))
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

