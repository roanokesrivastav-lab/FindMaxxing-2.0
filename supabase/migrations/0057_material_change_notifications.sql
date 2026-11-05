-- Roadmap 4.6: material-change notifications (4.0 spec §9; batch 4.6). Everything goes through the
-- existing notify() (blocks, mutes, push types, dedupe), and push delivery keeps quiet hours and the daily
-- cap (claim_push_batch). Material = start/end time, venue, cancellation (any reason), an offer, an offer
-- expiring (offers: 0054). Not material: title, description, capacity.
--
-- | Change                         | Recipients                                   | Type                 |
-- | Time or venue changed          | going + offered                              | event_changed        |
-- | Cancelled by a host            | going + offered + waitlisted + interested    | event_cancelled      |
-- | Cancelled below minimum (cron) | going + offered + waitlisted + interested    | event_not_happening  |
-- | Occurrence cancelled / series  | followers not already told above             | series_update        |
-- |   schedule changed / ended     |                                              |                      |
-- Followers are not told about each routine generated occurrence (D-F).

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update'));
-- The subject of a series update is the series itself.
alter table public.notifications drop constraint if exists notifications_subject_type_check;
alter table public.notifications add constraint notifications_subject_type_check check (subject_type in
  ('profile', 'event', 'place', 'conversation', 'report', 'message', 'plan', 'series'));

create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update'];
begin
  perform now() at time zone new.time_zone;
  if not (new.muted_types <@ known and new.push_types <@ known) then
    raise exception 'notifications:bad_type' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

alter table public.notification_settings alter column push_types set default array['new_follower', 'event_joined', 'event_tomorrow',
  'event_soon', 'event_changed', 'event_cancelled', 'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update'];
update public.notification_settings
  set push_types = push_types || array['event_not_happening', 'series_update']
  where 'event_cancelled' = any(push_types) and not ('event_not_happening' = any(push_types));

-- Who hears about a cancellation: going, offered, waitlisted and interested (D-F).
create or replace function public.event_cancellation_recipients(p_event uuid)
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select user_id from public.event_attendees where event_id = p_event
  union
  select user_id from public.event_participants where event_id = p_event and status in ('offered', 'waitlisted', 'interested')
$$;
revoke all on function public.event_cancellation_recipients(uuid) from public, anon, authenticated;

-- Followers of the occurrence's series who are not among the given recipients.
create or replace function public.notify_series_followers(p_series uuid, p_actor uuid, p_dedupe text, p_detail text, p_except_event uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f record;
  v_title text;
begin
  if p_series is null then return; end if;
  select title into v_title from public.event_series where id = p_series;
  for f in select user_id from public.event_series_followers where series_id = p_series loop
    continue when p_except_event is not null and f.user_id in (select public.event_cancellation_recipients(p_except_event));
    perform public.notify(f.user_id, 'series_update', p_actor, 'series', p_series, v_title, null, p_dedupe, p_detail);
  end loop;
end $$;
revoke all on function public.notify_series_followers(uuid, uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.notify_on_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  -- Service and cron changes call notify() explicitly (e.g. decide_sessions); the trigger stays silent.
  if auth.uid() is null then return new; end if;
  if new.status = 'cancelled' and old.status = 'published' then
    for a in select public.event_cancellation_recipients(new.id) as user_id loop
      perform public.notify(a.user_id, 'event_cancelled', auth.uid(), 'event', new.id, new.title, null, 'event_cancelled:' || new.id);
    end loop;
    -- Ending a series tells followers once (notify_on_series_change), not once per cancelled date.
    if new.cancel_reason is distinct from 'series_ended' then
      perform public.notify_series_followers(new.series_id, auth.uid(), 'series_update:' || new.series_id || ':' || new.id, 'A date was cancelled', new.id);
    end if;
  elsif new.status = 'published' and (new.starts_at, new.ends_at, new.location_name, new.address, new.lat, new.lng, new.place_id)
        is distinct from (old.starts_at, old.ends_at, old.location_name, old.address, old.lat, old.lng, old.place_id) then
    for a in select user_id from public.event_attendees where event_id = new.id
             union select user_id from public.event_participants where event_id = new.id and status = 'offered' loop
      perform public.notify(a.user_id, 'event_changed', auth.uid(), 'event', new.id, new.title, 'event_changed:' || new.id);
    end loop;
  end if;
  return new;
end $$;

-- Series schedule changes (rule_version) and the end of a series reach followers once per change.
create or replace function public.notify_on_series_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.rule_version > old.rule_version then
    perform public.notify_series_followers(new.id, auth.uid(), 'series_update:' || new.id || ':v' || new.rule_version, 'The schedule changed');
  elsif new.status = 'ended' and old.status <> 'ended' then
    perform public.notify_series_followers(new.id, auth.uid(), 'series_update:' || new.id || ':ended', 'The series has ended');
  end if;
  return new;
end $$;
drop trigger if exists event_series_notify on public.event_series;
create trigger event_series_notify after update on public.event_series for each row execute function public.notify_on_series_change();

-- 4.3's cron now uses the dedicated type and the full cancellation audience (+ followers).
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
      for a in select public.event_cancellation_recipients(e.id) as user_id loop
        perform public.notify(a.user_id, 'event_not_happening', null, 'event', e.id, e.title, null,
          'event_not_happening:' || e.id, 'Not enough people signed up');
      end loop;
      perform public.notify_series_followers(e.series_id, null, 'series_update:' || e.series_id || ':' || e.id, 'A date is not happening', e.id);
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
