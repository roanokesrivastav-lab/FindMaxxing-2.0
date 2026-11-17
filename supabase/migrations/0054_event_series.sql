-- ============================================================================
-- Roadmap 4.5a, second slice (4.0 §3, §4, §8, §10; Amendment A1 revision 3:
-- A1.4, A1.9; revision 3 preflight items 2 and 3): recurring series.
--
--   * event_series is a template plus a weekly rule. Each occurrence is an
--     ordinary row in events (D-A) with a stable id, its own attendees, chat,
--     tickets and readiness. events gains series_id, series_local_date and
--     overridden; event_attendees gains attended (host-recorded, never
--     inferred; it does not satisfy R4).
--   * Occurrences are generated four weeks ahead (D-C), idempotently by a
--     plain unique index on (series_id, series_local_date), in the series'
--     zone with the first-instant DST rule (D-G). A cancelled date is never
--     recreated.
--   * Hosts act only through the functions below. A backup host is accepted
--     by the owner guard only while the transaction is marked by one of them,
--     and the guard rechecks the role itself at write time, so revocation is
--     immediate and a direct backup write stays denied.
--   * Lock order (A1.9): account_close:<user> locks ascending (the acting
--     user and the series owner), the series row, event rows ascending,
--     tickets, attendees, conversations in event order. The legacy direct
--     writes from the web and native clients used to lock their row first
--     and take the caller's account lock afterwards (a row trigger); a
--     statement-level trigger now takes it before any row is touched, so
--     every signed-in writer agrees on the order and no cycle is possible.
--     The batch generator (cron) never waits: it try-locks each series and
--     skips the ones it cannot take at once.
--   * A schedule change is planned read-only under the locks and applied
--     only once the plan is conflict-free: committed occurrences move in
--     place, uncommitted ones are deleted and regenerated, and one with no
--     safe destination is kept where it is and reported (A1.4).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The weekly rule and the first-instant zone arithmetic
-- ----------------------------------------------------------------------------
-- {"freq":"weekly","interval":1-4,"weekdays":[ISO 1-7, distinct, non-empty],
--  "start_local":"HH:MM","duration_minutes":15-720}; no other keys.
create or replace function public.valid_series_rule(p_rule jsonb)
returns boolean language plpgsql immutable set search_path = public as $$
declare
  wd jsonb;
begin
  if p_rule is null or jsonb_typeof(p_rule) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p_rule) k where k not in ('freq', 'interval', 'weekdays', 'start_local', 'duration_minutes')) then return false; end if;
  if p_rule ->> 'freq' is distinct from 'weekly' then return false; end if;
  if jsonb_typeof(p_rule -> 'interval') <> 'number' or (p_rule ->> 'interval')::numeric not in (1, 2, 3, 4) then return false; end if;
  wd := p_rule -> 'weekdays';
  if wd is null or jsonb_typeof(wd) <> 'array' or jsonb_array_length(wd) not between 1 and 7 then return false; end if;
  if exists (select 1 from jsonb_array_elements(wd) x where jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not in (1, 2, 3, 4, 5, 6, 7)) then return false; end if;
  if (select count(distinct x #>> '{}') from jsonb_array_elements(wd) x) <> jsonb_array_length(wd) then return false; end if;
  if coalesce(p_rule ->> 'start_local', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
  if jsonb_typeof(p_rule -> 'duration_minutes') <> 'number' then return false; end if;
  if (p_rule ->> 'duration_minutes')::numeric <> floor((p_rule ->> 'duration_minutes')::numeric)
     or (p_rule ->> 'duration_minutes')::numeric not between 15 and 720 then return false; end if;
  return true;
exception when others then
  return false;
end $$;

-- The zone's offset (local minus UTC) at an instant.
create or replace function findmaxxing_private.zone_offset(p_at timestamptz, p_zone text)
returns interval language sql stable set search_path = public as $$
  select (p_at at time zone p_zone) - (p_at at time zone 'UTC');
$$;

-- The instant for a wall-clock date and time in a zone (D-G). A spring-forward
-- gap resolves to the same clock reading in the earlier offset; a fall-back
-- repeat resolves to its FIRST occurrence. Mirrors zonedTimeToUtc in
-- packages/shared/src/timezone.ts: never bare `at time zone`, which picks the
-- second instant on PostgreSQL.
create or replace function findmaxxing_private.local_to_instant(p_date date, p_time time, p_zone text)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  wall timestamptz := ((p_date + p_time)::timestamp) at time zone 'UTC';
  first interval := findmaxxing_private.zone_offset(wall - interval '12 hours', p_zone);
  second interval := findmaxxing_private.zone_offset(wall + interval '12 hours', p_zone);
  off interval;
  candidate timestamptz;
begin
  foreach off in array array[first, second] loop
    candidate := wall - off;
    if findmaxxing_private.zone_offset(candidate, p_zone) = off then return candidate; end if;
  end loop;
  return wall - first;
end $$;

-- Local dates the rule produces between two dates (inclusive), counting
-- "every N weeks" in ISO weeks from the week of starts_on.
create or replace function findmaxxing_private.series_dates(p_rule jsonb, p_starts_on date, p_from date, p_to date)
returns setof date language sql stable set search_path = public as $$
  select d::date
  from generate_series(greatest(p_from, p_starts_on)::timestamp, p_to::timestamp, interval '1 day') d
  where extract(isodow from d)::int in (select (x #>> '{}')::int from jsonb_array_elements(p_rule -> 'weekdays') x)
    and ((date_trunc('week', d)::date - date_trunc('week', p_starts_on::timestamp)::date) / 7) % (p_rule ->> 'interval')::int = 0;
$$;

-- ----------------------------------------------------------------------------
-- 2. Tables and columns
-- ----------------------------------------------------------------------------
create table public.event_series (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.profiles (id) on delete cascade,
  title                 text not null check (char_length(title) between 3 and 90),
  description           text not null check (char_length(description) between 10 and 1200),
  category_slug         text not null references public.categories (slug),
  place_id              uuid references public.places (id) on delete set null,
  location_name         text not null check (char_length(location_name) between 2 and 120),
  address               text check (address is null or char_length(address) <= 160),
  lat                   double precision not null check (lat between -90 and 90),
  lng                   double precision not null check (lng between -180 and 180),
  time_zone             text not null,
  rule                  jsonb not null check (public.valid_series_rule(rule)),
  starts_on             date not null,
  ends_on               date check (ends_on is null or ends_on >= starts_on),
  capacity              integer check (capacity is null or capacity between 2 and 5000),
  min_attendance        integer check (min_attendance is null or min_attendance >= 2),
  decision_lead_minutes integer check (decision_lead_minutes is null or decision_lead_minutes between 15 and 10080),
  activity_details      jsonb check (public.valid_activity_details(activity_details)),
  status                text not null default 'active' check (status in ('active', 'paused', 'ended', 'removed')),
  rule_version          integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (min_attendance is null or capacity is null or min_attendance <= capacity),
  check (decision_lead_minutes is null or min_attendance is not null)
);
create index event_series_owner_idx on public.event_series (owner_id);
create index event_series_status_idx on public.event_series (status, id);
create trigger event_series_updated_at before update on public.event_series for each row execute function public.set_updated_at();

create table public.event_series_tags (
  series_id      uuid not null references public.event_series (id) on delete cascade,
  interest_slug  text not null references public.interests (slug) on delete cascade,
  primary key (series_id, interest_slug)
);

create table public.event_series_hosts (
  series_id  uuid not null references public.event_series (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('owner', 'backup')),
  added_at   timestamptz not null default now(),
  primary key (series_id, user_id)
);
create index event_series_hosts_user_idx on public.event_series_hosts (user_id);
-- Exactly one owner row, and it is the series owner.
create unique index event_series_one_owner_idx on public.event_series_hosts (series_id) where role = 'owner';

create table public.event_series_followers (
  series_id   uuid not null references public.event_series (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (series_id, user_id)
);
create index event_series_followers_user_idx on public.event_series_followers (user_id);

alter table public.events add column series_id uuid references public.event_series (id) on delete cascade;
alter table public.events add column series_local_date date;
alter table public.events add column overridden text[] not null default '{}';
alter table public.events add column removed_with_series boolean not null default false;
-- A one-off event never has a local date. A series occurrence has one except
-- during the two-step move inside update_series_from, which ends by asserting
-- that none is left null.
alter table public.events add constraint events_series_date_check check (series_id is not null or series_local_date is null);
-- A plain unique index: the on-conflict arbiter for generation (A1.4).
create unique index events_series_local_date_key on public.events (series_id, series_local_date);
create index events_series_starts_idx on public.events (series_id, starts_at) where series_id is not null;

alter table public.event_attendees add column attended boolean;

-- The zone is validated like events.time_zone; the owner row is kept honest.
create or replace function findmaxxing_private.guard_series_row()
returns trigger language plpgsql set search_path = public as $$
begin
  if not public.valid_time_zone(new.time_zone) then
    raise exception 'events:bad_time_zone' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then
    raise exception 'events:bad_series' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger event_series_guard before insert or update on public.event_series for each row execute function findmaxxing_private.guard_series_row();

create or replace function findmaxxing_private.guard_series_host_row()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.role = 'owner' and not exists (select 1 from public.event_series s where s.id = new.series_id and s.owner_id = new.user_id) then
    raise exception 'events:bad_series' using errcode = 'P0001';
  end if;
  if new.role = 'backup' and exists (select 1 from public.event_series s where s.id = new.series_id and s.owner_id = new.user_id) then
    raise exception 'events:bad_series' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger event_series_hosts_guard before insert or update on public.event_series_hosts for each row execute function findmaxxing_private.guard_series_host_row();

-- Suspended and closing accounts cannot follow or be given a series (0017, 0027).
create trigger event_series_block_suspended before insert or update or delete on public.event_series for each row execute function public.block_suspended_writes();
create trigger event_series_hosts_block_suspended before insert or update or delete on public.event_series_hosts for each row execute function public.block_suspended_writes();
create trigger event_series_followers_block_suspended before insert or update or delete on public.event_series_followers for each row execute function public.block_suspended_writes();

-- ----------------------------------------------------------------------------
-- 3. Visibility and roles
-- ----------------------------------------------------------------------------
-- A series is visible like an event: to its owner unless removed, and to
-- everyone when its usual place is visible (4.0 §14).
create or replace function public.can_view_series(p_series uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.event_series s
    where s.id = p_series
      and ((s.owner_id = auth.uid() and s.status <> 'removed')
        or (s.status in ('active', 'paused', 'ended') and (s.place_id is null or public.can_view_place(s.place_id))))
  );
$$;
revoke all on function public.can_view_series(uuid) from public;
grant execute on function public.can_view_series(uuid) to anon, authenticated, service_role;

-- Host names are public (4.0 §14), so this may be called by anyone signed in.
-- The owner guard (security invoker) calls it to recheck a backup host.
create or replace function public.is_series_host(p_series uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and exists (
    select 1 from public.event_series_hosts h where h.series_id = p_series and h.user_id = p_user);
$$;
revoke all on function public.is_series_host(uuid, uuid) from public, anon;
grant execute on function public.is_series_host(uuid, uuid) to authenticated, service_role;

-- Who may run an event's session: its creator, or a current host of its series.
create or replace function findmaxxing_private.can_host_event(p_event uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and exists (
    select 1 from public.events e
    where e.id = p_event
      and (e.creator_id = p_user or (e.series_id is not null and public.is_series_host(e.series_id, p_user))));
$$;
revoke all on function findmaxxing_private.can_host_event(uuid, uuid) from public, anon, authenticated, service_role;

alter table public.event_series enable row level security;
alter table public.event_series_tags enable row level security;
alter table public.event_series_hosts enable row level security;
alter table public.event_series_followers enable row level security;

create policy "visible series" on public.event_series for select using (public.can_view_series(id));
revoke insert, update, delete on public.event_series from anon, authenticated;
create policy "visible series tags" on public.event_series_tags for select using (public.can_view_series(series_id));
revoke insert, update, delete on public.event_series_tags from anon, authenticated;
create policy "visible series hosts" on public.event_series_hosts for select using (public.can_view_series(series_id));
revoke insert, update, delete on public.event_series_hosts from anon, authenticated;
-- Following: own rows only. Nothing here, and no trigger anywhere, writes event_attendees.
create policy "own follows" on public.event_series_followers for select using (user_id = auth.uid());
create policy "follow visible series as self" on public.event_series_followers for insert
  with check (user_id = auth.uid() and public.can_view_series(series_id));
create policy "unfollow as self" on public.event_series_followers for delete using (user_id = auth.uid());
revoke update on public.event_series_followers from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Lock order for every signed-in writer (preflight item 2)
-- ----------------------------------------------------------------------------
-- The direct web and native writes lock their row first and only then take
-- the caller's account lock in the row trigger (0027). A statement-level
-- BEFORE trigger runs before any row is touched, so the same statements now
-- hold the account lock first. Advisory transaction locks are re-entrant, so
-- the row trigger's lock becomes a no-op. Service callers are unaffected.
create or replace function findmaxxing_private.lock_actor_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  end if;
  return null;
end $$;
revoke all on function findmaxxing_private.lock_actor_account() from public, anon, authenticated, service_role;
create trigger events_a_lock_actor before update or delete on public.events for each statement execute function findmaxxing_private.lock_actor_account();
create trigger event_attendees_a_lock_actor before insert or delete on public.event_attendees for each statement execute function findmaxxing_private.lock_actor_account();
create trigger event_tags_a_lock_actor before insert or update or delete on public.event_tags for each statement execute function findmaxxing_private.lock_actor_account();

-- The caller's account lock first, then the existing checks (0051).
create or replace function findmaxxing_private.require_active_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  if exists (select 1 from public.suspensions where user_id = auth.uid()) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.account_deletion_jobs where user_id = auth.uid())
     or not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'account_deletion_in_progress' using errcode = 'P0001';
  end if;
end $$;
revoke all on function findmaxxing_private.require_active_account() from public, anon, authenticated, service_role;

-- Account locks for a set of users, ascending, before any row lock.
create or replace function findmaxxing_private.lock_accounts(p_users uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  u uuid;
begin
  for u in select distinct x from unnest(p_users) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || u::text, 0));
  end loop;
end $$;
revoke all on function findmaxxing_private.lock_accounts(uuid[]) from public, anon, authenticated, service_role;

-- The acting user's and the event creator's account locks, ascending. The
-- creator is read without a lock only to learn whose lock to take; it never
-- changes, so nothing has to be rechecked.
create or replace function findmaxxing_private.lock_event_actors(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_creator uuid;
begin
  select creator_id into v_creator from public.events where id = p_event;
  perform findmaxxing_private.lock_accounts(array[auth.uid(), v_creator]);
end $$;
revoke all on function findmaxxing_private.lock_event_actors(uuid) from public, anon, authenticated, service_role;

-- Price changes (0022): the caller's account lock before the event lock.
create or replace function public.set_event_price(p_event uuid, p_cents integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or e.creator_id is distinct from auth.uid() then raise exception 'payments:not_found' using errcode = 'P0002'; end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then raise exception 'payments:event_closed' using errcode = 'P0001'; end if;
  if p_cents is not null and (p_cents < 100 or p_cents > 50000) then raise exception 'payments:bad_price' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tickets t where t.event_id = p_event and t.status in ('pending', 'paid', 'refund_pending'))
     or exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id <> e.creator_id) then
    raise exception 'payments:price_locked' using errcode = 'P0001';
  end if;
  if p_cents is not null and not exists (select 1 from public.host_accounts h where h.user_id = auth.uid() and h.charges_enabled) then
    raise exception 'payments:no_payout_account' using errcode = 'P0001';
  end if;
  perform set_config('findmaxxing.pricing', 'on', true);
  update public.events set price_cents = p_cents where id = p_event;
  perform set_config('findmaxxing.pricing', 'off', true);
end $$;

-- Session rules (0051): actor and creator account locks first; series hosts
-- may run them through the marked path.
create or replace function public.set_session_rules(
  p_event uuid, p_min_attendance integer, p_decision_deadline timestamptz, p_venue_status text
) returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.lock_event_actors(p_event);
  select * into e from public.events where id = p_event for update;
  if not found or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'events:closed' using errcode = 'P0001';
  end if;
  if p_venue_status is null or p_venue_status not in ('confirmed', 'unconfirmed') then
    raise exception 'events:bad_session_rules' using errcode = 'P0001';
  end if;
  perform set_config('findmaxxing.session_rules', 'explicit', true);
  perform set_config('findmaxxing.series_write', 'on', true);
  update public.events set min_attendance = p_min_attendance, decision_deadline = p_decision_deadline, venue_status = p_venue_status,
    overridden = case when e.series_id is null or 'session_rules' = any(overridden) then overridden else array_append(overridden, 'session_rules') end
  where id = p_event;
  perform set_config('findmaxxing.series_write', 'off', true);
  perform set_config('findmaxxing.session_rules', 'off', true);
end $$;

create or replace function public.confirm_session(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.lock_event_actors(p_event);
  select * into e from public.events where id = p_event for update;
  if not found or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'events:closed' using errcode = 'P0001';
  end if;
  if e.decision = 'open' then
    perform set_config('findmaxxing.series_write', 'on', true);
    update public.events set decision = 'happening' where id = p_event;
    perform set_config('findmaxxing.series_write', 'off', true);
  end if;
  return 'happening';
end $$;

-- Account closure (0027): the user's series and events are locked in
-- ascending id before anything is cancelled (A1.7).
create or replace function public.prepare_account_deletion(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare paths jsonb; customer text; subscription text; previous jsonb; has_objects boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || p_user::text, 0));
  perform 1 from public.profiles where id = p_user for update;
  if exists (select 1 from public.account_deletion_jobs where user_id = p_user and completed_at is not null) then return; end if;
  select customer_id into customer from public.stripe_customers where user_id = p_user;
  select stripe_subscription_id into subscription from public.entitlements where user_id = p_user;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'path', name) order by bucket_id, name), '[]'::jsonb) into paths
  from storage.objects o where
    o.name like p_user::text || '/%'
    or coalesce(to_jsonb(o)->>'owner_id', to_jsonb(o)->>'owner') = p_user::text
    or (o.bucket_id = 'place-photos' and exists (
      select 1 from public.place_photos ph left join public.places p on p.id = ph.place_id
      where (ph.uploader_id = p_user or p.creator_id = p_user) and ph.storage_path is not null
        and o.name in (ph.storage_path,
          regexp_replace(ph.storage_path, '\.(jpe?g|png|webp)$', '', 'i') || '.sm.webp',
          regexp_replace(ph.storage_path, '\.(jpe?g|png|webp)$', '', 'i') || '.md.webp')));
  has_objects := paths <> '[]'::jsonb;
  insert into public.account_deletion_jobs(user_id, storage_paths, stripe_customer_id, stripe_subscription_ids)
    values (p_user, paths, customer, case when subscription is null then '{}'::text[] else array[subscription] end)
    on conflict (user_id) do nothing;
  select storage_paths into previous from public.account_deletion_jobs where user_id = p_user for update;
  -- A reappearing object must be removed again, even if its path was checkpointed.
  update public.account_deletion_jobs set removed_storage_paths = coalesce((
    select jsonb_agg(x) from jsonb_array_elements(removed_storage_paths) x
    where not exists (select 1 from jsonb_array_elements(paths) actual where actual = x)), '[]'::jsonb)
    where user_id = p_user;
  select coalesce(jsonb_agg(x order by x->>'bucket', x->>'path'), '[]'::jsonb) into paths
    from (select distinct x from jsonb_array_elements(previous || paths) x) merged;
  update public.account_deletion_jobs set storage_paths = paths,
    storage_complete = storage_complete and not has_objects,
    stripe_customer_id = coalesce(stripe_customer_id, customer),
    stripe_subscription_ids = case when subscription is null or subscription = any(stripe_subscription_ids)
      then stripe_subscription_ids else array_append(stripe_subscription_ids, subscription) end,
    updated_at = now() where user_id = p_user;
  -- Series first, then events, each in ascending id: the order every series path uses.
  perform 1 from public.event_series where owner_id = p_user order by id for update;
  perform 1 from public.events where creator_id = p_user order by id for update;
  update public.event_series set status = 'ended', ends_on = least(coalesce(ends_on, 'infinity'::date), (now() at time zone time_zone)::date)
    where owner_id = p_user and status in ('active', 'paused');
  -- Close future events now so a late confirmation cannot admit another buyer.
  update public.events set status = 'cancelled', cancel_reason = case when series_id is null then cancel_reason else 'series_ended' end
    where creator_id = p_user and status = 'published' and starts_at > now();
  update public.tickets set status = 'expired' where status = 'pending'
    and (user_id = p_user or event_id in (select id from public.events where creator_id = p_user));
end $$;

-- ----------------------------------------------------------------------------
-- 5. The owner guard with the marked series path (preflight item 3), and the
--    rate limit that counts a series once
-- ----------------------------------------------------------------------------
-- As in 0053, plus: a non-creator is accepted only while a series function has
-- marked the transaction AND is a current host of the row's series, checked
-- here at write time. Everything else is unchanged for every caller.
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql as $$
declare
  v_series_host boolean := false;
begin
  if current_setting('findmaxxing.moderation', true) = 'on' and public.is_moderator() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and old.creator_id is not null
     and not exists (select 1 from public.profiles where id = old.creator_id) then
    return old;
  end if;
  if auth.uid() is not null and old.creator_id is distinct from auth.uid()
     and coalesce(current_setting('findmaxxing.series_write', true), 'off') = 'on' and old.series_id is not null then
    v_series_host := public.is_series_host(old.series_id, auth.uid());
  end if;
  if tg_op = 'UPDATE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() and not v_series_host then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if old.status <> 'published' or coalesce(old.ends_at, old.starts_at) <= now() then
      raise exception 'Only future published events can be edited or cancelled' using errcode = 'P0001';
    end if;
    if new.status not in ('published', 'cancelled') then
      raise exception 'Invalid event status' using errcode = 'P0001';
    end if;
    if new.status = 'published' and coalesce(new.ends_at, new.starts_at) <= now() then
      raise exception 'Events must remain in the future when edited' using errcode = 'P0001';
    end if;
    if new.status = 'cancelled' and (
      new.title, new.description, new.place_id, new.location_name, new.address,
      new.lat, new.lng, new.starts_at, new.ends_at, new.creator_id,
      new.category_slug, new.capacity
    ) is distinct from (
      old.title, old.description, old.place_id, old.location_name, old.address,
      old.lat, old.lng, old.starts_at, old.ends_at, old.creator_id,
      old.category_slug, old.capacity
    ) then
      raise exception 'Cancelling an event cannot also change its details' using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() and not v_series_host then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.event_attendees
      where event_id = old.id and user_id is distinct from old.creator_id
    ) then
      raise exception 'Events with other attendees must be cancelled instead' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- A series creation counts one 'events' hit for its owner (the function calls
-- check_rate_limit itself); the occurrences it generates do not each count.
create or replace function public.enforce_rate_limit()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'events' and coalesce(current_setting('findmaxxing.series_write', true), 'off') = 'on' then
    return new;
  end if;
  perform public.check_rate_limit(tg_argv[0]);
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Committed and uncommitted occurrences (A1.4), and the Outings hook
-- ----------------------------------------------------------------------------
-- How many live outings are anchored to this occurrence (A1.4 rule d). The
-- Outings migration (5.0 Amendment A1) redefines this to count its private
-- anchor table; nothing else in the series code changes.
create or replace function findmaxxing_private.occurrence_anchors(p_event uuid)
returns integer language sql stable security definer set search_path = public as $$
  select 0;
$$;
revoke all on function findmaxxing_private.occurrence_anchors(uuid) from public, anon, authenticated, service_role;

-- Checked under the occurrence's event lock (and, for rule c, after its
-- conversation lock). Rule g names every foreign key to events apart from the
-- rows the generator itself writes; a test reads the catalog and fails on one
-- this list does not cover.
create or replace function findmaxxing_private.occurrence_committed(p_event uuid, p_now timestamptz)
returns boolean language sql volatile security definer set search_path = public as $$
  select exists (
    select 1 from public.events e
    where e.id = p_event and (
         exists (select 1 from public.event_attendees a where a.event_id = e.id and a.user_id is distinct from e.creator_id)   -- a
      or exists (select 1 from public.tickets t where t.event_id = e.id)                                                       -- b
      or exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where c.event_id = e.id) -- c
      or findmaxxing_private.occurrence_anchors(e.id) > 0                                                                     -- d
      or e.status <> 'published' or e.starts_at <= p_now                                                                       -- e
      or cardinality(e.overridden) > 0 or e.decision <> 'open' or e.price_cents is not null                                    -- f
      or exists (select 1 from public.event_attendees a where a.event_id = e.id and a.attended is not null)                   -- f
      or exists (select 1 from public.ad_campaigns ad where ad.event_id = e.id)                                               -- g
    ));
$$;
revoke all on function findmaxxing_private.occurrence_committed(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Generation. Called with the owner's account lock and the series lock
--    already held. Writes an occurrence the way a one-off event is created
--    (0051 create_event_with_details): the row, its tags and the owner going,
--    which gives it an empty conversation through sync_event_chat.
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.generate_for_series(p_series uuid, p_now timestamptz, p_from date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
  d date;
  v_today date;
  v_start timestamptz;
  v_end timestamptz;
  v_deadline timestamptz;
  v_id uuid;
  n integer := 0;
begin
  select * into s from public.event_series where id = p_series;
  if not found or s.status <> 'active' then return 0; end if;
  v_today := (p_now at time zone s.time_zone)::date;
  perform set_config('findmaxxing.series_write', 'on', true);
  for d in
    select x from findmaxxing_private.series_dates(s.rule, s.starts_on, greatest(v_today, coalesce(p_from, v_today)), v_today + 28) x
    where (s.ends_on is null or x <= s.ends_on)
      and not exists (select 1 from public.events e where e.series_id = s.id and e.series_local_date = x)
    order by x
  loop
    v_start := findmaxxing_private.local_to_instant(d, (s.rule ->> 'start_local')::time, s.time_zone);
    continue when v_start <= p_now;
    v_end := v_start + make_interval(mins => (s.rule ->> 'duration_minutes')::int);
    -- A deadline that would already have passed is not set: a new occurrence is never born cancelled.
    v_deadline := case when s.decision_lead_minutes is null then null else v_start - make_interval(mins => s.decision_lead_minutes) end;
    if v_deadline is not null and v_deadline <= p_now then v_deadline := null; end if;
    perform set_config('findmaxxing.session_rules', 'explicit', true);
    insert into public.events (
      title, description, place_id, location_name, address, lat, lng, starts_at, ends_at, creator_id, category_slug,
      capacity, time_zone, activity_details, min_attendance, decision_deadline, venue_status, series_id, series_local_date
    ) values (
      s.title, s.description, s.place_id, s.location_name, s.address, s.lat, s.lng, v_start, v_end, s.owner_id, s.category_slug,
      s.capacity, s.time_zone, s.activity_details, s.min_attendance, v_deadline, 'confirmed', s.id, d
    ) on conflict (series_id, series_local_date) do nothing
    returning id into v_id;
    perform set_config('findmaxxing.session_rules', 'off', true);
    continue when v_id is null;
    insert into public.event_tags (event_id, interest_slug) select v_id, t.interest_slug from public.event_series_tags t where t.series_id = s.id;
    insert into public.event_attendees (event_id, user_id) values (v_id, s.owner_id) on conflict do nothing;
    n := n + 1;
  end loop;
  perform set_config('findmaxxing.series_write', 'off', true);
  return n;
end $$;
revoke all on function findmaxxing_private.generate_for_series(uuid, timestamptz, date) from public, anon, authenticated, service_role;

-- The cron's run (service role). It visits every active series and never
-- waits: an owner's account lock or a series row it cannot take at once is
-- skipped and caught up on the next run. With p_series it runs one series
-- with blocking locks, in order. Returns how many occurrences were created.
create or replace function public.generate_series_occurrences(p_series uuid default null, p_now timestamptz default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  n integer := 0;
begin
  if auth.uid() is not null then raise exception 'Service only' using errcode = '42501'; end if;
  for r in
    select s.id, s.owner_id from public.event_series s
    where s.status = 'active' and (p_series is null or s.id = p_series)
      and not exists (select 1 from public.suspensions su where su.user_id = s.owner_id)
      and not exists (select 1 from public.account_deletion_jobs j where j.user_id = s.owner_id)
    order by s.id
  loop
    if p_series is null then
      continue when not pg_try_advisory_xact_lock(hashtextextended('account_close:' || r.owner_id::text, 0));
      begin
        perform 1 from public.event_series where id = r.id for update nowait;
      exception when lock_not_available then
        continue;
      end;
    else
      perform pg_advisory_xact_lock(hashtextextended('account_close:' || r.owner_id::text, 0));
      perform 1 from public.event_series where id = r.id for update;
    end if;
    -- Rechecked under the locks: closure may have started while we waited.
    continue when exists (select 1 from public.account_deletion_jobs j where j.user_id = r.owner_id);
    n := n + findmaxxing_private.generate_for_series(r.id, v_now);
  end loop;
  return n;
end $$;
revoke all on function public.generate_series_occurrences(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.generate_series_occurrences(uuid, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- 8. Host functions. Every one: caller's account lock (require_active_account)
--    and the owner's, ascending; then the series row; then event rows
--    ascending; conversations last. The role is rechecked under the locks.
-- ----------------------------------------------------------------------------
-- The template fields a series accepts, validated the way the tables are.
create or replace function findmaxxing_private.series_patch_check(p jsonb)
returns void language plpgsql set search_path = public as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'events:bad_series' using errcode = 'P0001'; end if;
  if p ? 'rule' and not public.valid_series_rule(p -> 'rule') then raise exception 'events:bad_series_rule' using errcode = 'P0001'; end if;
  if p ? 'time_zone' and not public.valid_time_zone(p ->> 'time_zone') then raise exception 'events:bad_time_zone' using errcode = 'P0001'; end if;
  if p ? 'activity_details' and jsonb_typeof(p -> 'activity_details') not in ('null', 'object') then raise exception 'events:bad_activity' using errcode = 'P0001'; end if;
  if p ? 'activity_details' and not public.valid_activity_details(nullif(p -> 'activity_details', 'null'::jsonb)) then raise exception 'events:bad_activity' using errcode = 'P0001'; end if;
  if p ? 'tags' and jsonb_typeof(p -> 'tags') <> 'array' then raise exception 'events:bad_series' using errcode = 'P0001'; end if;
  if p ? 'place_id' and p ->> 'place_id' is not null and not public.can_view_place((p ->> 'place_id')::uuid) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
end $$;
revoke all on function findmaxxing_private.series_patch_check(jsonb) from public, anon, authenticated, service_role;

-- Creates the series, its owner row and tags, and the first four weeks.
create or replace function public.create_event_series(p_series jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
  v_today date;
begin
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.series_patch_check(p_series);
  if not (p_series ? 'rule') or not (p_series ? 'time_zone') then raise exception 'events:bad_series_rule' using errcode = 'P0001'; end if;
  perform public.check_rate_limit('events');
  v_today := (clock_timestamp() at time zone (p_series ->> 'time_zone'))::date;
  insert into public.event_series (
    owner_id, title, description, category_slug, place_id, location_name, address, lat, lng, time_zone, rule, starts_on, ends_on,
    capacity, min_attendance, decision_lead_minutes, activity_details
  ) values (
    auth.uid(), p_series ->> 'title', p_series ->> 'description', p_series ->> 'category_slug', (p_series ->> 'place_id')::uuid,
    p_series ->> 'location_name', p_series ->> 'address', (p_series ->> 'lat')::double precision, (p_series ->> 'lng')::double precision,
    p_series ->> 'time_zone', p_series -> 'rule', coalesce((p_series ->> 'starts_on')::date, v_today), (p_series ->> 'ends_on')::date,
    (p_series ->> 'capacity')::integer, (p_series ->> 'min_attendance')::integer, (p_series ->> 'decision_lead_minutes')::integer,
    nullif(nullif(p_series -> 'activity_details', 'null'::jsonb), '{}'::jsonb)
  ) returning * into s;
  if s.starts_on < v_today then raise exception 'events:bad_series_rule' using errcode = 'P0001'; end if;
  insert into public.event_series_hosts (series_id, user_id, role) values (s.id, auth.uid(), 'owner');
  insert into public.event_series_tags (series_id, interest_slug)
    select distinct s.id, x #>> '{}' from jsonb_array_elements(coalesce(p_series -> 'tags', '[]'::jsonb)) x;
  perform 1 from public.event_series where id = s.id for update;
  perform findmaxxing_private.generate_for_series(s.id, clock_timestamp());
  return s.id;
end $$;
revoke all on function public.create_event_series(jsonb) from public, anon;
grant execute on function public.create_event_series(jsonb) to authenticated;

-- Locks for one occurrence's host functions: actor and owner accounts, then
-- the event. Returns the locked row; raises when the caller is not a current
-- host or the row is not an open future occurrence.
create or replace function findmaxxing_private.lock_occurrence_for_host(p_event uuid, p_now timestamptz)
returns public.events language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.lock_event_actors(p_event);
  select * into e from public.events where id = p_event for update;
  if not found or e.series_id is null or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= p_now then
    raise exception 'events:closed' using errcode = 'P0001';
  end if;
  return e;
end $$;
revoke all on function findmaxxing_private.lock_occurrence_for_host(uuid, timestamptz) from public, anon, authenticated, service_role;

-- Edit this occurrence only. Changed template fields are recorded in
-- overridden so later template edits leave them alone. A time change records
-- 'schedule'. Material changes reach the people going through the existing
-- trigger (A1.5); this function sends nothing itself.
create or replace function public.update_occurrence(p_event uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  v_now timestamptz;
  v_over text[];
  v_starts timestamptz;
  v_ends timestamptz;
  v_explicit boolean := false;
begin
  v_now := clock_timestamp();
  e := findmaxxing_private.lock_occurrence_for_host(p_event, v_now);
  perform findmaxxing_private.series_patch_check(p_patch);
  if p_patch ? 'rule' or p_patch ? 'time_zone' then raise exception 'events:bad_series' using errcode = 'P0001'; end if;
  v_over := e.overridden;
  v_starts := coalesce((p_patch ->> 'starts_at')::timestamptz, e.starts_at);
  v_ends := case when p_patch ? 'ends_at' then (p_patch ->> 'ends_at')::timestamptz else e.ends_at end;
  if p_patch ? 'starts_at' or p_patch ? 'ends_at' then v_over := array_append(array_remove(v_over, 'schedule'), 'schedule'); end if;
  if p_patch ? 'title' or p_patch ? 'description' then v_over := array_append(array_remove(v_over, 'details'), 'details'); end if;
  if p_patch ? 'place_id' or p_patch ? 'location_name' or p_patch ? 'address' or p_patch ? 'lat' or p_patch ? 'lng' then v_over := array_append(array_remove(v_over, 'venue'), 'venue'); end if;
  if p_patch ? 'category_slug' then v_over := array_append(array_remove(v_over, 'category'), 'category'); end if;
  if p_patch ? 'capacity' then v_over := array_append(array_remove(v_over, 'capacity'), 'capacity'); end if;
  if p_patch ? 'min_attendance' or p_patch ? 'decision_deadline' or p_patch ? 'venue_status' then
    v_over := array_append(array_remove(v_over, 'session_rules'), 'session_rules'); v_explicit := true;
  end if;
  if p_patch ? 'activity_details' then v_over := array_append(array_remove(v_over, 'activity'), 'activity'); end if;
  if p_patch ? 'tags' then v_over := array_append(array_remove(v_over, 'tags'), 'tags'); end if;
  if v_explicit then perform set_config('findmaxxing.session_rules', 'explicit', true); end if;
  perform set_config('findmaxxing.series_write', 'on', true);
  update public.events set
    title = coalesce(p_patch ->> 'title', title),
    description = coalesce(p_patch ->> 'description', description),
    place_id = case when p_patch ? 'place_id' then (p_patch ->> 'place_id')::uuid else place_id end,
    location_name = coalesce(p_patch ->> 'location_name', location_name),
    address = case when p_patch ? 'address' then p_patch ->> 'address' else address end,
    lat = coalesce((p_patch ->> 'lat')::double precision, lat),
    lng = coalesce((p_patch ->> 'lng')::double precision, lng),
    category_slug = coalesce(p_patch ->> 'category_slug', category_slug),
    capacity = case when p_patch ? 'capacity' then (p_patch ->> 'capacity')::integer else capacity end,
    min_attendance = case when p_patch ? 'min_attendance' then (p_patch ->> 'min_attendance')::integer else min_attendance end,
    decision_deadline = case when p_patch ? 'decision_deadline' then (p_patch ->> 'decision_deadline')::timestamptz else decision_deadline end,
    venue_status = coalesce(p_patch ->> 'venue_status', venue_status),
    activity_details = case when p_patch ? 'activity_details' then nullif(nullif(p_patch -> 'activity_details', 'null'::jsonb), '{}'::jsonb) else activity_details end,
    starts_at = v_starts, ends_at = v_ends, overridden = v_over
  where id = p_event;
  if p_patch ? 'tags' then
    delete from public.event_tags where event_id = p_event;
    insert into public.event_tags (event_id, interest_slug) select distinct p_event, x #>> '{}' from jsonb_array_elements(p_patch -> 'tags') x;
  end if;
  perform set_config('findmaxxing.series_write', 'off', true);
  perform set_config('findmaxxing.session_rules', 'off', true);
end $$;
revoke all on function public.update_occurrence(uuid, jsonb) from public, anon;
grant execute on function public.update_occurrence(uuid, jsonb) to authenticated;

-- Cancel this occurrence only. The generator never recreates its date.
create or replace function public.cancel_occurrence(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  e := findmaxxing_private.lock_occurrence_for_host(p_event, clock_timestamp());
  perform set_config('findmaxxing.series_write', 'on', true);
  update public.events set status = 'cancelled', cancel_reason = 'host' where id = p_event;
  perform set_config('findmaxxing.series_write', 'off', true);
end $$;
revoke all on function public.cancel_occurrence(uuid) from public, anon;
grant execute on function public.cancel_occurrence(uuid) to authenticated;

-- Edit this and future occurrences (A1.4). Template fields apply from this
-- occurrence's date on, skipping each occurrence's overridden fields. A rule
-- change is planned read-only under the locks and applied only when the plan
-- is conflict-free. Returns what happened, for the host.
create or replace function public.update_series_from(p_event uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  seen record;
  s public.event_series%rowtype;
  e public.events%rowtype;
  v_now timestamptz;
  v_from date;
  v_today date;
  v_horizon date;
  v_schedule boolean;
  v_rule jsonb;
  v_locked uuid[];
  r record;
  -- plan
  retained date[] := '{}';
  del_ids uuid[] := '{}';
  mov_ids uuid[] := '{}';
  mov_dates date[] := '{}';
  kept_ids uuid[] := '{}';
  cands date[];
  claimed date[];
  final date[];
  best date;
  c date;
  i integer;
  kept_date date;
  all_dates date[];
  moved_ids uuid[] := '{}';
  created integer := 0;
  capacity_kept uuid[] := '{}';
  v_start timestamptz;
  v_committed boolean;
begin
  -- Whose locks to take: read without locking, recheck after.
  select e2.id, e2.series_id, s2.owner_id into seen from public.events e2 join public.event_series s2 on s2.id = e2.series_id where e2.id = p_event;
  if not found then raise exception 'events:not_found' using errcode = 'P0002'; end if;
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.lock_accounts(array[auth.uid(), seen.owner_id]);
  select * into s from public.event_series where id = seen.series_id for update;
  if not found or not public.is_series_host(s.id, auth.uid()) then raise exception 'events:not_found' using errcode = 'P0002'; end if;
  if s.status not in ('active', 'paused') then raise exception 'events:closed' using errcode = 'P0001'; end if;
  if exists (select 1 from public.account_deletion_jobs j where j.user_id = s.owner_id) then raise exception 'account_deletion_in_progress' using errcode = 'P0001'; end if;
  perform findmaxxing_private.series_patch_check(p_patch);
  if p_patch ? 'time_zone' or p_patch ? 'starts_at' or p_patch ? 'ends_at' or p_patch ? 'decision_deadline' then raise exception 'events:bad_series' using errcode = 'P0001'; end if;
  -- Every future occurrence of the series, ascending id, then their conversations in the same order.
  select array_agg(id order by id) into v_locked from (select id from public.events where series_id = s.id and starts_at > clock_timestamp() order by id for update) locked;
  v_locked := coalesce(v_locked, '{}');
  select * into e from public.events where id = p_event;
  if e.series_id is distinct from s.id then raise exception 'events:not_found' using errcode = 'P0002'; end if;
  v_from := e.series_local_date;
  -- One clock, read after the locks.
  v_now := clock_timestamp();
  v_today := (v_now at time zone s.time_zone)::date;
  v_horizon := v_today + 28;
  v_schedule := p_patch ? 'rule' and (p_patch -> 'rule') is distinct from s.rule;
  v_rule := coalesce(p_patch -> 'rule', s.rule);

  perform set_config('findmaxxing.series_write', 'on', true);
  -- 1. The template.
  update public.event_series set
    title = coalesce(p_patch ->> 'title', title),
    description = coalesce(p_patch ->> 'description', description),
    category_slug = coalesce(p_patch ->> 'category_slug', category_slug),
    place_id = case when p_patch ? 'place_id' then (p_patch ->> 'place_id')::uuid else place_id end,
    location_name = coalesce(p_patch ->> 'location_name', location_name),
    address = case when p_patch ? 'address' then p_patch ->> 'address' else address end,
    lat = coalesce((p_patch ->> 'lat')::double precision, lat),
    lng = coalesce((p_patch ->> 'lng')::double precision, lng),
    capacity = case when p_patch ? 'capacity' then (p_patch ->> 'capacity')::integer else capacity end,
    min_attendance = case when p_patch ? 'min_attendance' then (p_patch ->> 'min_attendance')::integer else min_attendance end,
    decision_lead_minutes = case when p_patch ? 'decision_lead_minutes' then (p_patch ->> 'decision_lead_minutes')::integer else decision_lead_minutes end,
    activity_details = case when p_patch ? 'activity_details' then nullif(nullif(p_patch -> 'activity_details', 'null'::jsonb), '{}'::jsonb) else activity_details end,
    rule = v_rule,
    rule_version = rule_version + case when v_schedule then 1 else 0 end
  where id = s.id returning * into s;
  if p_patch ? 'tags' then
    delete from public.event_series_tags where series_id = s.id;
    insert into public.event_series_tags (series_id, interest_slug) select distinct s.id, x #>> '{}' from jsonb_array_elements(p_patch -> 'tags') x;
  end if;

  -- 2. Template fields on future occurrences from the effective date, skipping overrides.
  for r in select * from public.events where id = any(v_locked) and series_local_date >= v_from and status = 'published' order by id loop
    if r.series_local_date >= v_from then
      perform set_config('findmaxxing.session_rules', 'explicit', true);
      update public.events set
        title = case when 'details' = any(r.overridden) then title else s.title end,
        description = case when 'details' = any(r.overridden) then description else s.description end,
        category_slug = case when 'category' = any(r.overridden) then category_slug else s.category_slug end,
        place_id = case when 'venue' = any(r.overridden) then place_id else s.place_id end,
        location_name = case when 'venue' = any(r.overridden) then location_name else s.location_name end,
        address = case when 'venue' = any(r.overridden) then address else s.address end,
        lat = case when 'venue' = any(r.overridden) then lat else s.lat end,
        lng = case when 'venue' = any(r.overridden) then lng else s.lng end,
        activity_details = case when 'activity' = any(r.overridden) then activity_details else s.activity_details end,
        min_attendance = case when 'session_rules' = any(r.overridden) then min_attendance else s.min_attendance end,
        decision_deadline = case when 'session_rules' = any(r.overridden) then decision_deadline
                                 when s.decision_lead_minutes is null or s.min_attendance is null then null
                                 when starts_at - make_interval(mins => s.decision_lead_minutes) <= v_now then null
                                 else starts_at - make_interval(mins => s.decision_lead_minutes) end
      where id = r.id;
      perform set_config('findmaxxing.session_rules', 'off', true);
      if not ('capacity' = any(r.overridden)) and r.capacity is distinct from s.capacity then
        begin
          update public.events set capacity = s.capacity where id = r.id;
        exception when others then
          -- A1.2 rule 4: the floor refuses it; the occurrence keeps its capacity and is reported.
          if sqlerrm !~* 'capacity cannot be below' then raise; end if;
          capacity_kept := capacity_kept || r.id;
        end;
      end if;
      if p_patch ? 'tags' and not ('tags' = any(r.overridden)) then
        delete from public.event_tags where event_id = r.id;
        insert into public.event_tags (event_id, interest_slug) select r.id, t.interest_slug from public.event_series_tags t where t.series_id = s.id;
      end if;
    end if;
  end loop;

  -- 3. The schedule: plan, then apply.
  if v_schedule then
    -- Phase 1: classify under the locks. Rule c reads messages after the conversation lock.
    for r in select * from public.events where series_id = s.id order by id loop
      if not (r.id = any(v_locked)) or r.series_local_date < v_from or r.status <> 'published' or 'schedule' = any(r.overridden) then
        retained := retained || r.series_local_date;           -- stays where it is
        continue;
      end if;
      begin
        perform 1 from public.conversations c where c.event_id = r.id for update;
        v_committed := findmaxxing_private.occurrence_committed(r.id, v_now);
      exception when lock_not_available or deadlock_detected then
        v_committed := true;
      end;
      if v_committed then
        mov_ids := mov_ids || r.id; mov_dates := mov_dates || r.series_local_date;
      else
        del_ids := del_ids || r.id;                           -- its date is free
      end if;
    end loop;
    -- Assignment, recomputed each time an occurrence has no destination (its date then stays retained).
    loop
      select array_agg(d order by d) into cands from (
        select d from findmaxxing_private.series_dates(s.rule, s.starts_on, v_from, v_horizon) d
        where (s.ends_on is null or d <= s.ends_on) and not (d = any(retained))
          and findmaxxing_private.local_to_instant(d, (s.rule ->> 'start_local')::time, s.time_zone) > v_now) x;
      cands := coalesce(cands, '{}');
      claimed := '{}';
      final := array_fill(null::date, array[coalesce(cardinality(mov_ids), 0)]);
      kept_date := null;
      for i in 1 .. coalesce(cardinality(mov_ids), 0) loop
        if mov_dates[i] = any(cands) then final[i] := mov_dates[i]; claimed := claimed || mov_dates[i]; end if;
      end loop;
      for i in 1 .. coalesce(cardinality(mov_ids), 0) loop
        continue when final[i] is not null;
        best := null;
        foreach c in array cands loop
          continue when c = any(claimed) or abs(c - mov_dates[i]) > 6;
          if best is null or abs(c - mov_dates[i]) < abs(best - mov_dates[i])
             or (abs(c - mov_dates[i]) = abs(best - mov_dates[i]) and c > best) then best := c; end if;
        end loop;
        if best is null then kept_date := mov_dates[i]; kept_ids := kept_ids || mov_ids[i]; exit; end if;
        final[i] := best; claimed := claimed || best;
      end loop;
      exit when kept_date is null;
      -- Kept exactly as it is; its date is retained; the rest is recomputed.
      retained := retained || kept_date;
      mov_ids := array_remove(mov_ids, kept_ids[cardinality(kept_ids)]);
      mov_dates := array_remove(mov_dates, kept_date);
    end loop;
    -- Check: every date that will exist afterwards is distinct.
    all_dates := retained || coalesce(final, '{}');
    if (select count(*) from unnest(all_dates) d) <> (select count(distinct d) from unnest(all_dates) d) then
      raise exception 'events:schedule_conflict' using errcode = 'P0001';
    end if;
    -- Phase 2: apply.
    delete from public.events where id = any(del_ids);
    update public.events set series_local_date = null where id = any(mov_ids);
    for i in 1 .. coalesce(cardinality(mov_ids), 0) loop
      v_start := findmaxxing_private.local_to_instant(final[i], (s.rule ->> 'start_local')::time, s.time_zone);
      if final[i] <> mov_dates[i] or v_start <> (select starts_at from public.events where id = mov_ids[i]) then moved_ids := moved_ids || mov_ids[i]; end if;
      update public.events set series_local_date = final[i], starts_at = v_start,
        ends_at = v_start + make_interval(mins => (s.rule ->> 'duration_minutes')::int)
      where id = mov_ids[i];
    end loop;
    update public.events set overridden = array_append(overridden, 'schedule') where id = any(kept_ids) and not ('schedule' = any(overridden));
    created := findmaxxing_private.generate_for_series(s.id, v_now, v_from);
    perform set_config('findmaxxing.series_write', 'on', true);
    if exists (select 1 from public.events where series_id = s.id and series_local_date is null) then
      raise exception 'events:schedule_conflict' using errcode = 'P0001';
    end if;
  else
    created := findmaxxing_private.generate_for_series(s.id, v_now);
    perform set_config('findmaxxing.series_write', 'on', true);
  end if;
  perform set_config('findmaxxing.series_write', 'off', true);
  return jsonb_build_object(
    'rule_version', s.rule_version,
    'moved', to_jsonb(moved_ids),
    'kept', to_jsonb(kept_ids),
    'deleted', coalesce(cardinality(del_ids), 0),
    'created', created,
    'capacity_kept', to_jsonb(capacity_kept));
end $$;
revoke all on function public.update_series_from(uuid, jsonb) from public, anon;
grant execute on function public.update_series_from(uuid, jsonb) to authenticated;

-- Owner-only series settings: end it (later occurrences are cancelled with
-- series_ended; refunds and attendee notifications follow the existing
-- paths), pause or resume generation, and the backup hosts.
create or replace function findmaxxing_private.lock_series_for_owner(p_series uuid)
returns public.event_series language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  select * into s from public.event_series where id = p_series for update;
  if not found or s.owner_id is distinct from auth.uid() then raise exception 'events:not_found' using errcode = 'P0002'; end if;
  if s.status = 'removed' then raise exception 'events:closed' using errcode = 'P0001'; end if;
  return s;
end $$;
revoke all on function findmaxxing_private.lock_series_for_owner(uuid) from public, anon, authenticated, service_role;

create or replace function public.end_event_series(p_series uuid, p_ends_on date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
  v_on date;
  n integer := 0;
begin
  s := findmaxxing_private.lock_series_for_owner(p_series);
  if s.status = 'ended' then return 0; end if;
  v_on := coalesce(p_ends_on, (clock_timestamp() at time zone s.time_zone)::date);
  if v_on < s.starts_on then v_on := s.starts_on; end if;
  update public.event_series set status = 'ended', ends_on = v_on where id = s.id;
  perform 1 from public.events where series_id = s.id and series_local_date > v_on and status = 'published' order by id for update;
  perform set_config('findmaxxing.series_write', 'on', true);
  update public.events set status = 'cancelled', cancel_reason = 'series_ended'
    where series_id = s.id and series_local_date > v_on and status = 'published' and starts_at > now();
  get diagnostics n = row_count;
  perform set_config('findmaxxing.series_write', 'off', true);
  return n;
end $$;
revoke all on function public.end_event_series(uuid, date) from public, anon;
grant execute on function public.end_event_series(uuid, date) to authenticated;

create or replace function public.set_series_status(p_series uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
begin
  if p_status not in ('active', 'paused') then raise exception 'events:bad_series' using errcode = 'P0001'; end if;
  s := findmaxxing_private.lock_series_for_owner(p_series);
  if s.status = 'ended' then raise exception 'events:closed' using errcode = 'P0001'; end if;
  update public.event_series set status = p_status where id = s.id;
  if p_status = 'active' then perform findmaxxing_private.generate_for_series(s.id, clock_timestamp()); end if;
end $$;
revoke all on function public.set_series_status(uuid, text) from public, anon;
grant execute on function public.set_series_status(uuid, text) to authenticated;

create or replace function public.add_series_host(p_series uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
begin
  s := findmaxxing_private.lock_series_for_owner(p_series);
  if p_user is null or p_user = s.owner_id or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'events:bad_series' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.suspensions where user_id = p_user) or exists (select 1 from public.account_deletion_jobs where user_id = p_user) then
    raise exception 'events:bad_series' using errcode = 'P0001';
  end if;
  insert into public.event_series_hosts (series_id, user_id, role) values (s.id, p_user, 'backup') on conflict do nothing;
end $$;
revoke all on function public.add_series_host(uuid, uuid) from public, anon;
grant execute on function public.add_series_host(uuid, uuid) to authenticated;

-- Revocation takes effect at once: every host function and the owner guard
-- re-read event_series_hosts under their locks.
create or replace function public.remove_series_host(p_series uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
begin
  s := findmaxxing_private.lock_series_for_owner(p_series);
  delete from public.event_series_hosts where series_id = s.id and user_id = p_user and role = 'backup';
end $$;
revoke all on function public.remove_series_host(uuid, uuid) from public, anon;
grant execute on function public.remove_series_host(uuid, uuid) to authenticated;

-- Host-recorded attendance after the occurrence ends (4.0 §4). Never inferred
-- from RSVP, and never a person's own statement (A1.4: not R4).
create or replace function public.record_attendance(p_event uuid, p_user uuid, p_attended boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform findmaxxing_private.lock_event_actors(p_event);
  select * into e from public.events where id = p_event for update;
  if not found or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) > now() then
    raise exception 'events:not_ended' using errcode = 'P0001';
  end if;
  update public.event_attendees set attended = p_attended where event_id = p_event and user_id = p_user;
  if not found then raise exception 'events:not_attending' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.record_attendance(uuid, uuid, boolean) from public, anon;
grant execute on function public.record_attendance(uuid, uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 9. Moderation (D-J): a series can be removed and restored; removing it
--    removes its future published occurrences, restoring it brings exactly
--    those back. As in 0020, plus the series target.
-- ----------------------------------------------------------------------------
alter table public.moderation_actions drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check check (target_type in ('place', 'event', 'profile', 'message', 'series'));

create or replace function public.moderate_target(
  p_target_type text, p_target_id uuid, p_action text, p_reason text default null
) returns table (status_after text, resolved_reports integer)
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before text;
  v_after text;
  v_report_status text;
  v_resolved integer;
begin
  if not public.is_moderator() then raise exception 'Moderators only' using errcode = '42501'; end if;
  if p_target_type not in ('place', 'event', 'profile', 'message', 'series') then raise exception 'moderation:invalid_target' using errcode = 'P0001'; end if;
  if p_action not in ('dismiss', 'review', 'remove', 'restore') then raise exception 'moderation:invalid_action' using errcode = 'P0001'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'moderation:reason_too_long' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('moderation:' || p_target_type || ':' || p_target_id::text, 0));
  if p_target_type = 'place' then
    select p.status into v_before from public.places p where p.id = p_target_id for update;
  elsif p_target_type = 'event' then
    select e.status into v_before from public.events e where e.id = p_target_id for update;
  elsif p_target_type = 'message' then
    select case when m.removed_at is null then 'published' else 'removed' end into v_before from public.messages m where m.id = p_target_id for update;
  elsif p_target_type = 'series' then
    select case when s.status = 'removed' then 'removed' else 'published' end into v_before from public.event_series s where s.id = p_target_id for update;
  else
    perform 1 from public.profiles pr where pr.id = p_target_id;
  end if;
  if not found then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;

  v_after := v_before;
  if p_action = 'remove' then
    if p_target_type = 'profile' then raise exception 'moderation:cannot_remove_profile' using errcode = 'P0001'; end if;
    if v_before = 'removed' then raise exception 'moderation:already_removed' using errcode = 'P0001'; end if;
    if v_reason is null then raise exception 'moderation:reason_required' using errcode = 'P0001'; end if;
    v_after := 'removed'; v_report_status := 'reviewed';
  elsif p_action = 'restore' then
    if v_before is distinct from 'removed' then raise exception 'moderation:not_removed' using errcode = 'P0001'; end if;
    v_after := 'published'; v_report_status := 'dismissed';
  elsif p_action = 'dismiss' then
    v_report_status := 'dismissed';
  else
    v_report_status := 'reviewed';
  end if;

  update public.reports r set status = v_report_status, resolved_at = now()
   where r.target_type = p_target_type and r.target_id = p_target_id and r.status = 'open';
  get diagnostics v_resolved = row_count;
  if p_action in ('dismiss', 'review') and v_resolved = 0 then raise exception 'moderation:nothing_open' using errcode = 'P0001'; end if;

  if v_after is distinct from v_before then
    perform set_config('findmaxxing.moderation', 'on', true);
    if p_target_type = 'place' then
      update public.places set status = v_after where id = p_target_id;
    elsif p_target_type = 'event' then
      update public.events set status = v_after where id = p_target_id;
    elsif p_target_type = 'series' then
      if v_after = 'removed' then
        update public.event_series set status = 'removed' where id = p_target_id;
        perform 1 from public.events where series_id = p_target_id and status = 'published' and starts_at > now() order by id for update;
        update public.events set status = 'removed', removed_with_series = true
          where series_id = p_target_id and status = 'published' and starts_at > now();
      else
        update public.event_series set status = case when ends_on is not null and ends_on < (now() at time zone time_zone)::date then 'ended' else 'active' end where id = p_target_id;
        perform 1 from public.events where series_id = p_target_id and status = 'removed' and removed_with_series order by id for update;
        update public.events set status = 'published', removed_with_series = false
          where series_id = p_target_id and status = 'removed' and removed_with_series and starts_at > now();
        update public.events set removed_with_series = false where series_id = p_target_id and removed_with_series;
      end if;
    else
      update public.messages set removed_at = case when v_after = 'removed' then now() else null end where id = p_target_id;
    end if;
    perform set_config('findmaxxing.moderation', 'off', true);
  end if;

  insert into public.moderation_actions (moderator_id, action, target_type, target_id, reason, status_before, status_after, resolved_reports)
  values (auth.uid(), p_action, p_target_type, p_target_id, v_reason, v_before, v_after, v_resolved);
  return query select v_after, v_resolved;
end $$;

-- ----------------------------------------------------------------------------
-- 10. Checks that fail the migration if an assumption stops holding
-- ----------------------------------------------------------------------------
do $$
declare names text[]; v text;
begin
  -- The statement-level account locks are in place on the three legacy-write tables.
  select array_agg(t.tgname::text order by t.tgname) into names from pg_trigger t
   where not t.tgisinternal and (t.tgtype & 1) = 0 and t.tgname in ('events_a_lock_actor', 'event_attendees_a_lock_actor', 'event_tags_a_lock_actor');
  if names is distinct from array['event_attendees_a_lock_actor', 'event_tags_a_lock_actor', 'events_a_lock_actor'] then
    raise exception 'statement-level account lock triggers missing: %', names;
  end if;
  -- The direct join still takes its account lock before the event lock in the row triggers (0053).
  select array_agg(t.tgname::text order by t.tgname) into names from pg_trigger t
   where t.tgrelid = 'public.event_attendees'::regclass and not t.tgisinternal
     and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 1) = 1
     and t.tgname in ('event_attendees_block_suspended', 'event_attendees_check_join');
  if names is distinct from array['event_attendees_block_suspended', 'event_attendees_check_join'] then
    raise exception 'event_attendees insert triggers are missing or out of order: %', names;
  end if;
  -- The shared DST vector (D-G): SQL agrees with packages/shared/src/timezone.ts.
  if findmaxxing_private.local_to_instant('2026-03-08', '02:30', 'America/New_York') <> '2026-03-08T07:30:00Z'::timestamptz then
    raise exception 'spring-forward vector failed';
  end if;
  if findmaxxing_private.local_to_instant('2026-11-01', '01:30', 'America/New_York') <> '2026-11-01T05:30:00Z'::timestamptz then
    raise exception 'fall-back first-instant vector failed';
  end if;
  -- No API role can write the series tables or the new event columns directly.
  for v in select unnest(array['event_series', 'event_series_tags', 'event_series_hosts']) loop
    if has_table_privilege('authenticated', 'public.' || v, 'insert') or has_table_privilege('authenticated', 'public.' || v, 'update') or has_table_privilege('authenticated', 'public.' || v, 'delete') then
      raise exception 'authenticated can write %', v;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'public.events', 'series_id', 'update') or has_column_privilege('authenticated', 'public.events', 'series_local_date', 'update')
     or has_column_privilege('authenticated', 'public.events', 'overridden', 'update') then
    raise exception 'authenticated can update series columns on events';
  end if;
end $$;
