-- Roadmap R2: opt-in need-players alerts (spec docs/features/R2.md). Off by default. The area is a coarse
-- cell (lat/lng rounded to 0.01°) plus a radius; only the rounded cell is stored, readable only by its
-- owner. Matching runs server-side in the 15-minute notifications job. One alert per session per person,
-- at most 3 per rolling 24 hours, through notify() (blocks, mutes, push types; quiet hours and the daily
-- cap at push time). Never RSVPs.

create table if not exists public.need_player_alerts (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  enabled     boolean not null default false,
  categories  text[] not null default '{}' check (cardinality(categories) <= 12),
  cell_lat    numeric(5, 2) not null check (cell_lat between -90 and 90),
  cell_lng    numeric(5, 2) not null check (cell_lng between -180 and 180),
  radius_km   integer not null default 3 check (radius_km in (1, 3, 5, 10)),
  updated_at  timestamptz not null default now()
);
alter table public.need_player_alerts enable row level security;
drop policy if exists "own alert settings" on public.need_player_alerts;
create policy "own alert settings" on public.need_player_alerts for select using (user_id = auth.uid());
revoke insert, update, delete, truncate on public.need_player_alerts from anon, authenticated;

create or replace function public.set_need_player_alerts(p_enabled boolean, p_categories text[], p_lat double precision, p_lng double precision, p_radius_km integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if exists (select 1 from unnest(coalesce(p_categories, '{}')) c where not exists (select 1 from public.categories k where k.slug = c)) then
    raise exception 'Unknown activity' using errcode = '22023';
  end if;
  insert into public.need_player_alerts (user_id, enabled, categories, cell_lat, cell_lng, radius_km, updated_at)
  values (v_uid, coalesce(p_enabled, false), (select coalesce(array_agg(distinct c order by c), '{}') from unnest(coalesce(p_categories, '{}')) c),
          round(p_lat::numeric, 2), round(p_lng::numeric, 2), coalesce(p_radius_km, 3), now())
  on conflict (user_id) do update set enabled = excluded.enabled, categories = excluded.categories, cell_lat = excluded.cell_lat,
    cell_lng = excluded.cell_lng, radius_km = excluded.radius_km, updated_at = now();
end $$;
revoke all on function public.set_need_player_alerts(boolean, text[], double precision, double precision, integer) from public, anon;
grant execute on function public.set_need_player_alerts(boolean, text[], double precision, double precision, integer) to authenticated;

-- Notification type.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update', 'need_players'));
create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update', 'need_players'];
begin
  perform now() at time zone new.time_zone;
  if not (new.muted_types <@ known and new.push_types <@ known) then
    raise exception 'notifications:bad_type' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
-- Only people who opted in ever receive it, so it is pushed by default like the other event alerts.
alter table public.notification_settings alter column push_types set default array['new_follower', 'event_joined', 'event_tomorrow',
  'event_soon', 'event_changed', 'event_cancelled', 'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired', 'event_not_happening', 'series_update', 'need_players'];
update public.notification_settings set push_types = push_types || array['need_players']
  where 'event_cancelled' = any(push_types) and not ('need_players' = any(push_types));

-- Service (cron): matching sessions → one alert per session per person, at most 3 per 24 hours.
create or replace function public.send_need_player_alerts(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.need_player_alerts%rowtype;
  e record;
  v_sent integer := 0;
  v_recent integer;
begin
  for a in select * from public.need_player_alerts where enabled and cardinality(categories) > 0 loop
    continue when exists (select 1 from public.suspensions s where s.user_id = a.user_id);
    select count(*)::integer into v_recent from public.notifications n
      where n.user_id = a.user_id and n.type = 'need_players' and n.created_at > p_now - interval '24 hours';
    for e in
      select ev.id, ev.title, ev.creator_id, ev.min_attendance,
             (select count(*) from public.event_attendees x where x.event_id = ev.id)::integer as going
      from public.events ev
      where ev.status = 'published' and ev.price_cents is null and ev.category_slug = any(a.categories)
        and ev.min_attendance is not null and ev.decision = 'open'
        and ev.starts_at > p_now and ev.starts_at <= p_now + interval '48 hours'
        and (ev.decision_deadline is null or ev.decision_deadline > p_now)
        and ev.creator_id is distinct from a.user_id
        -- Equirectangular distance from the cell centre, in km.
        and 111.32 * sqrt(power(ev.lat - a.cell_lat::double precision, 2)
              + power((ev.lng - a.cell_lng::double precision) * cos(radians(a.cell_lat::double precision)), 2)) <= a.radius_km
        and not exists (select 1 from public.event_attendees x where x.event_id = ev.id and x.user_id = a.user_id)
        and not exists (select 1 from public.event_participants p where p.event_id = ev.id and p.user_id = a.user_id and p.status in ('waitlisted', 'offered'))
        and not exists (select 1 from public.notifications n where n.user_id = a.user_id and n.dedupe_key = 'need_players:' || ev.id)
      order by ev.starts_at
    loop
      exit when v_recent >= 3;
      continue when e.going >= e.min_attendance;
      continue when not public.can_view_event_as(a.user_id, e.id);
      perform public.notify(a.user_id, 'need_players', e.creator_id, 'event', e.id, e.title, null, 'need_players:' || e.id,
        (e.min_attendance - e.going)::text || ' more needed');
      -- notify() may drop it (block, mute); count only what was written.
      if exists (select 1 from public.notifications n where n.user_id = a.user_id and n.dedupe_key = 'need_players:' || e.id) then
        v_recent := v_recent + 1;
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;
  return v_sent;
end $$;
revoke all on function public.send_need_player_alerts(timestamptz) from public, anon, authenticated;
grant execute on function public.send_need_player_alerts(timestamptz) to service_role;
