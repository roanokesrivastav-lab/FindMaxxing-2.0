-- ============================================================================
-- Roadmap 4.6 (4.0 Amendment A1.5): material-change notifications.
-- Contract: docs/features/0055-notifications.md.
--
--   * events.change_seq counts material changes (start, end, venue, leaving
--     published). event_changed is deduplicated per change instead of batched,
--     so a retry sends nothing new and a second edit is its own notification.
--   * One sender per change. Signed in: the row trigger. Service (cron, the
--     deletion job): the function that made the change, through the same
--     private sender. Bulk series changes send one follower message.
--   * Each recipient is checked as themselves: still going or following, not
--     blocked either way with the host, and able to see the event or series now.
--   * New type series_update for followers who are not going to the sessions
--     affected.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The type
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_not_happening', 'series_update'));

create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_not_happening', 'series_update'];
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
  'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready', 'event_not_happening', 'series_update'];
-- Whoever has event changes pushed gets series updates pushed too; a mute on event changes is not
-- read as a wish to hear about series.
update public.notification_settings set push_types = array_append(push_types, 'series_update')
  where 'event_changed' = any(push_types) and not ('series_update' = any(push_types));

-- ----------------------------------------------------------------------------
-- What counts as a change
-- ----------------------------------------------------------------------------
alter table public.events add column change_seq integer not null default 0;

create or replace function findmaxxing_private.count_event_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.change_seq := 0;
    return new;
  end if;
  new.change_seq := old.change_seq;
  if (new.starts_at, new.ends_at, new.place_id, new.location_name, new.address, new.lat, new.lng)
       is distinct from (old.starts_at, old.ends_at, old.place_id, old.location_name, old.address, old.lat, old.lng)
     or (old.status = 'published' and new.status <> 'published') then
    new.change_seq := old.change_seq + 1;
  end if;
  return new;
end $$;
revoke all on function findmaxxing_private.count_event_change() from public, anon, authenticated, service_role;
create trigger events_count_change before insert or update on public.events
  for each row execute function findmaxxing_private.count_event_change();

-- ----------------------------------------------------------------------------
-- Visibility as the recipient
-- ----------------------------------------------------------------------------
-- The visibility rules read auth.uid(). Rather than copy them with a user argument (and let the
-- copies drift), ask them with the recipient as the request's subject, then put the caller back.
-- Transaction-local, restored before returning; an error aborts the statement, which undoes it too.
create or replace function findmaxxing_private.visible_to(p_user uuid, p_kind text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  caller text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  ok boolean;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  ok := case p_kind when 'event' then public.can_view_event(p_id) when 'series' then public.can_view_series(p_id) else false end;
  perform set_config('request.jwt.claim.sub', caller, true);
  return coalesce(ok, false);
end $$;
revoke all on function findmaxxing_private.visible_to(uuid, text, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The senders
-- ----------------------------------------------------------------------------
-- People going to one event. p_kind: changed, cancelled, not_happening.
create or replace function findmaxxing_private.notify_event_audience(p_event uuid, p_kind text, p_actor uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  v_host uuid;
  v_type text;
  v_key text;
  r record;
  n integer := 0;
begin
  select * into e from public.events where id = p_event;
  if not found then return 0; end if;
  v_host := coalesce((select s.owner_id from public.event_series s where s.id = e.series_id), e.creator_id);
  v_type := case p_kind when 'changed' then 'event_changed' when 'cancelled' then 'event_cancelled' when 'not_happening' then 'event_not_happening' end;
  if v_type is null then raise exception 'unknown change kind %', p_kind; end if;
  v_key := case p_kind when 'changed' then 'event_changed:' || e.id || ':' || e.change_seq else v_type || ':' || e.id end;
  for r in select a.user_id from public.event_attendees a where a.event_id = e.id order by a.user_id loop
    continue when r.user_id is not distinct from p_actor;
    continue when v_host is not null and findmaxxing_private.is_blocked_between(r.user_id, v_host);
    continue when not findmaxxing_private.visible_to(r.user_id, 'event', e.id);
    perform public.notify(r.user_id, v_type, p_actor, 'event', e.id, e.title, null, v_key);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function findmaxxing_private.notify_event_audience(uuid, text, uuid) from public, anon, authenticated, service_role;

-- Followers of a series. p_kind: schedule, cancel (p_event is the session), ended. Anyone going to
-- one of p_affected hears about it from notify_event_audience instead.
create or replace function findmaxxing_private.notify_series_followers(p_series uuid, p_kind text, p_event uuid, p_affected uuid[], p_actor uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
  v_key text;
  v_next uuid;
  r record;
  n integer := 0;
begin
  select * into s from public.event_series where id = p_series;
  if not found then return 0; end if;
  v_key := case p_kind
    when 'schedule' then 'series_update:' || s.id || ':v' || s.rule_version
    when 'cancel' then 'series_update:' || s.id || ':cancel:' || p_event
    when 'ended' then 'series_update:' || s.id || ':ended' end;
  if v_key is null then raise exception 'unknown series change %', p_kind; end if;
  -- Where the notification leads: the next session still on, or (none) the Events list.
  select e.id into v_next from public.events e
   where e.series_id = s.id and e.status = 'published' and e.starts_at > now() order by e.starts_at, e.id limit 1;
  for r in select f.user_id from public.event_series_followers f where f.series_id = s.id order by f.user_id loop
    continue when r.user_id is not distinct from p_actor;
    continue when exists (select 1 from public.event_attendees a where a.user_id = r.user_id and a.event_id = any(coalesce(p_affected, '{}')));
    continue when findmaxxing_private.is_blocked_between(r.user_id, s.owner_id);
    continue when not findmaxxing_private.visible_to(r.user_id, 'series', s.id);
    perform public.notify(r.user_id, 'series_update', p_actor, 'event', v_next, s.title, null, v_key, p_kind);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function findmaxxing_private.notify_series_followers(uuid, text, uuid, uuid[], uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The signed-in sender (replaces 0021). Silent for service sessions, which send explicitly.
-- ----------------------------------------------------------------------------
create or replace function public.notify_on_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status = 'cancelled' and old.status = 'published' then
    perform findmaxxing_private.notify_event_audience(new.id, case when new.cancel_reason = 'below_minimum' then 'not_happening' else 'cancelled' end, auth.uid());
    -- One session of a series cancelled on its own (cancel_occurrence, or the host's direct cancel).
    -- A bulk change (ending the series, closing the account) sends one follower message itself.
    if new.series_id is not null and coalesce(current_setting('findmaxxing.series_bulk', true), '') <> 'on' then
      perform findmaxxing_private.notify_series_followers(new.series_id, 'cancel', new.id, array[new.id], auth.uid());
    end if;
  elsif new.status = 'published' and old.status = 'published' and new.change_seq <> old.change_seq then
    perform findmaxxing_private.notify_event_audience(new.id, 'changed', auth.uid());
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Service and bulk paths, as in 0051 and 0054 with the sends added.
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
      -- 0055: the shared sender (going, visible, not blocked with the host), and the series' followers.
      perform findmaxxing_private.notify_event_audience(e.id, 'not_happening', null);
      if e.series_id is not null then
        perform findmaxxing_private.notify_series_followers(e.series_id, 'cancel', e.id, array[e.id], null);
      end if;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.prepare_account_deletion(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare paths jsonb; customer text; subscription text; previous jsonb; has_objects boolean;
  v_cancelled uuid[]; v_series uuid[]; v_id uuid;
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
  -- 0055: the people going are told. A signed-in caller's change is announced by the row trigger;
  -- a service caller's (the deletion job) explicitly here. Followers of an ended series get one message.
  perform set_config('findmaxxing.series_bulk', 'on', true);
  with c as (
    update public.events set status = 'cancelled', cancel_reason = case when series_id is null then cancel_reason else 'series_ended' end
      where creator_id = p_user and status = 'published' and starts_at > now()
    returning id, series_id)
  select coalesce(array_agg(id order by id), '{}'), coalesce(array_agg(distinct series_id) filter (where series_id is not null), '{}')
    into v_cancelled, v_series from c;
  perform set_config('findmaxxing.series_bulk', 'off', true);
  if auth.uid() is null then
    foreach v_id in array v_cancelled loop
      perform findmaxxing_private.notify_event_audience(v_id, 'cancelled', null);
    end loop;
  end if;
  -- Each series' own sessions only: going to one of the host's other events says nothing about this series.
  foreach v_id in array v_series loop
    perform findmaxxing_private.notify_series_followers(v_id, 'ended', null,
      array(select e.id from public.events e where e.id = any(v_cancelled) and e.series_id = v_id), auth.uid());
  end loop;
  update public.tickets set status = 'expired' where status = 'pending'
    and (user_id = p_user or event_id in (select id from public.events where creator_id = p_user));
end $$;

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
  -- 0055: one schedule update for followers who are not going to a session that moved.
  if v_schedule then
    perform findmaxxing_private.notify_series_followers(s.id, 'schedule', null, moved_ids, auth.uid());
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

create or replace function public.end_event_series(p_series uuid, p_ends_on date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.event_series%rowtype;
  v_on date;
  n integer := 0;
  v_cancelled uuid[];
begin
  s := findmaxxing_private.lock_series_for_owner(p_series);
  if s.status = 'ended' then return 0; end if;
  v_on := coalesce(p_ends_on, (clock_timestamp() at time zone s.time_zone)::date);
  if v_on < s.starts_on then v_on := s.starts_on; end if;
  update public.event_series set status = 'ended', ends_on = v_on where id = s.id;
  perform 1 from public.events where series_id = s.id and series_local_date > v_on and status = 'published' order by id for update;
  perform set_config('findmaxxing.series_write', 'on', true);
  -- 0055: people going hear about their session from the row trigger; followers get one message.
  perform set_config('findmaxxing.series_bulk', 'on', true);
  with c as (
    update public.events set status = 'cancelled', cancel_reason = 'series_ended'
      where series_id = s.id and series_local_date > v_on and status = 'published' and starts_at > now()
    returning id)
  select coalesce(array_agg(id), '{}') into v_cancelled from c;
  n := cardinality(v_cancelled);
  perform set_config('findmaxxing.series_bulk', 'off', true);
  perform findmaxxing_private.notify_series_followers(s.id, 'ended', null, v_cancelled, auth.uid());
  perform set_config('findmaxxing.series_write', 'off', true);
  return n;
end $$;
