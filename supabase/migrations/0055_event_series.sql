-- Roadmap 4.5a: recurring series, hosts and host tools (4.0 spec §3, §4, §8, §10, §14; batch 4.5a).
--
-- An occurrence is a row in events (D-A): series_id + series_local_date, unique per series, so concurrent
-- generator runs cannot duplicate a date and a cancelled date is never recreated. Occurrences are
-- materialized 4 weeks ahead only (D-C). Series store local wall-clock time + an IANA zone; each start is
-- resolved explicitly (spring gap → the same clock reading in the earlier offset; fall-back repeat →
-- the FIRST instant, matching the app's zonedTimeToUtc, D-G).
--
-- Backup hosts act only through RPCs that re-check is_series_host(), so revoking a host is immediate.
-- Following a series is updates only: nothing here ever creates an attendee or participant row.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.event_series (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  owner_id              uuid not null references public.profiles (id) on delete cascade,
  title                 text not null check (char_length(title) between 3 and 90),
  description           text not null check (char_length(description) between 10 and 1200),
  category_slug         text not null references public.categories (slug),
  place_id              uuid references public.places (id) on delete set null,
  location_name         text not null check (char_length(location_name) between 1 and 120),
  address               text check (address is null or char_length(address) <= 200),
  lat                   double precision not null check (lat between -90 and 90),
  lng                   double precision not null check (lng between -180 and 180),
  time_zone             text not null check (char_length(time_zone) <= 64),
  -- Structured weekly rule, not free-form RRULE (§3).
  freq                  text not null default 'weekly' check (freq = 'weekly'),
  interval_weeks        integer not null default 1 check (interval_weeks between 1 and 4),
  weekdays              integer[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]),
  start_local           time not null,
  duration_minutes      integer not null check (duration_minutes between 15 and 720),
  starts_on             date not null,
  ends_on               date check (ends_on is null or ends_on >= starts_on),
  capacity              integer check (capacity is null or capacity between 2 and 5000),
  min_attendance        integer check (min_attendance is null or (min_attendance >= 2 and (capacity is null or min_attendance <= capacity))),
  decision_lead_minutes integer check (decision_lead_minutes is null or decision_lead_minutes between 15 and 10080),
  activity_details      jsonb check (public.valid_activity_details(activity_details)),
  newcomer              jsonb check (public.valid_event_newcomer(newcomer)),
  card_style            text not null default 'readiness' check (card_style in ('readiness', 'party_poster')),
  status                text not null default 'active' check (status in ('active', 'paused', 'ended', 'removed')),
  rule_version          integer not null default 1
);
create index if not exists event_series_owner_idx on public.event_series (owner_id);

create table if not exists public.event_series_tags (
  series_id     uuid not null references public.event_series (id) on delete cascade,
  interest_slug text not null references public.interests (slug),
  primary key (series_id, interest_slug)
);

create table if not exists public.event_series_hosts (
  series_id  uuid not null references public.event_series (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('owner', 'backup')),
  added_at   timestamptz not null default now(),
  primary key (series_id, user_id)
);
create unique index if not exists event_series_one_owner on public.event_series_hosts (series_id) where role = 'owner';

create table if not exists public.event_series_followers (
  series_id  uuid not null references public.event_series (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (series_id, user_id)
);

alter table public.events
  add column if not exists series_id uuid references public.event_series (id) on delete set null,
  add column if not exists series_local_date date,
  add column if not exists overridden text[] not null default '{}';
create unique index if not exists events_series_date_idx on public.events (series_id, series_local_date) where series_id is not null;

-- Attendance (4.5b history): set by a host after the occurrence ends; never inferred.
alter table public.event_attendees add column if not exists attended boolean;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_series_host(p_series uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_series is not null and p_user is not null
    and exists (select 1 from public.event_series_hosts h where h.series_id = p_series and h.user_id = p_user)
$$;
revoke all on function public.is_series_host(uuid, uuid) from public, anon, authenticated;

-- Hosts of an occurrence: its creator, or any host of its series.
create or replace function public.is_event_host(p_event uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.events e where e.id = p_event
    and (e.creator_id = p_user or public.is_series_host(e.series_id, p_user)))
$$;
revoke all on function public.is_event_host(uuid, uuid) from public, anon, authenticated;

create or replace function public.can_view_series(p_series uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.event_series s where s.id = p_series and (
    (s.status <> 'removed' and (s.place_id is null or public.can_view_place(s.place_id)))
    or (s.status <> 'removed' and public.is_series_host(s.id, auth.uid()))))
$$;
revoke all on function public.can_view_series(uuid) from public;
grant execute on function public.can_view_series(uuid) to anon, authenticated, service_role;

-- Wall-clock date + time in a zone → instant. Spring gap: Postgres gives the same clock reading in the
-- earlier offset (02:30 → 03:30 EDT), as the app does. Fall-back repeat: Postgres gives the SECOND
-- instant; we take the FIRST, as the app's zonedTimeToUtc does (D-G).
create or replace function public.local_to_instant(p_date date, p_time time, p_zone text)
returns timestamptz language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_local timestamp := p_date + p_time;
  v_at timestamptz := v_local at time zone p_zone;
begin
  if ((v_at - interval '1 hour') at time zone p_zone) = v_local then
    return v_at - interval '1 hour';
  end if;
  return v_at;
end $$;

create or replace function public.check_series_time_zone()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform now() at time zone new.time_zone;
  new.updated_at := now();
  return new;
exception when others then
  raise exception 'Unknown time zone' using errcode = '22023';
end $$;
drop trigger if exists event_series_check on public.event_series;
create trigger event_series_check before insert or update on public.event_series
  for each row execute function public.check_series_time_zone();

-- ---------------------------------------------------------------------------
-- RLS (§14)
-- ---------------------------------------------------------------------------
alter table public.event_series enable row level security;
alter table public.event_series_tags enable row level security;
alter table public.event_series_hosts enable row level security;
alter table public.event_series_followers enable row level security;

drop policy if exists "visible series" on public.event_series;
create policy "visible series" on public.event_series for select using (public.can_view_series(id));
drop policy if exists "visible series tags" on public.event_series_tags;
create policy "visible series tags" on public.event_series_tags for select using (public.can_view_series(series_id));
drop policy if exists "visible series hosts" on public.event_series_hosts;
create policy "visible series hosts" on public.event_series_hosts for select using (public.can_view_series(series_id));
drop policy if exists "own follows" on public.event_series_followers;
create policy "own follows" on public.event_series_followers for select using (user_id = auth.uid());
revoke insert, update, delete, truncate on public.event_series, public.event_series_tags, public.event_series_hosts, public.event_series_followers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Generation (§3; D-C 4 weeks)
-- ---------------------------------------------------------------------------
create or replace function public.series_dates(s public.event_series, p_from date, p_to date)
returns setof date language sql stable set search_path = public, pg_temp as $$
  select d::date from generate_series(greatest(p_from, s.starts_on), least(p_to, coalesce(s.ends_on, p_to)), interval '1 day') d
  where extract(isodow from d)::integer = any(s.weekdays)
    and ((((d::date - (s.starts_on - (extract(isodow from s.starts_on)::integer - 1))) / 7) % s.interval_weeks) = 0)
$$;

create or replace function public.generate_series_occurrences(p_series uuid default null, p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.event_series%rowtype;
  d date;
  v_start timestamptz;
  v_id uuid;
  v_n integer := 0;
begin
  for s in select * from public.event_series where status = 'active' and (p_series is null or id = p_series) loop
    for d in select * from public.series_dates(s, (p_now at time zone s.time_zone)::date, (p_now at time zone s.time_zone)::date + 28) loop
      v_start := public.local_to_instant(d, s.start_local, s.time_zone);
      continue when v_start <= p_now;
      insert into public.events (title, description, place_id, location_name, address, lat, lng, starts_at, ends_at,
        creator_id, category_slug, capacity, time_zone, activity_details, newcomer, card_style, min_attendance,
        decision_deadline, series_id, series_local_date)
      values (s.title, s.description, s.place_id, s.location_name, s.address, s.lat, s.lng, v_start,
        v_start + make_interval(mins => s.duration_minutes), s.owner_id, s.category_slug, s.capacity, s.time_zone,
        s.activity_details, s.newcomer, s.card_style, s.min_attendance,
        case when s.min_attendance is not null and s.decision_lead_minutes is not null then v_start - make_interval(mins => s.decision_lead_minutes) end,
        s.id, d)
      on conflict (series_id, series_local_date) where series_id is not null do nothing
      returning id into v_id;
      if v_id is not null then
        insert into public.event_tags (event_id, interest_slug) select v_id, t.interest_slug from public.event_series_tags t where t.series_id = s.id;
        v_n := v_n + 1;
        v_id := null;
      end if;
    end loop;
  end loop;
  return v_n;
end $$;
revoke all on function public.generate_series_occurrences(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.generate_series_occurrences(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Host tools (RPCs)
-- ---------------------------------------------------------------------------
create or replace function public.create_series(
  p_title text, p_description text, p_category_slug text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_time_zone text, p_weekdays integer[], p_interval_weeks integer,
  p_start_local time, p_duration_minutes integer, p_starts_on date, p_ends_on date, p_capacity integer,
  p_min_attendance integer, p_decision_lead_minutes integer, p_activity_details jsonb, p_newcomer jsonb,
  p_card_style text, p_tags text[]
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  v_id uuid;
begin
  if p_place_id is not null and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  perform public.check_rate_limit('events');
  insert into public.event_series (owner_id, title, description, category_slug, place_id, location_name, address, lat, lng,
    time_zone, weekdays, interval_weeks, start_local, duration_minutes, starts_on, ends_on, capacity, min_attendance,
    decision_lead_minutes, activity_details, newcomer, card_style)
  values (v_uid, p_title, p_description, p_category_slug, p_place_id, p_location_name, p_address, p_lat, p_lng,
    p_time_zone, (select array_agg(distinct w order by w) from unnest(p_weekdays) w), coalesce(p_interval_weeks, 1),
    p_start_local, p_duration_minutes, p_starts_on, p_ends_on, p_capacity, p_min_attendance, p_decision_lead_minutes,
    p_activity_details, p_newcomer, coalesce(p_card_style, 'readiness'))
  returning id into v_id;
  insert into public.event_series_hosts (series_id, user_id, role) values (v_id, v_uid, 'owner');
  insert into public.event_series_tags (series_id, interest_slug) select v_id, t from unnest(coalesce(p_tags, '{}')) t on conflict do nothing;
  -- Generated occurrences are the system's writes, not the caller's: they do not each count against the
  -- caller's daily event limit (creating the series counted once, above).
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.generate_series_occurrences(v_id, now());
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  return v_id;
end $$;

-- Edit this occurrence only (§8): any host; changed template fields are recorded in `overridden`.
create or replace function public.update_occurrence(
  p_event uuid, p_title text, p_description text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz, p_capacity integer
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  v_over text[];
begin
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_host(p_event, v_uid) then raise exception 'You do not host this event' using errcode = '42501'; end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'Only future published events can be edited' using errcode = 'P0001';
  end if;
  if p_place_id is not null and p_place_id is distinct from e.place_id and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  v_over := e.overridden;
  if p_title is distinct from e.title then v_over := array_append(v_over, 'title'); end if;
  if p_description is distinct from e.description then v_over := array_append(v_over, 'description'); end if;
  if (p_place_id, p_location_name, p_address, p_lat, p_lng) is distinct from (e.place_id, e.location_name, e.address, e.lat, e.lng) then v_over := array_append(v_over, 'venue'); end if;
  if (p_starts_at, p_ends_at) is distinct from (e.starts_at, e.ends_at) then v_over := array_append(v_over, 'time'); end if;
  if p_capacity is distinct from e.capacity then v_over := array_append(v_over, 'capacity'); end if;
  -- The definer acts for the host: the owner guard checks creator_id against auth.uid(), so run it as
  -- the owner (a backup host is allowed here by is_event_host, re-checked above).
  perform set_config('request.jwt.claim.sub', coalesce(e.creator_id::text, ''), true);
  update public.events set title = p_title, description = p_description, place_id = p_place_id,
    location_name = p_location_name, address = p_address, lat = p_lat, lng = p_lng, starts_at = p_starts_at,
    ends_at = p_ends_at, capacity = p_capacity,
    overridden = case when series_id is null then '{}' else (select coalesce(array_agg(distinct x order by x), '{}') from unnest(v_over) x) end
  where id = p_event;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
end $$;

-- Edit this and future (§8): the template changes from this occurrence's local date; future occurrences
-- on or after it take the change except fields they override. A schedule change bumps rule_version:
-- future occurrences with nobody else involved are deleted and regenerated; ones with people keep their
-- id, date, attendees, tickets and chat and get the new time (a material change).
create or replace function public.update_series_from(
  p_event uuid, p_title text, p_description text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_weekdays integer[], p_interval_weeks integer, p_start_local time,
  p_duration_minutes integer, p_capacity integer
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  s public.event_series%rowtype;
  o public.events%rowtype;
  v_schedule boolean;
  v_start timestamptz;
  v_n integer := 0;
begin
  select * into e from public.events where id = p_event for update;
  if not found or e.series_id is null then raise exception 'Not a series occurrence' using errcode = 'P0002'; end if;
  if not public.is_series_host(e.series_id, v_uid) then raise exception 'You do not host this series' using errcode = '42501'; end if;
  select * into s from public.event_series where id = e.series_id for update;
  if s.status not in ('active', 'paused') then raise exception 'This series has ended' using errcode = 'P0001'; end if;
  if p_place_id is not null and p_place_id is distinct from s.place_id and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  v_schedule := (select array_agg(distinct w order by w) from unnest(p_weekdays) w) is distinct from s.weekdays
    or coalesce(p_interval_weeks, 1) <> s.interval_weeks or p_start_local <> s.start_local or p_duration_minutes <> s.duration_minutes;
  update public.event_series set title = p_title, description = p_description, place_id = p_place_id,
    location_name = p_location_name, address = p_address, lat = p_lat, lng = p_lng,
    weekdays = (select array_agg(distinct w order by w) from unnest(p_weekdays) w), interval_weeks = coalesce(p_interval_weeks, 1),
    start_local = p_start_local, duration_minutes = p_duration_minutes, capacity = p_capacity,
    rule_version = rule_version + (case when v_schedule then 1 else 0 end)
  where id = s.id returning * into s;

  perform set_config('request.jwt.claim.sub', s.owner_id::text, true);
  for o in select * from public.events
           where series_id = s.id and series_local_date >= e.series_local_date and status = 'published' and starts_at > now()
           order by series_local_date for update loop
    if v_schedule and not exists (select 1 from public.event_attendees a where a.event_id = o.id)
       and not exists (select 1 from public.event_participants p where p.event_id = o.id and p.status in ('waitlisted', 'offered'))
       and not exists (select 1 from public.tickets t where t.event_id = o.id)
       and not exists (select 1 from public.messages m join public.conversations c on c.id = m.conversation_id where c.event_id = o.id) then
      delete from public.events where id = o.id;
      continue;
    end if;
    v_start := case when v_schedule and not ('time' = any(o.overridden)) then public.local_to_instant(o.series_local_date, s.start_local, s.time_zone) else o.starts_at end;
    update public.events set
      title = case when 'title' = any(o.overridden) then title else s.title end,
      description = case when 'description' = any(o.overridden) then description else s.description end,
      place_id = case when 'venue' = any(o.overridden) then place_id else s.place_id end,
      location_name = case when 'venue' = any(o.overridden) then location_name else s.location_name end,
      address = case when 'venue' = any(o.overridden) then address else s.address end,
      lat = case when 'venue' = any(o.overridden) then lat else s.lat end,
      lng = case when 'venue' = any(o.overridden) then lng else s.lng end,
      capacity = case when 'capacity' = any(o.overridden) then capacity else greatest(coalesce(s.capacity, 0), (select count(*) from public.event_attendees a where a.event_id = o.id)::integer) end,
      starts_at = v_start,
      ends_at = case when 'time' = any(o.overridden) then ends_at else v_start + make_interval(mins => s.duration_minutes) end,
      decision_deadline = case when decision_deadline is null or 'time' = any(o.overridden) then decision_deadline
                               when s.decision_lead_minutes is not null then v_start - make_interval(mins => s.decision_lead_minutes) end
    where id = o.id;
    v_n := v_n + 1;
  end loop;
  -- Keep "no capacity" when the template has none.
  if s.capacity is null then
    update public.events set capacity = null where series_id = s.id and series_local_date >= e.series_local_date and status = 'published' and starts_at > now() and not ('capacity' = any(overridden));
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform public.generate_series_occurrences(s.id, now());
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  return v_n;
end $$;

-- Cancel one occurrence (any host). The generator never recreates its date; the next one is untouched.
create or replace function public.cancel_occurrence(p_event uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_host(p_event, v_uid) then raise exception 'You do not host this event' using errcode = '42501'; end if;
  perform set_config('request.jwt.claim.sub', coalesce(e.creator_id::text, ''), true);
  update public.events set status = 'cancelled', cancel_reason = 'host' where id = p_event;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
end $$;

-- End the series (owner or backup host): no more occurrences; future ones after p_ends_on are cancelled.
create or replace function public.end_series(p_series uuid, p_ends_on date)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  s public.event_series%rowtype;
  v_n integer;
begin
  select * into s from public.event_series where id = p_series for update;
  if not found or not public.is_series_host(p_series, v_uid) then raise exception 'You do not host this series' using errcode = '42501'; end if;
  update public.event_series set status = 'ended', ends_on = greatest(starts_on, coalesce(p_ends_on, current_date)) where id = p_series returning * into s;
  perform set_config('request.jwt.claim.sub', s.owner_id::text, true);
  update public.events set status = 'cancelled', cancel_reason = 'series_ended'
    where series_id = p_series and status = 'published' and series_local_date > s.ends_on and starts_at > now();
  get diagnostics v_n = row_count;
  perform set_config('request.jwt.claim.sub', v_uid::text, true);
  return v_n;
end $$;

-- Backup hosts: the owner adds or removes them; removal takes effect at once.
create or replace function public.set_series_host(p_series uuid, p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if not exists (select 1 from public.event_series_hosts h where h.series_id = p_series and h.user_id = v_uid and h.role = 'owner') then
    raise exception 'Only the series owner manages hosts' using errcode = '42501';
  end if;
  if p_user = v_uid then raise exception 'The owner is always a host' using errcode = 'P0001'; end if;
  if p_on then
    if not exists (select 1 from public.profiles where id = p_user) then raise exception 'No such person' using errcode = 'P0002'; end if;
    insert into public.event_series_hosts (series_id, user_id, role) values (p_series, p_user, 'backup') on conflict do nothing;
  else
    delete from public.event_series_hosts where series_id = p_series and user_id = p_user and role = 'backup';
  end if;
end $$;

-- Follow = updates only (§9). Never creates an attendee or participant row.
create or replace function public.follow_series(p_series uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if not public.can_view_series(p_series) then raise exception 'Series not found' using errcode = 'P0002'; end if;
  if p_on then
    insert into public.event_series_followers (series_id, user_id) values (p_series, v_uid) on conflict do nothing;
  else
    delete from public.event_series_followers where series_id = p_series and user_id = v_uid;
  end if;
  return p_on;
end $$;

-- Attendance after an occurrence ends (any host). Never inferred from RSVP or directions.
create or replace function public.set_attended(p_event uuid, p_user uuid, p_attended boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
begin
  select * into e from public.events where id = p_event;
  if not found or not public.is_event_host(p_event, v_uid) then raise exception 'You do not host this event' using errcode = '42501'; end if;
  if coalesce(e.ends_at, e.starts_at) > now() then raise exception 'Attendance is recorded after the event' using errcode = 'P0001'; end if;
  update public.event_attendees set attended = p_attended where event_id = p_event and user_id = p_user;
  if not found then raise exception 'That person was not going' using errcode = 'P0002'; end if;
end $$;

-- D-J: moderating a series cascades to its future occurrences.
create or replace function public.moderate_series(p_series uuid, p_remove boolean)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  if not public.is_moderator() then raise exception 'Moderators only' using errcode = '42501'; end if;
  perform set_config('findmaxxing.moderation', 'on', true);
  if p_remove then
    update public.event_series set status = 'removed' where id = p_series;
    update public.events set status = 'removed' where series_id = p_series and status in ('published', 'hidden') and starts_at > now();
  else
    update public.event_series set status = 'active' where id = p_series and status = 'removed';
    update public.events set status = 'published' where series_id = p_series and status = 'removed' and starts_at > now();
  end if;
  get diagnostics v_n = row_count;
  perform set_config('findmaxxing.moderation', 'off', true);
  return v_n;
end $$;

-- Series hosts (not only the creator) may confirm sessions and manage the waitlist (§3).
create or replace function public.confirm_session(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.events%rowtype;
  auth_uid_text text := coalesce(auth.uid()::text, '');
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_host(p_event, auth.uid()) then
    raise exception 'You do not own this event' using errcode = '42501';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'Only future published events can be confirmed' using errcode = 'P0001';
  end if;
  if e.decision = 'happening' then return 'happening'; end if;
  if e.decision_deadline is not null and e.decision_deadline <= clock_timestamp() then
    raise exception 'The decision deadline has passed' using errcode = 'P0001';
  end if;
  -- The owner guard checks creator_id against auth.uid(): act as the creator for a backup host.
  perform set_config('request.jwt.claim.sub', coalesce(e.creator_id::text, ''), true);
  update public.events set decision = 'happening' where id = p_event;
  perform set_config('request.jwt.claim.sub', auth_uid_text, true);
  return 'happening';
end $$;

create or replace function public.host_remove_participant(p_event uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  own public.event_participants%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found or not public.is_event_host(p_event, v_uid) then raise exception 'You do not host this event' using errcode = '42501'; end if;
  if p_user = e.creator_id then raise exception 'The host cannot remove themselves' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = p_user) then
    delete from public.event_attendees where event_id = p_event and user_id = p_user;
    return 'removed';
  end if;
  select * into own from public.event_participants where event_id = p_event and user_id = p_user for update;
  if found and own.status in ('waitlisted', 'offered') then
    update public.event_participants set status = 'left', reason = 'removed', offered_at = null, offer_expires_at = null
      where event_id = p_event and user_id = p_user;
    if own.status = 'offered' then perform public.offer_next(p_event); end if;
    return 'removed';
  end if;
  return 'none';
end $$;

-- Series hosts see the participant rows of their occurrences too (§14). The policy runs as the caller,
-- so it uses a caller-bound helper (no user argument) that API roles may execute.
create or replace function public.viewer_hosts_event(p_event uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and public.is_event_host(p_event, auth.uid())
$$;
revoke all on function public.viewer_hosts_event(uuid) from public;
grant execute on function public.viewer_hosts_event(uuid) to anon, authenticated, service_role;
drop policy if exists "own or hosted participant rows" on public.event_participants;
create policy "own or hosted participant rows" on public.event_participants for select
  using (user_id = auth.uid() or public.viewer_hosts_event(event_id));

revoke all on function public.create_series(text,text,text,uuid,text,text,double precision,double precision,text,integer[],integer,time,integer,date,date,integer,integer,integer,jsonb,jsonb,text,text[]) from public, anon;
revoke all on function public.update_occurrence(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,integer) from public, anon;
revoke all on function public.update_series_from(uuid,text,text,uuid,text,text,double precision,double precision,integer[],integer,time,integer,integer) from public, anon;
revoke all on function public.cancel_occurrence(uuid) from public, anon;
revoke all on function public.end_series(uuid, date) from public, anon;
revoke all on function public.set_series_host(uuid, uuid, boolean) from public, anon;
revoke all on function public.follow_series(uuid, boolean) from public, anon;
revoke all on function public.set_attended(uuid, uuid, boolean) from public, anon;
revoke all on function public.moderate_series(uuid, boolean) from public, anon;
grant execute on function public.create_series(text,text,text,uuid,text,text,double precision,double precision,text,integer[],integer,time,integer,date,date,integer,integer,integer,jsonb,jsonb,text,text[]) to authenticated;
grant execute on function public.update_occurrence(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,integer) to authenticated;
grant execute on function public.update_series_from(uuid,text,text,uuid,text,text,double precision,double precision,integer[],integer,time,integer,integer) to authenticated;
grant execute on function public.cancel_occurrence(uuid) to authenticated;
grant execute on function public.end_series(uuid, date) to authenticated;
grant execute on function public.set_series_host(uuid, uuid, boolean) to authenticated;
grant execute on function public.follow_series(uuid, boolean) to authenticated;
grant execute on function public.set_attended(uuid, uuid, boolean) to authenticated;
grant execute on function public.moderate_series(uuid, boolean) to authenticated;
