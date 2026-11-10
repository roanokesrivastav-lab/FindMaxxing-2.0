-- ============================================================================
-- FindMaxxing — 4.2: structured activity details and a time zone on every event
-- (docs/features/4.0.md §4, §16; docs/features/4.2.md).
--
--   * events.time_zone: the IANA zone the event happens in. Existing rows get
--     'America/New_York', which is what the app assumed for every event until
--     now. It is required from here on; the default keeps older callers that
--     do not send one working.
--   * events.activity_details: a small object describing the activity in plain
--     terms (a run's distance and pace, a game's format). Its exact shape is
--     validated by the app (packages/shared/src/activity.ts); the database
--     checks the kind, that every value is a plain scalar, and the size.
--   * Neither column is in the column-level UPDATE grant on events (0001), so
--     they change only through update_event_with_tags().
-- ============================================================================

-- A real IANA "Area/Location" name (or UTC) that this server knows. POSIX-style
-- specs such as 'ABC+3' are accepted by AT TIME ZONE but are not zone names.
create or replace function public.valid_time_zone(p_zone text)
returns boolean language plpgsql stable set search_path = public as $$
begin
  if p_zone is null or char_length(p_zone) > 64 then return false; end if;
  if p_zone <> 'UTC' and p_zone !~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+)+$' then return false; end if;
  perform now() at time zone p_zone;
  return true;
exception when others then
  return false;
end $$;

create or replace function public.valid_activity_details(p_details jsonb)
returns boolean language sql immutable set search_path = public as $$
  -- coalesce: a missing kind makes the test NULL, and a CHECK passes on NULL.
  -- CASE first: jsonb_each raises on anything but an object.
  select case
    when p_details is null then true
    when jsonb_typeof(p_details) <> 'object' then false
    else coalesce(
      p_details ->> 'kind' in ('run', 'volleyball', 'basketball', 'pickleball', 'walk')
      and char_length(p_details::text) <= 600
      and not exists (
        select 1 from jsonb_each(p_details) kv
        where jsonb_typeof(kv.value) not in ('string', 'number', 'boolean') or char_length(kv.key) > 40),
      false)
  end;
$$;

alter table public.events add column time_zone text not null default 'America/New_York';
alter table public.events add column activity_details jsonb;
alter table public.events add constraint events_activity_details_check check (public.valid_activity_details(activity_details));

create or replace function public.check_event_time_zone()
returns trigger language plpgsql set search_path = public as $$
begin
  if not public.valid_time_zone(new.time_zone) then
    raise exception 'events:bad_time_zone' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger events_check_time_zone before insert or update of time_zone on public.events
  for each row execute function public.check_event_time_zone();

-- ----------------------------------------------------------------------------
-- Create and update take the two new fields. Both keep their old parameters in
-- the same order with defaults for the new ones, so a caller that sends only
-- the old named parameters still resolves to these.
-- ----------------------------------------------------------------------------
drop function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[]);

create function public.create_event_with_details(
  p_title text, p_description text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity integer, p_tags text[],
  p_time_zone text default null, p_activity_details jsonb default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  created_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.events (
    title, description, place_id, location_name, address, lat, lng,
    starts_at, ends_at, creator_id, category_slug, capacity, time_zone, activity_details
  ) values (
    p_title, p_description, p_place_id, p_location_name, p_address, p_lat, p_lng,
    p_starts_at, p_ends_at, auth.uid(), p_category_slug, p_capacity,
    coalesce(p_time_zone, 'America/New_York'),
    case when p_activity_details is null or jsonb_typeof(p_activity_details) = 'null' or p_activity_details = '{}'::jsonb then null else p_activity_details end
  ) returning id into created_id;

  insert into public.event_tags (event_id, interest_slug)
    select distinct created_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;

  insert into public.event_attendees (event_id, user_id) values (created_id, auth.uid());

  return created_id;
end $$;

revoke all on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[], text, jsonb) from public, anon;
grant execute on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[], text, jsonb) to authenticated;

drop function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[]);

-- p_time_zone null keeps the zone. p_activity_details null (SQL or JSON null)
-- keeps the details; an empty object clears them.
create function public.update_event_with_tags(
  p_id uuid, p_title text, p_description text, p_place_id uuid,
  p_location_name text, p_address text, p_lat double precision,
  p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity int, p_tags text[],
  p_time_zone text default null, p_activity_details jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  updated_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_place_id is not null and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  update public.events set
    title = p_title, description = p_description, place_id = p_place_id,
    location_name = p_location_name, address = p_address, lat = p_lat,
    lng = p_lng, starts_at = p_starts_at, ends_at = p_ends_at,
    category_slug = p_category_slug, capacity = p_capacity,
    time_zone = coalesce(p_time_zone, time_zone),
    activity_details = case when p_activity_details is null or jsonb_typeof(p_activity_details) = 'null' then activity_details
                            when p_activity_details = '{}'::jsonb then null
                            else p_activity_details end
  where id = p_id and creator_id = auth.uid()
  returning id into updated_id;
  if updated_id is null then raise exception 'You do not own this event' using errcode = '42501'; end if;

  delete from public.event_tags where event_id = p_id;
  insert into public.event_tags (event_id, interest_slug)
    select p_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;
  return updated_id;
end $$;

revoke all on function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[], text, jsonb) from public, anon, authenticated;
grant execute on function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[], text, jsonb) to authenticated, service_role;
