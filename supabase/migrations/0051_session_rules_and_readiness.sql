-- ============================================================================
-- FindMaxxing — 4.3: minimum attendance, the decision deadline and the
-- Readiness row (docs/features/4.0.md §5; docs/features/4.3.md).
--
--   * Session rules on every event: min_attendance, decision_deadline,
--     venue_status, and the decision itself (open / happening / not_happening)
--     with the reason an event was cancelled.
--   * None of the new columns is in the column-level UPDATE grant on events
--     (0001): hosts change the rules through set_session_rules() and confirm
--     with confirm_session(); the decision and cancel reason are never client
--     input.
--   * seats_taken(): the one definition of how many seats are spoken for. Here
--     it is going + live paid holds; 0052 adds live waitlist offers to it.
--   * events_readiness(): the numbers behind the Readiness row, each from its
--     own field, for anyone who can see the event.
--   * decide_sessions(): the cron's decision at the deadline. It runs as the
--     service role, where the change trigger is silent (0021), so it notifies
--     attendees itself, with a dedupe key.
-- ============================================================================

alter table public.events add column min_attendance integer check (min_attendance is null or min_attendance >= 2);
alter table public.events add column decision_deadline timestamptz;
alter table public.events add column venue_status text not null default 'confirmed' check (venue_status in ('confirmed', 'unconfirmed'));
alter table public.events add column decision text not null default 'open' check (decision in ('open', 'happening', 'not_happening'));
alter table public.events add column cancel_reason text check (cancel_reason is null or cancel_reason in ('host', 'below_minimum', 'series_ended'));
alter table public.events add constraint events_min_attendance_capacity_check check (min_attendance is null or capacity is null or min_attendance <= capacity);
alter table public.events add constraint events_decision_deadline_check check (decision_deadline is null or decision_deadline <= starts_at);
create index events_decision_due_idx on public.events (decision_deadline) where decision = 'open' and min_attendance is not null and status = 'published';

-- Events cancelled before this migration were all cancelled by their host (or
-- with their host's account); there was no other way.
update public.events set cancel_reason = 'host', decision = 'not_happening' where status = 'cancelled';

-- Keeps the session rules and the decision honest whoever writes the row:
-- direct inserts, the create/update functions, the host RPCs and the cron.
create or replace function public.guard_event_session_rules()
returns trigger language plpgsql set search_path = public as $$
declare
  -- Set by the functions that take the rules as input: the deadline they give is final.
  explicit boolean := coalesce(current_setting('findmaxxing.session_rules', true), '') = 'explicit';
  shifted boolean := false;
begin
  if tg_op = 'INSERT' then
    -- A signed-in creator never supplies the outcome.
    if auth.uid() is not null then
      new.decision := 'open';
      new.cancel_reason := null;
    end if;
  else
    if new.status = 'cancelled' and old.status = 'published' then
      new.cancel_reason := coalesce(new.cancel_reason, 'host');
      new.decision := 'not_happening';
    end if;
    if new.status = 'published' and new.cancel_reason is not null then
      new.cancel_reason := null;
    end if;
    -- Moving the start keeps the same lead time before it.
    if not explicit and new.starts_at is distinct from old.starts_at and new.decision_deadline is not null
       and new.decision_deadline is not distinct from old.decision_deadline then
      new.decision_deadline := old.decision_deadline + (new.starts_at - old.starts_at);
      shifted := true;
    end if;
  end if;
  if new.min_attendance is not null and new.min_attendance < 2 then
    raise exception 'events:bad_session_rules' using errcode = 'P0001';
  end if;
  if new.min_attendance is not null and new.capacity is not null and new.min_attendance > new.capacity then
    raise exception 'events:min_above_capacity' using errcode = 'P0001';
  end if;
  -- A deadline decides nothing without a minimum.
  if new.decision_deadline is not null and new.min_attendance is null then
    raise exception 'events:bad_session_rules' using errcode = 'P0001';
  end if;
  if new.decision_deadline is not null and new.decision_deadline > new.starts_at then
    raise exception 'events:bad_deadline' using errcode = 'P0001';
  end if;
  -- A person cannot set a deadline that has already passed: the next cron run
  -- would cancel the event at once. (A deadline carried along by moving the
  -- start is exempt; it is the same rule the host already chose.)
  if auth.uid() is not null and new.decision_deadline is not null and new.decision_deadline <= now()
     and (tg_op = 'INSERT' or (new.decision_deadline is distinct from old.decision_deadline and not shifted)) then
    raise exception 'events:bad_deadline' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger events_guard_session_rules before insert or update on public.events
  for each row execute function public.guard_event_session_rules();

-- ----------------------------------------------------------------------------
-- Notification type: the session is not happening (below its minimum).
-- People who have a cancellation pushed get this pushed too.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_not_happening'));

create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_not_happening'];
begin
  perform now() at time zone new.time_zone;
  if not (new.muted_types <@ known and new.push_types <@ known) then
    raise exception 'notifications:bad_type' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

alter table public.notification_settings alter column push_types set default array[
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready', 'event_not_happening'];
update public.notification_settings set push_types = array_append(push_types, 'event_not_happening')
  where 'event_cancelled' = any(push_types) and not ('event_not_happening' = any(push_types));

-- ----------------------------------------------------------------------------
-- Capacity accounting (4.0 §6.2). One definition; 0052 extends this function.
-- "Live" is decided against the clock at the moment of asking, not by a sweep.
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.seats_taken(p_event uuid)
returns integer language sql volatile security definer set search_path = public as $$
  select ((select count(*) from public.event_attendees a where a.event_id = p_event)
        + (select count(*) from public.tickets t where t.event_id = p_event and t.status = 'pending' and t.expires_at > clock_timestamp()))::integer;
$$;
revoke all on function findmaxxing_private.seats_taken(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Readiness: the numbers on the card, for events the caller can see.
-- ----------------------------------------------------------------------------
create or replace function public.events_readiness(p_events uuid[])
returns table (
  event_id uuid, going integer, capacity integer, spots_open integer, min_attendance integer, more_needed integer,
  decision_deadline timestamptz, time_zone text, venue_status text, decision text, waitlist integer
)
language sql volatile security definer set search_path = public as $$
  select e.id, g.going, e.capacity,
         case when e.capacity is null then null else greatest(0, e.capacity - findmaxxing_private.seats_taken(e.id)) end,
         e.min_attendance,
         case when e.min_attendance is null then null else greatest(0, e.min_attendance - g.going) end,
         e.decision_deadline, e.time_zone, e.venue_status, e.decision, 0
  from public.events e
  cross join lateral (select count(*)::integer as going from public.event_attendees a where a.event_id = e.id) g
  where e.id = any(p_events[1:200]) and public.can_view_event(e.id);
$$;
revoke all on function public.events_readiness(uuid[]) from public, anon, authenticated;
grant execute on function public.events_readiness(uuid[]) to anon, authenticated, service_role;

create or replace function public.event_readiness(p_event uuid)
returns table (
  event_id uuid, going integer, capacity integer, spots_open integer, min_attendance integer, more_needed integer,
  decision_deadline timestamptz, time_zone text, venue_status text, decision text, waitlist integer
)
language sql volatile security definer set search_path = public as $$
  select * from public.events_readiness(array[p_event]);
$$;
revoke all on function public.event_readiness(uuid) from public, anon, authenticated;
grant execute on function public.event_readiness(uuid) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Host tools
-- ----------------------------------------------------------------------------
-- Who may run an event's session: its creator. (0053 adds series hosts here.)
create or replace function findmaxxing_private.can_host_event(p_event uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user is not null and exists (select 1 from public.events e where e.id = p_event and e.creator_id = p_user);
$$;
revoke all on function findmaxxing_private.can_host_event(uuid, uuid) from public, anon, authenticated, service_role;

-- Refuses suspended and closing accounts, like reserve_ticket() and the write triggers.
create or replace function findmaxxing_private.require_active_account()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if exists (select 1 from public.suspensions where user_id = auth.uid()) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.account_deletion_jobs where user_id = auth.uid())
     or not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'account_deletion_in_progress' using errcode = 'P0001';
  end if;
end $$;
revoke all on function findmaxxing_private.require_active_account() from public, anon, authenticated, service_role;

-- The shape of the rules is checked by guard_event_session_rules() above.
create or replace function public.set_session_rules(
  p_event uuid, p_min_attendance integer, p_decision_deadline timestamptz, p_venue_status text
) returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
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
  update public.events set min_attendance = p_min_attendance, decision_deadline = p_decision_deadline, venue_status = p_venue_status
  where id = p_event;
  perform set_config('findmaxxing.session_rules', 'off', true);
end $$;
revoke all on function public.set_session_rules(uuid, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.set_session_rules(uuid, integer, timestamptz, text) to authenticated;

-- The host says it is on whatever the count: this blocks the automatic cancel.
create or replace function public.confirm_session(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  select * into e from public.events where id = p_event for update;
  if not found or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'events:closed' using errcode = 'P0001';
  end if;
  if e.decision = 'open' then
    update public.events set decision = 'happening' where id = p_event;
  end if;
  return 'happening';
end $$;
revoke all on function public.confirm_session(uuid) from public, anon, authenticated;
grant execute on function public.confirm_session(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The decision at the deadline (service role: the notifications cron).
-- Each event is decided under its row lock, the lock every join takes, so the
-- count cannot change between the test and the outcome. Events are taken in id
-- order so two runs cannot deadlock.
-- ----------------------------------------------------------------------------
create or replace function public.decide_sessions(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  e public.events%rowtype;
  a record;
  v_going integer;
  n integer := 0;
begin
  for r in
    select id from public.events
    where status = 'published' and decision = 'open' and min_attendance is not null
      and decision_deadline is not null and decision_deadline <= p_now
      and coalesce(ends_at, starts_at) > now()
    order by id
  loop
    select * into e from public.events where id = r.id for update;
    continue when not found or e.status <> 'published' or e.decision <> 'open' or e.min_attendance is null
      or e.decision_deadline is null or e.decision_deadline > p_now or coalesce(e.ends_at, e.starts_at) <= now();
    select count(*) into v_going from public.event_attendees where event_id = e.id;
    if v_going >= e.min_attendance then
      update public.events set decision = 'happening' where id = e.id;
    else
      update public.events set status = 'cancelled', cancel_reason = 'below_minimum', decision = 'not_happening' where id = e.id;
      for a in select user_id from public.event_attendees where event_id = e.id loop
        perform public.notify(a.user_id, 'event_not_happening', null, 'event', e.id, e.title, null, 'event_not_happening:' || e.id);
      end loop;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.decide_sessions(timestamptz) from public, anon, authenticated;
grant execute on function public.decide_sessions(timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- Create and update carry the session rules too, so an event and its rules are
-- one transaction. p_session_rules is
--   {"min_attendance": int|null, "decision_deadline": timestamptz|null, "venue_status": "confirmed"|"unconfirmed"}
-- and null means "no rules given": defaults on create, keep on update.
-- ----------------------------------------------------------------------------
drop function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[], text, jsonb);

create function public.create_event_with_details(
  p_title text, p_description text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity integer, p_tags text[],
  p_time_zone text default null, p_activity_details jsonb default null, p_session_rules jsonb default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  created_id uuid;
  rules jsonb := case when p_session_rules is null or jsonb_typeof(p_session_rules) <> 'object' then '{}'::jsonb else p_session_rules end;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.events (
    title, description, place_id, location_name, address, lat, lng,
    starts_at, ends_at, creator_id, category_slug, capacity, time_zone, activity_details,
    min_attendance, decision_deadline, venue_status
  ) values (
    p_title, p_description, p_place_id, p_location_name, p_address, p_lat, p_lng,
    p_starts_at, p_ends_at, auth.uid(), p_category_slug, p_capacity,
    coalesce(p_time_zone, 'America/New_York'),
    case when p_activity_details is null or jsonb_typeof(p_activity_details) = 'null' or p_activity_details = '{}'::jsonb then null else p_activity_details end,
    (rules ->> 'min_attendance')::integer, (rules ->> 'decision_deadline')::timestamptz, coalesce(rules ->> 'venue_status', 'confirmed')
  ) returning id into created_id;

  insert into public.event_tags (event_id, interest_slug)
    select distinct created_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;

  insert into public.event_attendees (event_id, user_id) values (created_id, auth.uid());

  return created_id;
end $$;

revoke all on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[], text, jsonb, jsonb) from public, anon;
grant execute on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[], text, jsonb, jsonb) to authenticated;

drop function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[], text, jsonb);

create function public.update_event_with_tags(
  p_id uuid, p_title text, p_description text, p_place_id uuid,
  p_location_name text, p_address text, p_lat double precision,
  p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity int, p_tags text[],
  p_time_zone text default null, p_activity_details jsonb default null, p_session_rules jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  updated_id uuid;
  has_rules boolean := p_session_rules is not null and jsonb_typeof(p_session_rules) = 'object';
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_place_id is not null and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  if has_rules then perform set_config('findmaxxing.session_rules', 'explicit', true); end if;
  update public.events set
    title = p_title, description = p_description, place_id = p_place_id,
    location_name = p_location_name, address = p_address, lat = p_lat,
    lng = p_lng, starts_at = p_starts_at, ends_at = p_ends_at,
    category_slug = p_category_slug, capacity = p_capacity,
    time_zone = coalesce(p_time_zone, time_zone),
    activity_details = case when p_activity_details is null or jsonb_typeof(p_activity_details) = 'null' then activity_details
                            when p_activity_details = '{}'::jsonb then null
                            else p_activity_details end,
    min_attendance = case when has_rules then (p_session_rules ->> 'min_attendance')::integer else min_attendance end,
    decision_deadline = case when has_rules then (p_session_rules ->> 'decision_deadline')::timestamptz else decision_deadline end,
    venue_status = case when has_rules then coalesce(p_session_rules ->> 'venue_status', 'confirmed') else venue_status end
  where id = p_id and creator_id = auth.uid()
  returning id into updated_id;
  perform set_config('findmaxxing.session_rules', 'off', true);
  if updated_id is null then raise exception 'You do not own this event' using errcode = '42501'; end if;

  delete from public.event_tags where event_id = p_id;
  insert into public.event_tags (event_id, interest_slug)
    select p_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;
  return updated_id;
end $$;

revoke all on function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[], text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.update_event_with_tags(uuid, text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, int, text[], text, jsonb, jsonb) to authenticated, service_role;
