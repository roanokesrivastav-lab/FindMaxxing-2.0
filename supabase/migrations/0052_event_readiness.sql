-- Roadmap 4.3: minimum attendance and the Readiness row (4.0 spec §5, batch 4.3).
--   events.min_attendance, decision_deadline, venue_status, decision, cancel_reason
--   event_readiness(): one definition of the Readiness numbers for web, native and cards
--   confirm_session(): the host confirms before the deadline (blocks the auto-cancel)
--   decide_sessions(): service-only cron at the deadline, with explicit notifications (the existing
--   change trigger is silent for service changes).

alter table public.events
  add column if not exists min_attendance integer,
  add column if not exists decision_deadline timestamptz,
  add column if not exists venue_status text not null default 'confirmed',
  add column if not exists decision text not null default 'open',
  add column if not exists cancel_reason text;

alter table public.events drop constraint if exists events_venue_status_valid;
alter table public.events add constraint events_venue_status_valid check (venue_status in ('confirmed', 'unconfirmed'));
alter table public.events drop constraint if exists events_decision_valid;
alter table public.events add constraint events_decision_valid check (decision in ('open', 'happening', 'not_happening'));
alter table public.events drop constraint if exists events_cancel_reason_valid;
alter table public.events add constraint events_cancel_reason_valid check (cancel_reason is null or cancel_reason in ('host', 'below_minimum', 'series_ended'));
-- 2 <= min_attendance <= capacity (when capacity is set).
alter table public.events drop constraint if exists events_min_attendance_valid;
alter table public.events add constraint events_min_attendance_valid check (min_attendance is null or (min_attendance >= 2 and min_attendance <= 5000 and (capacity is null or min_attendance <= capacity)));
-- The host decides on or before the start.
alter table public.events drop constraint if exists events_decision_deadline_valid;
alter table public.events add constraint events_decision_deadline_valid check (decision_deadline is null or decision_deadline <= starts_at);

-- The creator sets the session rules (RLS and guard_owner_event_change() still apply). decision and
-- cancel_reason are written only by confirm_session() and decide_sessions().
grant update (min_attendance, decision_deadline, venue_status) on public.events to authenticated;

-- Seats held without being "going": live pending paid holds (4.4 adds live offers here).
create or replace function public.event_seats_held(p_event uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from public.tickets t
  where t.event_id = p_event and t.status = 'pending' and t.expires_at > clock_timestamp()
$$;
revoke all on function public.event_seats_held(uuid) from public, anon, authenticated;

-- The Readiness row's numbers, each from its own field (4.0 §5). Null for an event the caller cannot see.
-- going = count(event_attendees); spotsOpen = capacity - going - held (held seats are not open);
-- moreNeeded = max(0, min - going); deadline in the event's own zone is formatted by the client.
create or replace function public.event_readiness(e public.events)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_going integer;
  v_held integer;
begin
  if e.id is null or not public.can_view_event(e.id) then return null; end if;
  select count(*)::integer into v_going from public.event_attendees where event_id = e.id;
  v_held := public.event_seats_held(e.id);
  return jsonb_build_object(
    'going', v_going,
    'capacity', e.capacity,
    'held', v_held,
    'spotsOpen', case when e.capacity is null then null else greatest(0, e.capacity - v_going - v_held) end,
    'minAttendance', e.min_attendance,
    'moreNeeded', case when e.min_attendance is null then null else greatest(0, e.min_attendance - v_going) end,
    'decisionDeadline', e.decision_deadline,
    'decision', e.decision,
    'venueStatus', e.venue_status,
    'waitlist', 0
  );
end $$;

create or replace function public.event_readiness(p_event uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select public.event_readiness(e) from public.events e where e.id = p_event
$$;
revoke all on function public.event_readiness(public.events) from public;
revoke all on function public.event_readiness(uuid) from public;
grant execute on function public.event_readiness(public.events) to anon, authenticated, service_role;
grant execute on function public.event_readiness(uuid) to anon, authenticated, service_role;

-- The host confirms the session is happening (before the deadline). Blocks decide_sessions' auto-cancel.
create or replace function public.confirm_session(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.events%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or e.creator_id is distinct from auth.uid() then
    raise exception 'You do not own this event' using errcode = '42501';
  end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) <= now() then
    raise exception 'Only future published events can be confirmed' using errcode = 'P0001';
  end if;
  if e.decision = 'happening' then return 'happening'; end if;
  if e.decision_deadline is not null and e.decision_deadline <= clock_timestamp() then
    raise exception 'The decision deadline has passed' using errcode = 'P0001';
  end if;
  update public.events set decision = 'happening' where id = p_event;
  return 'happening';
end $$;
revoke all on function public.confirm_session(uuid) from public, anon;
grant execute on function public.confirm_session(uuid) to authenticated;

-- Service-only (cron): at each passed deadline, an open session below its minimum is cancelled as
-- not happening and everyone going is told; one at or above its minimum becomes happening.
-- Idempotent: only 'open' sessions are touched, and notifications carry a dedupe key.
create or replace function public.decide_sessions(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.events%rowtype;
  v_going integer;
  v_cancelled integer := 0;
  a record;
begin
  for e in
    select * from public.events
    where status = 'published' and decision = 'open' and decision_deadline is not null
      and decision_deadline <= p_now and coalesce(ends_at, starts_at) > p_now
    order by decision_deadline
    for update skip locked
  loop
    select count(*)::integer into v_going from public.event_attendees where event_id = e.id;
    if e.min_attendance is not null and v_going < e.min_attendance then
      -- Notify the people going before the cancel (refund_on_cancel and visibility follow the status).
      for a in select user_id from public.event_attendees where event_id = e.id loop
        perform public.notify(a.user_id, 'event_cancelled', null, 'event', e.id, e.title, null,
          'event_not_happening:' || e.id, 'Not enough people signed up');
      end loop;
      update public.events set status = 'cancelled', cancel_reason = 'below_minimum', decision = 'not_happening' where id = e.id;
      v_cancelled := v_cancelled + 1;
    else
      update public.events set decision = 'happening' where id = e.id;
    end if;
  end loop;
  return v_cancelled;
end $$;
revoke all on function public.decide_sessions(timestamptz) from public, anon, authenticated;
grant execute on function public.decide_sessions(timestamptz) to service_role;
