-- Forward-only repair of audit F6 (push destinations) and F8 (block privacy).
-- Existing unsupported subscriptions remain stored, but cannot be sent by the
-- hardened server. New/updated rows must use supported push-provider hosts.
create or replace function public.is_web_push_endpoint(p_endpoint text)
returns boolean language sql immutable security invoker set search_path = pg_catalog as $$
  select coalesce(char_length(p_endpoint) <= 1000
    and p_endpoint !~ '[[:cntrl:][:space:]]'
    and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)+push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)(:443)?/[^[:space:]\\#]+$', false);
$$;
revoke all on function public.is_web_push_endpoint(text) from public, anon;
grant execute on function public.is_web_push_endpoint(text) to authenticated, service_role;

alter table public.push_subscriptions add constraint push_subscriptions_provider_check
  check (kind <> 'web' or public.is_web_push_endpoint(endpoint)) not valid;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if not public.is_web_push_endpoint(p_endpoint) then raise exception 'Invalid push subscription' using errcode = '22023'; end if;
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

-- Unrestricted block predicates are for trusted database internals only.
-- This schema is not an API schema, and API roles have no usage/execute grants.
create schema if not exists findmaxxing_private;
revoke all on schema findmaxxing_private from public, anon, authenticated, service_role;

create or replace function findmaxxing_private.has_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists (select 1 from public.blocks where blocker_id = a and blocked_id = b);
$$;
create or replace function findmaxxing_private.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists (select 1 from public.blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke all on function findmaxxing_private.has_blocked(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function findmaxxing_private.is_blocked_between(uuid, uuid) from public, anon, authenticated, service_role;

-- Existing policies and the web/mobile RPC contract still use these public
-- functions. They reveal only relationships involving the current viewer.
create or replace function public.has_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select case when auth.uid() = a or auth.uid() = b
    then findmaxxing_private.has_blocked(a, b) else false end;
$$;
create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select case when auth.uid() = a or auth.uid() = b
    then findmaxxing_private.is_blocked_between(a, b) else false end;
$$;
revoke all on function public.has_blocked(uuid, uuid) from public, anon;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon;
grant execute on function public.has_blocked(uuid, uuid), public.is_blocked_between(uuid, uuid) to authenticated;

-- A trusted message trigger can run without a viewer (e.g. service jobs).
create or replace function public.check_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.conversations%rowtype;
begin
  select * into c from public.conversations where id = new.conversation_id;
  if c.kind = 'direct' and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = c.id and m.user_id <> new.sender_id
      and findmaxxing_private.is_blocked_between(m.user_id, new.sender_id)
  ) then
    raise exception 'messaging:blocked' using errcode = 'P0001';
  end if;
  if c.kind = 'group' and not exists (select 1 from public.events e where e.id = c.event_id and e.status = 'published') then
    raise exception 'messaging:closed' using errcode = 'P0001';
  end if;
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;

-- Notification recipients/actors need not involve the invoking viewer. Keep
-- their suppression rule internal so moderation and scheduled work still work.
create or replace function public.notify(
  p_user uuid, p_type text, p_actor uuid, p_subject_type text, p_subject_id uuid, p_label text,
  p_batch_key text default null, p_dedupe_key text default null, p_detail text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  s public.notification_settings%rowtype;
  v_push text;
begin
  if p_user is null or p_user is not distinct from p_actor then return; end if;
  if p_actor is not null and findmaxxing_private.has_blocked(p_user, p_actor) then return; end if;
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
