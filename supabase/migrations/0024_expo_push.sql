-- ============================================================================
-- FindMaxxing — Expo push tokens for the mobile app (Session 19).
--
-- The native app registers an Expo push token in the same table as web push
-- subscriptions (0021_notifications.sql), so preferences, quiet hours, the
-- daily cap and claim-before-send apply to phones exactly as to browsers. A
-- device is one row; a token, like an endpoint, belongs to whoever signed in
-- on it last.
-- ============================================================================

alter table public.push_subscriptions add column kind text not null default 'web' check (kind in ('web', 'expo'));
alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_check;
alter table public.push_subscriptions alter column p256dh drop not null;
alter table public.push_subscriptions alter column auth drop not null;
alter table public.push_subscriptions add constraint push_subscriptions_device_check check (
  (kind = 'web' and endpoint ~ '^https://' and char_length(endpoint) <= 1000 and p256dh is not null and auth is not null)
  or (kind = 'expo' and endpoint ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$' and p256dh is null and auth is null));

create or replace function public.save_expo_push_token(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('push:' || auth.uid()::text, 0));
  delete from public.push_subscriptions where endpoint = p_token;
  if (select count(*) from public.push_subscriptions where user_id = auth.uid()) >= 10 then
    delete from public.push_subscriptions where id = (
      select id from public.push_subscriptions where user_id = auth.uid() order by created_at, id limit 1);
  end if;
  insert into public.push_subscriptions (user_id, kind, endpoint) values (auth.uid(), 'expo', p_token);
end $$;
revoke all on function public.save_expo_push_token(text) from public, anon;
grant execute on function public.save_expo_push_token(text) to authenticated;

-- claim_push_batch, as in 0021, now saying which kind each device is.
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
    select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'endpoint', d.endpoint, 'p256dh', d.p256dh, 'auth', d.auth) order by d.created_at, d.id), '[]'::jsonb)
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

revoke all on function public.claim_push_batch(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_push_batch(timestamptz, integer, integer) to service_role;
