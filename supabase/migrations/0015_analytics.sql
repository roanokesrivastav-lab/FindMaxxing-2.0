-- ============================================================================
-- FindMaxxing — first-party, privacy-respecting product analytics.
--
--   * analytics_events: key actions only, no IP address, no raw user id. The
--     actor is a salted hash of the user id; the salt lives in a table no
--     client can read, so events cannot be joined back to a profile from the
--     outside.
--   * written only through track_event(): the actor comes from the session
--     (nobody can write events as someone else), the event name must be one of
--     a fixed list, the properties are small, it is rate limited, and it does
--     nothing for users who opted out.
--   * read only by admins (a role granted from SQL, like moderators), through
--     the metric functions below.
--   * kept 180 days: purge_analytics() deletes anything older; a daily cron
--     calls it (see README, Analytics).
--
-- Places get a `source`: 'community' for anything a user adds, 'seed' for the
-- demo/bootstrap data. The thesis metric — what share of saves go to
-- community knowledge — is computed from it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Admins
-- ----------------------------------------------------------------------------
create table public.admins (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.profiles (id) on delete set null
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

create policy "admins see the admin list" on public.admins for select
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.admins from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Where a place came from
-- ----------------------------------------------------------------------------
alter table public.places add column source text not null default 'community'
  check (source in ('community', 'seed'));
-- Clients cannot claim a source: inserts are forced to 'community' unless the
-- writer has no session (seeds and imports run from SQL).
create or replace function public.force_place_source()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.source := 'community';
  end if;
  return new;
end $$;
create trigger places_force_source
  before insert on public.places
  for each row execute function public.force_place_source();

-- ----------------------------------------------------------------------------
-- Opt-out
-- ----------------------------------------------------------------------------
alter table public.profiles add column analytics_opt_out boolean not null default false;
grant update (analytics_opt_out) on public.profiles to authenticated;

-- ----------------------------------------------------------------------------
-- Events
-- ----------------------------------------------------------------------------
create table public.analytics_salt (
  id    boolean primary key default true check (id),
  salt  text not null
);
insert into public.analytics_salt (salt) values (encode(gen_random_bytes(32), 'hex'));
alter table public.analytics_salt enable row level security;
revoke all on public.analytics_salt from anon, authenticated;

create table public.analytics_events (
  id          bigint generated always as identity primary key,
  actor       text not null,
  name        text not null check (name in (
                'view_place', 'save_place', 'add_to_list', 'contribute_place',
                'create_event', 'join_event', 'follow', 'rate_place',
                'search_no_results', 'onboarding_step')),
  props       jsonb not null default '{}'::jsonb check (pg_column_size(props) <= 1024),
  created_at  timestamptz not null default now()
);
create index analytics_events_name_time_idx on public.analytics_events (name, created_at);
create index analytics_events_time_idx on public.analytics_events (created_at);

alter table public.analytics_events enable row level security;
create policy "admins read analytics" on public.analytics_events for select using (public.is_admin());
revoke insert, update, delete on public.analytics_events from anon, authenticated;

insert into public.rate_limit_rules (action, max_count, window_seconds, label)
values ('analytics', 600, 3600, 'analytics events');

-- The pseudonymous actor for a user: a salted SHA-256 of the id. pgcrypto's
-- digest() lives in the extensions schema on Supabase (public in PGlite).
create or replace function public.analytics_actor(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select encode(digest(s.salt || ':' || p_user_id::text, 'sha256'), 'hex') from public.analytics_salt s;
$$;
revoke all on function public.analytics_actor(uuid) from public, anon, authenticated;

-- Records one event for the signed-in user. Silently does nothing without a
-- session or for users who opted out (the caller cannot tell either way).
-- Definer rights: the table is closed to clients, and the salt with it.
create or replace function public.track_event(p_name text, p_props jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and analytics_opt_out) then
    return;
  end if;
  perform public.check_rate_limit('analytics');
  insert into public.analytics_events (actor, name, props)
  values (public.analytics_actor(auth.uid()), p_name, coalesce(p_props, '{}'::jsonb));
end $$;
revoke all on function public.track_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.track_event(text, jsonb) to authenticated;

-- Retention: everything older than 180 days goes. For the daily cron (service
-- role); returns how many rows were deleted.
create or replace function public.purge_analytics(p_keep_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.analytics_events where created_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_analytics(integer) from public, anon, authenticated;
grant execute on function public.purge_analytics(integer) to service_role;

-- ----------------------------------------------------------------------------
-- Metrics (admins only; empty for anyone else)
-- ----------------------------------------------------------------------------

-- The core loop as a funnel: distinct actors who did each step in the window.
create or replace function public.analytics_funnel(p_from timestamptz, p_to timestamptz)
returns table (step text, actors integer, events integer)
language sql
stable
security definer
set search_path = public
as $$
  select s.step, coalesce(count(distinct e.actor), 0)::integer, coalesce(count(e.id), 0)::integer
  from unnest(array['view_place', 'save_place', 'add_to_list', 'contribute_place', 'create_event', 'join_event', 'follow'])
       with ordinality as s(step, ord)
  left join public.analytics_events e
    on e.name = s.step and e.created_at >= p_from and e.created_at < p_to and public.is_admin()
  where public.is_admin()
  group by s.step, s.ord
  order by s.ord;
$$;

-- Distinct people who contributed (a place, an event or a rating) per week.
create or replace function public.analytics_weekly_contributors(p_weeks integer default 12)
returns table (week_start date, contributors integer)
language sql
stable
security definer
set search_path = public
as $$
  with weeks as (
    select generate_series(date_trunc('week', now()) - make_interval(weeks => p_weeks - 1), date_trunc('week', now()), interval '1 week')::date as week_start
  )
  select w.week_start, count(distinct e.actor)::integer
  from weeks w
  left join public.analytics_events e
    on e.name in ('contribute_place', 'create_event', 'rate_place')
   and e.created_at >= w.week_start and e.created_at < w.week_start + 7
  where public.is_admin()
  group by w.week_start
  order by w.week_start;
$$;

-- The thesis metric: saves made in the window, split by where the saved place
-- came from. Computed from the saves themselves, so it is exact even for users
-- who opted out of analytics (no one is identified; only totals come back).
create or replace function public.analytics_save_sources(p_from timestamptz, p_to timestamptz)
returns table (source text, saves integer)
language sql
stable
security definer
set search_path = public
as $$
  select s.source, count(sp.place_id)::integer
  from unnest(array['community', 'seed']) as s(source)
  left join (public.saved_places sp join public.places p on p.id = sp.place_id)
    on p.source = s.source and sp.created_at >= p_from and sp.created_at < p_to
  where public.is_admin()
  group by s.source
  order by s.source;
$$;

revoke all on function public.analytics_funnel(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.analytics_weekly_contributors(integer) from public, anon, authenticated;
revoke all on function public.analytics_save_sources(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.analytics_funnel(timestamptz, timestamptz) to authenticated;
grant execute on function public.analytics_weekly_contributors(integer) to authenticated;
grant execute on function public.analytics_save_sources(timestamptz, timestamptz) to authenticated;
