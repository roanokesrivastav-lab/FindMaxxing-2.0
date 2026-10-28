-- ============================================================================
-- FindMaxxing — write rate limits, enforced in the database.
--
-- The app's server actions are not the only way in: a client can call
-- PostgREST and Storage directly with its own JWT. So the limits live here,
-- in before-insert triggers and the storage upload policy, where every path
-- has to pass them.
--
-- Fixed windows: a counter per (user, action, window start). The window start
-- is now() rounded down to the window length. check_rate_limit() takes a
-- per-user-and-action advisory lock before counting, so concurrent inserts
-- cannot both see room for one more. The increment rolls back with the insert
-- it guards, so a failed write never uses up the allowance.
--
-- The limits themselves are one table, rate_limit_rules, mirrored by
-- RATE_LIMITS in src/lib/rateLimits.ts (a test keeps the two equal).
-- ============================================================================

create table public.rate_limit_rules (
  action          text primary key,
  max_count       integer not null check (max_count > 0),
  window_seconds  integer not null check (window_seconds > 0),
  -- The plural noun used in "Too many <label>" messages.
  label           text not null
);

insert into public.rate_limit_rules (action, max_count, window_seconds, label) values
  ('places',  20, 86400, 'places'),
  ('events',  50, 86400, 'events'),
  ('ratings', 100, 86400, 'ratings'),
  ('lists',   30, 86400, 'lists'),
  ('reports', 30, 86400, 'reports'),
  ('photos',  60, 3600,  'photo uploads'),
  ('avatars', 20, 3600,  'avatar uploads');

alter table public.rate_limit_rules enable row level security;
create policy "rate limits are public" on public.rate_limit_rules for select using (true);
revoke insert, update, delete on public.rate_limit_rules from anon, authenticated;

create table public.rate_limit_counters (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  action        text not null references public.rate_limit_rules (action) on delete cascade,
  window_start  timestamptz not null,
  count         integer not null check (count >= 0),
  primary key (user_id, action, window_start)
);

-- Nobody reads or writes counters except through check_rate_limit().
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

-- Counts one write by the signed-in user against `p_action`, or raises
-- SQLSTATE FM429 with "rate_limited:<action>:<seconds until the window resets>".
-- Callers without a session (seeds, SQL maintenance, the service role) are
-- not limited. Definer rights: the counter table is closed to clients.
create or replace function public.check_rate_limit(p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  rule public.rate_limit_rules%rowtype;
  win timestamptz;
  used integer;
begin
  if uid is null then
    return;
  end if;
  select * into rule from public.rate_limit_rules where action = p_action;
  if not found then
    raise exception 'Unknown rate limit %', p_action;
  end if;
  win := to_timestamp(floor(extract(epoch from now()) / rule.window_seconds) * rule.window_seconds);

  perform pg_advisory_xact_lock(hashtextextended('rate:' || uid::text || ':' || p_action, 0));
  -- Earlier windows are finished; keep the table at one row per user and action.
  delete from public.rate_limit_counters
   where user_id = uid and action = p_action and window_start < win;
  insert into public.rate_limit_counters (user_id, action, window_start, count)
  values (uid, p_action, win, 1)
  on conflict (user_id, action, window_start)
    do update set count = public.rate_limit_counters.count + 1
  returning count into used;

  if used > rule.max_count then
    raise exception 'rate_limited:%:%', p_action,
      greatest(1, ceil(extract(epoch from (win + make_interval(secs => rule.window_seconds) - now()))))::integer
      using errcode = 'FM429';
  end if;
end $$;

revoke all on function public.check_rate_limit(text) from public, anon, authenticated;
-- Storage policies run as the caller, so the upload policy needs to call it.
grant execute on function public.check_rate_limit(text) to authenticated;

-- One trigger function for every limited table; the action is its argument.
create or replace function public.enforce_rate_limit()
returns trigger
language plpgsql
as $$
begin
  perform public.check_rate_limit(tg_argv[0]);
  return new;
end $$;

create trigger places_rate_limit        before insert on public.places        for each row execute function public.enforce_rate_limit('places');
create trigger events_rate_limit        before insert on public.events        for each row execute function public.enforce_rate_limit('events');
create trigger place_ratings_rate_limit before insert on public.place_ratings for each row execute function public.enforce_rate_limit('ratings');
create trigger saved_lists_rate_limit   before insert on public.saved_lists   for each row execute function public.enforce_rate_limit('lists');
create trigger reports_rate_limit       before insert on public.reports       for each row execute function public.enforce_rate_limit('reports');

-- Uploads. A place photo is stored as three objects (the large size plus the
-- .md and .sm copies); only the large one counts, so the limit is per photo.
create or replace function public.count_upload(p_bucket text, p_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_bucket = 'avatars' then
    perform public.check_rate_limit('avatars');
  elsif p_bucket = 'place-photos' and p_name !~ '\.(sm|md)\.[a-z]+$' then
    perform public.check_rate_limit('photos');
  end if;
  return true;
end $$;

revoke all on function public.count_upload(text, text) from public, anon, authenticated;
grant execute on function public.count_upload(text, text) to authenticated;

drop policy if exists "users upload to own folder" on storage.objects;
create policy "users upload to own folder" on storage.objects for insert
  with check (
    bucket_id in ('place-photos', 'avatars')
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.count_upload(bucket_id, name)
  );
