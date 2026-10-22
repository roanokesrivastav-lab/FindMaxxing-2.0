-- ============================================================================
-- FindMaxxing — a private, per-user interaction log for personalization.
--
-- What a future recommender (item-item CF, embeddings, a learned ranker) will
-- train on: which items a person was shown (impressions, with the surface and
-- the position in the list), opened, saved, rated, joined, left or hid.
--
-- This is deliberately not analytics_events (0015), which stays pseudonymous
-- and keeps no raw user id. This log is personal data, so:
--   * a person can insert, read and delete only their own rows; nobody else
--     (not even admins) can read them through the API. There is no update.
--   * rows are only accepted for items the person can see right now (the
--     places / events policies decide), so ids cannot be invented.
--   * the analytics opt-out stops it too: only "hide" (Not interested) is
--     still recorded, because it is an explicit choice the person can see.
--   * suspended and closing accounts cannot write (block_suspended_writes),
--     and inserts are rate-limited per statement, so a batch of impressions
--     costs one tick.
--   * deleting the account deletes every row (profiles FK cascade); deleting
--     a place or an event deletes everyone's rows about it.
--   * impressions and views are kept 365 days (purge_user_interactions, for
--     the service role); the actions themselves stay until deleted.
--   * training reads go through a service-role-only aggregate.
--
-- "Not interested" is a hide row: recommend_places / recommend_events below
-- leave hidden items out. Undo deletes the hide rows. The demo twin is
-- src/lib/data/demo/interactions.ts and src/lib/data/demo/recommend.ts.
-- ============================================================================

create table public.user_interactions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  item_type   text not null check (item_type in ('place', 'event')),
  item_id     uuid not null,
  action      text not null check (action in (
                'impression', 'view', 'save', 'unsave', 'rate', 'directions',
                'share', 'join', 'leave', 'hide')),
  surface     text check (surface in ('for_you', 'list', 'map', 'search', 'detail', 'saved', 'profile')),
  -- Zero-based position in the list the item was shown in.
  position    integer check (position between 0 and 999),
  -- The score, for 'rate' only.
  value       smallint check (value between 1 and 5),
  created_at  timestamptz not null default now(),
  check ((action = 'rate') = (value is not null)),
  check (action not in ('save', 'unsave', 'rate') or item_type = 'place'),
  check (action not in ('join', 'leave') or item_type = 'event')
);
create index user_interactions_user_time_idx on public.user_interactions (user_id, created_at);
create index user_interactions_item_idx on public.user_interactions (item_type, item_id);
create index user_interactions_hidden_idx on public.user_interactions (user_id, item_type, item_id) where action = 'hide';

alter table public.user_interactions enable row level security;

create policy "own interactions are readable" on public.user_interactions for select
  using (user_id = auth.uid());
create policy "own interactions are deletable" on public.user_interactions for delete
  using (user_id = auth.uid());
-- The item must be visible to the writer (this subquery runs under their RLS),
-- and an opted-out person records nothing but an explicit hide.
create policy "own interactions on visible items" on public.user_interactions for insert
  with check (
    user_id = auth.uid()
    and (action = 'hide' or not exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.analytics_opt_out))
    and case item_type
          when 'place' then exists (select 1 from public.places p where p.id = item_id)
          when 'event' then exists (select 1 from public.events e where e.id = item_id)
        end
  );

revoke all on public.user_interactions from public, anon, authenticated;
grant select, delete on public.user_interactions to authenticated;
-- The server's clock decides created_at.
grant insert (user_id, item_type, item_id, action, surface, position, value) on public.user_interactions to authenticated;
grant select, insert, delete on public.user_interactions to service_role;

create trigger user_interactions_block_suspended
  before insert on public.user_interactions
  for each row execute function public.block_suspended_writes();

insert into public.rate_limit_rules (action, max_count, window_seconds, label)
values ('interactions', 600, 3600, 'interaction batches');

-- One rate-limit tick per insert statement (a batch), and at most 100 rows each.
create or replace function public.limit_interaction_batches()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return null;
  end if;
  if (select count(*) from inserted) > 100 then
    raise exception 'Too many interactions in one batch' using errcode = 'P0001';
  end if;
  perform public.check_rate_limit('interactions');
  return null;
end $$;
create trigger user_interactions_limit_batches
  after insert on public.user_interactions
  referencing new table as inserted
  for each statement execute function public.limit_interaction_batches();

-- Deleting an item deletes everyone's history of it (including cascades from
-- an account deletion that takes the owner's places and events).
create or replace function public.forget_item_interactions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.user_interactions
   where item_type = case tg_table_name when 'places' then 'place' else 'event' end
     and item_id = old.id;
  return old;
end $$;
create trigger places_forget_interactions after delete on public.places
  for each row execute function public.forget_item_interactions();
create trigger events_forget_interactions after delete on public.events
  for each row execute function public.forget_item_interactions();

-- Retention for the bulky passive rows; returns how many were deleted.
create or replace function public.purge_user_interactions(p_keep_days integer default 365)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.user_interactions
   where action in ('impression', 'view') and created_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_user_interactions(integer) from public, anon, authenticated;
grant execute on function public.purge_user_interactions(integer) to service_role;

-- For training later: per-item totals and distinct people since a time.
-- Service role only; it never returns who did what.
create or replace function public.interaction_item_stats(p_since timestamptz default now() - interval '90 days')
returns table (
  item_type text, item_id uuid, people integer, impressions integer, views integer,
  saves integer, rates integer, joins integer, hides integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select i.item_type, i.item_id,
         count(distinct i.user_id)::integer,
         count(*) filter (where i.action = 'impression')::integer,
         count(*) filter (where i.action = 'view')::integer,
         count(*) filter (where i.action = 'save')::integer,
         count(*) filter (where i.action = 'rate')::integer,
         count(*) filter (where i.action = 'join')::integer,
         count(*) filter (where i.action = 'hide')::integer
  from public.user_interactions i
  where i.created_at >= p_since
  group by i.item_type, i.item_id
  order by i.item_type, i.item_id;
$$;
revoke all on function public.interaction_item_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.interaction_item_stats(timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- "For you" without what the viewer marked Not interested. Otherwise exactly
-- 0018_recommendations.sql (see its header for the scoring).
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
      and not exists (select 1 from my_hidden h where h.item_type = 'place' and h.item_id = p.id)
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
      and not exists (select 1 from my_hidden h where h.item_type = 'event' and h.item_id = e.id)
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

