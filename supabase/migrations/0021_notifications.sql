-- ============================================================================
-- FindMaxxing — notifications, in-app and web push.
--
--   * notifications: one row per thing to tell someone, owner-only. Rows are
--     written only by the triggers and functions below, never by clients.
--   * Batching: an unread notification with the same batch_key absorbs new
--     ones (count + 1), so ten messages in a chat are one notification.
--   * Idempotency: a dedupe_key can be used once per person (reminders,
--     follows), so a retried cron run or a re-follow never notifies twice.
--   * Triggers notify only when a signed-in person acted (auth.uid() set):
--     seeds, the service role and account-deletion cascades are silent.
--   * Nobody is notified about someone they blocked, or about their own action.
--   * Saves are private, so "your place was saved" never says by whom.
--   * Push: per-type preferences, quiet hours in the person's time zone, and
--     at most a few pushes a day (push_log). claim_push_batch() marks rows as
--     sent before anything is sent, so a retry can never send twice.
--   * Message text is never copied into a notification.
-- ============================================================================

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  type          text not null check (type in (
                  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready')),
  actor_id      uuid references public.profiles (id) on delete set null,
  subject_type  text check (subject_type in ('profile', 'event', 'place', 'conversation', 'report', 'message', 'plan')),
  subject_id    uuid,
  -- The subject's name when it happened (an event title, a place name).
  label         text check (label is null or char_length(label) <= 140),
  -- Extra detail: a report's outcome, a moderation decision.
  detail        text check (detail is null or char_length(detail) <= 40),
  count         integer not null default 1 check (count >= 1),
  batch_key     text check (batch_key is null or char_length(batch_key) <= 100),
  dedupe_key    text check (dedupe_key is null or char_length(dedupe_key) <= 100),
  push_state    text not null default 'none' check (push_state in ('none', 'pending', 'sent', 'skipped', 'capped')),
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  read_at       timestamptz
);
create unique index notifications_batch_idx on public.notifications (user_id, batch_key) where read_at is null and batch_key is not null;
create unique index notifications_dedupe_idx on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
create index notifications_user_time_idx on public.notifications (user_id, updated_at desc, id desc);
create index notifications_push_pending_idx on public.notifications (created_at) where push_state = 'pending';

create table public.notification_settings (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  -- Types that create no notification at all.
  muted_types   text[] not null default '{}',
  -- Types that are also pushed (to devices that opted in).
  push_types    text[] not null default array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed',
                  'event_cancelled', 'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready'],
  -- Quiet hours, local time: pushes wait until they end. Both or neither.
  quiet_start   smallint check (quiet_start between 0 and 23),
  quiet_end     smallint check (quiet_end between 0 and 23),
  time_zone     text not null default 'America/New_York' check (char_length(time_zone) <= 64),
  updated_at    timestamptz not null default now(),
  check ((quiet_start is null) = (quiet_end is null))
);

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) between 1 and 200),
  auth        text not null check (char_length(auth) between 1 and 100),
  created_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Pushes sent, for the daily cap. Service only.
create table public.push_log (
  user_id          uuid not null references public.profiles (id) on delete cascade,
  notification_id  uuid,
  sent_at          timestamptz not null default now()
);
create index push_log_user_time_idx on public.push_log (user_id, sent_at);

alter table public.notifications enable row level security;
alter table public.notification_settings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_log enable row level security;

create policy "users read their notifications" on public.notifications for select using (user_id = auth.uid());
create policy "users mark their notifications" on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users clear their notifications" on public.notifications for delete using (user_id = auth.uid());
revoke insert, update on public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;

create policy "users read their settings" on public.notification_settings for select using (user_id = auth.uid());
create policy "users create their settings" on public.notification_settings for insert with check (user_id = auth.uid());
create policy "users change their settings" on public.notification_settings for update using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke delete on public.notification_settings from anon, authenticated;

create policy "users read their devices" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "users remove their devices" on public.push_subscriptions for delete using (user_id = auth.uid());
revoke insert, update on public.push_subscriptions from anon, authenticated;

revoke all on public.push_log from anon, authenticated;

-- An unknown time zone is refused (at time zone raises), as are bad type names.
create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready'];
begin
  perform now() at time zone new.time_zone;
  if not (new.muted_types <@ known and new.push_types <@ known) then
    raise exception 'notifications:bad_type' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger notification_settings_check before insert or update on public.notification_settings
  for each row execute function public.check_notification_settings();

-- ----------------------------------------------------------------------------
-- Writing notifications
-- ----------------------------------------------------------------------------
create or replace function public.notify(
  p_user uuid, p_type text, p_actor uuid, p_subject_type text, p_subject_id uuid, p_label text,
  p_batch_key text default null, p_dedupe_key text default null, p_detail text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  s public.notification_settings%rowtype;
  v_push text;
begin
  if p_user is null or p_user is not distinct from p_actor then return; end if;
  if p_actor is not null and public.has_blocked(p_user, p_actor) then return; end if;
  select * into s from public.notification_settings where user_id = p_user;
  if found and p_type = any(s.muted_types) then return; end if;
  v_push := case when (case when found then p_type = any(s.push_types)
                            else p_type not in ('place_saved', 'place_rated') end) then 'pending' else 'none' end;
  if p_batch_key is not null then
    insert into public.notifications (user_id, type, actor_id, subject_type, subject_id, label, detail, batch_key, push_state)
    values (p_user, p_type, p_actor, p_subject_type, p_subject_id, left(p_label, 140), p_detail, p_batch_key, v_push)
    on conflict (user_id, batch_key) where read_at is null and batch_key is not null
    do update set count = notifications.count + 1, actor_id = excluded.actor_id, label = excluded.label,
                  updated_at = clock_timestamp();
  elsif p_dedupe_key is not null then
    insert into public.notifications (user_id, type, actor_id, subject_type, subject_id, label, detail, dedupe_key, push_state)
    values (p_user, p_type, p_actor, p_subject_type, p_subject_id, left(p_label, 140), p_detail, p_dedupe_key, v_push)
    on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  else
    insert into public.notifications (user_id, type, actor_id, subject_type, subject_id, label, detail, push_state)
    values (p_user, p_type, p_actor, p_subject_type, p_subject_id, left(p_label, 140), p_detail, v_push);
  end if;
end $$;
revoke all on function public.notify(uuid, text, uuid, text, uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.notify_on_follow()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  perform public.notify(new.following_id, 'new_follower', new.follower_id, 'profile', new.follower_id, null, null, 'follow:' || new.follower_id);
  return new;
end $$;
create trigger follows_notify after insert on public.follows for each row execute function public.notify_on_follow();

create or replace function public.notify_on_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  if auth.uid() is null then return new; end if;
  select * into e from public.events where id = new.event_id;
  perform public.notify(e.creator_id, 'event_joined', new.user_id, 'event', e.id, e.title, 'event_joined:' || e.id);
  return new;
end $$;
create trigger event_attendees_notify after insert on public.event_attendees for each row execute function public.notify_on_join();

-- Attendees hear about cancellations and changes to when or where.
create or replace function public.notify_on_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  if auth.uid() is null then return new; end if;
  if new.status = 'cancelled' and old.status = 'published' then
    for a in select user_id from public.event_attendees where event_id = new.id loop
      perform public.notify(a.user_id, 'event_cancelled', auth.uid(), 'event', new.id, new.title, null, 'event_cancelled:' || new.id);
    end loop;
  elsif new.status = 'published' and (new.starts_at, new.ends_at, new.location_name, new.address, new.lat, new.lng, new.place_id)
        is distinct from (old.starts_at, old.ends_at, old.location_name, old.address, old.lat, old.lng, old.place_id) then
    for a in select user_id from public.event_attendees where event_id = new.id loop
      perform public.notify(a.user_id, 'event_changed', auth.uid(), 'event', new.id, new.title, 'event_changed:' || new.id);
    end loop;
  end if;
  return new;
end $$;
create trigger events_notify after update on public.events for each row execute function public.notify_on_event_change();

create or replace function public.notify_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.conversations%rowtype;
  m record;
begin
  if auth.uid() is null then return new; end if;
  select * into c from public.conversations where id = new.conversation_id;
  for m in select user_id from public.conversation_members where conversation_id = c.id and user_id <> new.sender_id loop
    perform public.notify(m.user_id, 'new_message', new.sender_id, 'conversation', c.id,
      (select title from public.events where id = c.event_id), 'message:' || c.id);
  end loop;
  return new;
end $$;
create trigger messages_notify after insert on public.messages for each row execute function public.notify_on_message();

-- Saves are private: the owner hears how many, never who.
create or replace function public.notify_on_save()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p public.places%rowtype;
begin
  if auth.uid() is null then return new; end if;
  select * into p from public.places where id = new.place_id;
  if p.creator_id is null or p.creator_id = new.user_id then return new; end if;
  perform public.notify(p.creator_id, 'place_saved', null, 'place', p.id, p.name, 'place_saved:' || p.id);
  return new;
end $$;
create trigger saved_places_notify after insert on public.saved_places for each row execute function public.notify_on_save();

create or replace function public.notify_on_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p public.places%rowtype;
begin
  if auth.uid() is null then return new; end if;
  select * into p from public.places where id = new.place_id;
  perform public.notify(p.creator_id, 'place_rated', new.user_id, 'place', p.id, p.name, 'place_rated:' || p.id);
  return new;
end $$;
create trigger place_ratings_notify after insert on public.place_ratings for each row execute function public.notify_on_rating();

-- The reporter hears that their report was looked at (not by whom).
create or replace function public.notify_on_report_resolved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or old.status <> 'open' or new.status = 'open' then return new; end if;
  perform public.notify(new.reporter_id, 'report_resolved', null, 'report', new.id, null, null, 'report:' || new.id, new.status);
  return new;
end $$;
create trigger reports_notify after update of status on public.reports for each row execute function public.notify_on_report_resolved();

-- Owners hear when moderators remove or restore their content.
create or replace function public.notify_on_moderation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_label text;
begin
  if auth.uid() is null or new.action not in ('remove', 'restore') then return new; end if;
  if new.target_type = 'place' then
    select creator_id, name into v_owner, v_label from public.places where id = new.target_id;
  elsif new.target_type = 'event' then
    select creator_id, title into v_owner, v_label from public.events where id = new.target_id;
  elsif new.target_type = 'message' then
    select sender_id, null into v_owner, v_label from public.messages where id = new.target_id;
  else
    return new;
  end if;
  perform public.notify(v_owner, 'content_moderated', null, new.target_type, new.target_id, v_label, null, null, new.action);
  return new;
end $$;
create trigger moderation_actions_notify after insert on public.moderation_actions for each row execute function public.notify_on_moderation();

-- The trip planner tells its user a plan is ready (one unread at a time).
create or replace function public.notify_trip_plan_ready(p_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform public.notify(auth.uid(), 'trip_plan_ready', null, 'plan', null, left(btrim(coalesce(p_title, '')), 140), 'trip_plan');
end $$;
revoke all on function public.notify_trip_plan_ready(text) from public, anon;
grant execute on function public.notify_trip_plan_ready(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Reading
-- ----------------------------------------------------------------------------
create or replace function public.my_notifications(
  p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 30
) returns table (
  id uuid, type text, actor_id uuid, actor_username text, actor_display_name text, actor_avatar_url text,
  subject_type text, subject_id uuid, label text, detail text, count integer, created_at timestamptz, updated_at timestamptz, read_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select n.id, n.type, n.actor_id, a.username, a.display_name, a.avatar_url, n.subject_type, n.subject_id, n.label, n.detail,
         n.count, n.created_at, n.updated_at, n.read_at
  from public.notifications n left join public.profiles a on a.id = n.actor_id
  where n.user_id = auth.uid()
    and (p_before_at is null or (n.updated_at, n.id) < (p_before_at, p_before_id))
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 101);
$$;
revoke all on function public.my_notifications(timestamptz, uuid, integer) from public, anon;
grant execute on function public.my_notifications(timestamptz, uuid, integer) to authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql security invoker set search_path = public as $$
declare
  n integer;
begin
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- Reading a conversation also reads its message notification.
create or replace function public.mark_read(p_conversation uuid)
returns void language sql security invoker set search_path = public as $$
  update public.conversation_members set last_read_at = now()
  where conversation_id = p_conversation and user_id = auth.uid();
  update public.notifications set read_at = now()
  where user_id = auth.uid() and batch_key = 'message:' || p_conversation and read_at is null;
$$;

-- A device opts in; an endpoint moves to whoever signed in on it last. At most 10 per person.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('push:' || auth.uid()::text, 0));
  delete from public.push_subscriptions where endpoint = p_endpoint;
  if (select count(*) from public.push_subscriptions where user_id = auth.uid()) >= 10 then
    delete from public.push_subscriptions where id = (
      select id from public.push_subscriptions where user_id = auth.uid() order by created_at, id limit 1);
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end $$;
revoke all on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Scheduled work (service role only: the cron route)
-- ----------------------------------------------------------------------------
-- Reminders for everyone going: the day before (unless it is already under two
-- hours away) and within the hour. The dedupe keys make reruns harmless.
create or replace function public.schedule_event_reminders(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_before integer;
  v_after integer;
begin
  select count(*) into v_before from public.notifications where type in ('event_tomorrow', 'event_soon');
  for r in
    select a.user_id, e.id, e.title, e.starts_at from public.events e join public.event_attendees a on a.event_id = e.id
    where e.status = 'published' and e.starts_at > p_now and e.starts_at <= p_now + interval '24 hours'
  loop
    if r.starts_at <= p_now + interval '1 hour' then
      perform public.notify(r.user_id, 'event_soon', null, 'event', r.id, r.title, null, 'event_soon:' || r.id);
    elsif r.starts_at > p_now + interval '2 hours' then
      perform public.notify(r.user_id, 'event_tomorrow', null, 'event', r.id, r.title, null, 'event_tomorrow:' || r.id);
    end if;
  end loop;
  select count(*) into v_after from public.notifications where type in ('event_tomorrow', 'event_soon');
  return v_after - v_before;
end $$;

-- Claims pending pushes. Each is decided once, under a row lock, and marked
-- before anything is sent:
--   push turned off for the type, or no device      -> skipped
--   older than a day                                -> skipped
--   quiet hours                                     -> stays pending
--   the person already had p_daily_cap in 24 hours  -> capped (in-app only)
--   otherwise                                       -> sent, and returned with its devices
create or replace function public.claim_push_batch(p_now timestamptz default now(), p_limit integer default 100, p_daily_cap integer default 5)
returns table (notification_id uuid, user_id uuid, type text, actor_username text, subject_type text, subject_id uuid,
               label text, detail text, count integer, devices jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  n record;
  s public.notification_settings%rowtype;
  v_devices jsonb;
  v_hour integer;
begin
  for n in
    select x.* from public.notifications x where x.push_state = 'pending'
    order by x.created_at, x.id limit least(greatest(coalesce(p_limit, 100), 1), 1000)
    for update skip locked
  loop
    select * into s from public.notification_settings ns where ns.user_id = n.user_id;
    select coalesce(jsonb_agg(jsonb_build_object('endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth) order by d.created_at, d.id), '[]'::jsonb)
      into v_devices from public.push_subscriptions d where d.user_id = n.user_id;
    if (s.user_id is not null and not (n.type = any(s.push_types))) or v_devices = '[]'::jsonb or n.created_at < p_now - interval '24 hours' then
      update public.notifications set push_state = 'skipped' where id = n.id;
      continue;
    end if;
    if s.user_id is not null and s.quiet_start is not null then
      v_hour := extract(hour from p_now at time zone s.time_zone)::integer;
      if (s.quiet_start < s.quiet_end and v_hour >= s.quiet_start and v_hour < s.quiet_end)
         or (s.quiet_start > s.quiet_end and (v_hour >= s.quiet_start or v_hour < s.quiet_end)) then
        continue;
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('push_cap:' || n.user_id::text, 0));
    if (select count(*) from public.push_log l where l.user_id = n.user_id and l.sent_at > p_now - interval '24 hours') >= p_daily_cap then
      update public.notifications set push_state = 'capped' where id = n.id;
      continue;
    end if;
    update public.notifications set push_state = 'sent' where id = n.id;
    insert into public.push_log (user_id, notification_id, sent_at) values (n.user_id, n.id, p_now);
    return query select n.id, n.user_id, n.type, (select username from public.profiles where id = n.actor_id),
                        n.subject_type, n.subject_id, n.label, n.detail, n.count, v_devices;
  end loop;
end $$;

-- A device the push service says is gone.
create or replace function public.drop_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint;
$$;

-- Retention: read notifications go after 90 days, everything after 180; the push log after 2.
create or replace function public.purge_notifications(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  delete from public.notifications
  where (read_at is not null and updated_at < p_now - interval '90 days') or updated_at < p_now - interval '180 days';
  get diagnostics n = row_count;
  delete from public.push_log where sent_at < p_now - interval '2 days';
  return n;
end $$;

revoke all on function public.schedule_event_reminders(timestamptz) from public, anon, authenticated;
revoke all on function public.claim_push_batch(timestamptz, integer, integer) from public, anon, authenticated;
revoke all on function public.drop_push_subscription(text) from public, anon, authenticated;
revoke all on function public.purge_notifications(timestamptz) from public, anon, authenticated;
grant execute on function public.schedule_event_reminders(timestamptz) to service_role;
grant execute on function public.claim_push_batch(timestamptz, integer, integer) to service_role;
grant execute on function public.drop_push_subscription(text) to service_role;
grant execute on function public.purge_notifications(timestamptz) to service_role;
