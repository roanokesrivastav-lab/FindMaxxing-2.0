-- ============================================================================
-- FindMaxxing — direct messages and event group chats.
--
--   * conversations (direct, or one group per event), conversation_members,
--     messages. RLS: only members read a conversation; members write only as
--     themselves; membership changes only through the functions below.
--   * Group chats follow attendance: joining an event joins its chat, leaving
--     it leaves the chat (trigger on event_attendees).
--   * The anti-spam rule: you can start a direct conversation only with
--     someone who follows you back (mutual follow), or who is attending an
--     event you are both going to. Nobody can be messaged out of the blue.
--   * Blocking: a blocked person cannot message you (directs are refused both
--     ways), you no longer see their messages, and they no longer see you in
--     member lists.
--   * Messages can be reported (into the Session 8 queue) and removed by
--     moderators; they are rate limited (60 an hour) and suspended accounts
--     cannot send. A deleted account's messages are deleted with it.
--   * Message text is never indexed for search (no trigram or text index on
--     body) and no discovery function reads it.
-- ============================================================================

create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('direct', 'group')),
  -- Group chats belong to one event and go with it.
  event_id    uuid unique references public.events (id) on delete cascade,
  -- Directs: the two member ids, sorted and joined, so a pair has one conversation.
  direct_key  text unique,
  created_at  timestamptz not null default now(),
  last_message_at timestamptz,
  check ((kind = 'group') = (event_id is not null)),
  check ((kind = 'direct') = (direct_key is not null))
);

create table public.conversation_members (
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,
  joined_at        timestamptz not null default now(),
  -- Read receipts: everything up to here has been seen.
  last_read_at     timestamptz,
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  sender_id        uuid not null references public.profiles (id) on delete cascade,
  body             text not null check (char_length(btrim(body)) between 1 and 2000),
  -- Wall-clock time, not the transaction start: messages sent together keep their order.
  created_at       timestamptz not null default clock_timestamp(),
  removed_at       timestamptz
);
create index messages_conversation_time_idx on public.messages (conversation_id, created_at, id);

create table public.blocks (
  blocker_id  uuid not null references public.profiles (id) on delete cascade,
  blocked_id  uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.blocks enable row level security;

-- Definer helpers so policies do not recurse into the members table's own policy.
create or replace function public.is_conversation_member(p_conversation uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from public.conversation_members m where m.conversation_id = p_conversation and m.user_id = auth.uid());
$$;

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
-- a blocked b (one direction).
create or replace function public.has_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.blocks where blocker_id = a and blocked_id = b);
$$;
revoke all on function public.is_conversation_member(uuid) from public, anon;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon;
revoke all on function public.has_blocked(uuid, uuid) from public, anon;
grant execute on function public.has_blocked(uuid, uuid) to authenticated;
grant execute on function public.is_conversation_member(uuid) to authenticated;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;

create policy "members see their conversations" on public.conversations for select
  using (public.is_conversation_member(id));
revoke insert, update, delete on public.conversations from anon, authenticated;

-- Members see each other, except someone who blocked them.
create policy "members see fellow members" on public.conversation_members for select
  using (
    public.is_conversation_member(conversation_id)
    and not public.has_blocked(conversation_members.user_id, auth.uid())
  );
-- Only your own read marker can change.
create policy "members mark their own reads" on public.conversation_members for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke insert, update, delete on public.conversation_members from anon, authenticated;
grant update (last_read_at) on public.conversation_members to authenticated;

-- Members read messages, minus removed ones and those from people they blocked.
create policy "members read messages" on public.messages for select
  using (
    public.is_conversation_member(conversation_id)
    and removed_at is null
    and not public.has_blocked(auth.uid(), messages.sender_id)
  );
create policy "members send as themselves" on public.messages for insert
  with check (sender_id = auth.uid() and removed_at is null and public.is_conversation_member(conversation_id));
revoke update, delete on public.messages from anon, authenticated;

create policy "users see their own blocks" on public.blocks for select using (blocker_id = auth.uid());
create policy "users block as themselves" on public.blocks for insert with check (blocker_id = auth.uid());
create policy "users unblock their own" on public.blocks for delete using (blocker_id = auth.uid());
revoke update on public.blocks from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Writing rules
-- ----------------------------------------------------------------------------
insert into public.rate_limit_rules (action, max_count, window_seconds, label) values ('messages', 60, 3600, 'messages');

create trigger messages_rate_limit before insert on public.messages for each row execute function public.enforce_rate_limit('messages');
create trigger messages_block_suspended before insert or update or delete on public.messages for each row execute function public.block_suspended_writes();
create trigger blocks_block_suspended before insert or update or delete on public.blocks for each row execute function public.block_suspended_writes();

-- No sending into a direct conversation across a block, or into the chat of an
-- event that is no longer published; keep last_message_at current.
create or replace function public.check_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  c public.conversations%rowtype;
begin
  select * into c from public.conversations where id = new.conversation_id;
  if c.kind = 'direct' and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = c.id and m.user_id <> new.sender_id and public.is_blocked_between(m.user_id, new.sender_id)
  ) then
    raise exception 'messaging:blocked' using errcode = 'P0001';
  end if;
  if c.kind = 'group' and not exists (select 1 from public.events e where e.id = c.event_id and e.status = 'published') then
    raise exception 'messaging:closed' using errcode = 'P0001';
  end if;
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;
create trigger messages_check before insert on public.messages for each row execute function public.check_message();

-- The anti-spam rule, for the current user and another person.
create or replace function public.can_message(p_other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and p_other <> auth.uid()
    and not public.is_blocked_between(auth.uid(), p_other)
    and (
      public.is_mutual_follow(p_other)
      or exists (
        select 1 from public.event_attendees a join public.event_attendees b on b.event_id = a.event_id
        join public.events e on e.id = a.event_id
        where a.user_id = auth.uid() and b.user_id = p_other and e.status = 'published'
      )
    );
$$;
revoke all on function public.can_message(uuid) from public, anon;
grant execute on function public.can_message(uuid) to authenticated;

-- Opens (or finds) the direct conversation with someone you may message.
create or replace function public.start_direct(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  k text;
  cid uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then raise exception 'messaging:not_found' using errcode = 'P0002'; end if;
  if not public.can_message(p_other) then raise exception 'messaging:not_allowed' using errcode = 'P0001'; end if;
  k := least(auth.uid()::text, p_other::text) || ':' || greatest(auth.uid()::text, p_other::text);
  perform pg_advisory_xact_lock(hashtextextended('direct:' || k, 0));
  select id into cid from public.conversations where direct_key = k;
  if cid is null then
    insert into public.conversations (kind, direct_key) values ('direct', k) returning id into cid;
    insert into public.conversation_members (conversation_id, user_id) values (cid, auth.uid()), (cid, p_other);
  end if;
  return cid;
end $$;
revoke all on function public.start_direct(uuid) from public, anon;
grant execute on function public.start_direct(uuid) to authenticated;

-- Group chats follow attendance.
create or replace function public.sync_event_chat()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
begin
  if tg_op = 'INSERT' then
    insert into public.conversations (kind, event_id) values ('group', new.event_id)
    on conflict (event_id) do nothing;
    select id into cid from public.conversations where event_id = new.event_id;
    insert into public.conversation_members (conversation_id, user_id) values (cid, new.user_id) on conflict do nothing;
    return new;
  end if;
  delete from public.conversation_members m using public.conversations c
   where c.event_id = old.event_id and m.conversation_id = c.id and m.user_id = old.user_id;
  return old;
end $$;
create trigger event_attendees_sync_chat after insert or delete on public.event_attendees
  for each row execute function public.sync_event_chat();

-- Existing attendance gets its chats too.
insert into public.conversations (kind, event_id) select distinct 'group', event_id from public.event_attendees on conflict do nothing;
insert into public.conversation_members (conversation_id, user_id)
  select c.id, a.user_id from public.event_attendees a join public.conversations c on c.event_id = a.event_id on conflict do nothing;

-- The caller's conversations, most recent activity first, with unread counts
-- (messages from others after their read marker, minus blocked senders).
create or replace function public.my_conversations()
returns table (
  id uuid, kind text, event_id uuid, event_title text, other_id uuid, other_username text, other_display_name text, other_avatar_url text,
  last_message_at timestamptz, last_body text, last_sender_id uuid, unread integer
)
language sql stable security invoker set search_path = public as $$
  select c.id, c.kind, c.event_id, e.title, op.id, op.username, op.display_name, op.avatar_url,
         c.last_message_at, lm.body, lm.sender_id,
         (select count(*)::integer from public.messages m
           where m.conversation_id = c.id and m.sender_id <> auth.uid()
             and (me.last_read_at is null or m.created_at > me.last_read_at))
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = auth.uid()
  left join public.events e on e.id = c.event_id
  -- The other person comes from the pair key, so a direct stays labelled even
  -- when they blocked the caller (and are hidden from the member list).
  left join public.profiles op on c.kind = 'direct'
    and op.id = (case when split_part(c.direct_key, ':', 1) = auth.uid()::text
                      then split_part(c.direct_key, ':', 2) else split_part(c.direct_key, ':', 1) end)::uuid
  left join lateral (select m.body, m.sender_id from public.messages m where m.conversation_id = c.id order by m.created_at desc, m.id desc limit 1) lm on true
  order by coalesce(c.last_message_at, c.created_at) desc, c.id;
$$;
revoke all on function public.my_conversations() from public, anon;
grant execute on function public.my_conversations() to authenticated;

-- Read receipts use the database clock, like message times.
create or replace function public.mark_read(p_conversation uuid)
returns void language sql security invoker set search_path = public as $$
  update public.conversation_members set last_read_at = now()
  where conversation_id = p_conversation and user_id = auth.uid();
$$;
revoke all on function public.mark_read(uuid) from public, anon;
grant execute on function public.mark_read(uuid) to authenticated;

-- One page of a conversation, newest first, before an exclusive keyset
-- (created_at, id). Invoker rights: the messages policy decides what is visible.
create or replace function public.conversation_messages(
  p_conversation uuid, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 50
) returns table (id uuid, sender_id uuid, body text, created_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select m.id, m.sender_id, m.body, m.created_at from public.messages m
  where m.conversation_id = p_conversation
    and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 101);
$$;
revoke all on function public.conversation_messages(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.conversation_messages(uuid, timestamptz, uuid, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Reports and moderation for messages
-- ----------------------------------------------------------------------------
alter table public.reports drop constraint reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('place', 'event', 'profile', 'message'));
alter table public.moderation_actions drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in ('place', 'event', 'profile', 'message', 'category', 'interest'));

-- Only a member can report a message (they are the only ones who saw it).
create or replace function public.check_report_target()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.target_type = 'place' and not exists (select 1 from public.places where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  elsif new.target_type = 'event' and not exists (select 1 from public.events where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  elsif new.target_type = 'profile' and not exists (select 1 from public.profiles where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  elsif new.target_type = 'message' and not exists (
    select 1 from public.messages m join public.conversation_members cm on cm.conversation_id = m.conversation_id
    where m.id = new.target_id and cm.user_id = new.reporter_id
  ) then
    raise exception 'Report target does not exist' using errcode = '23503';
  end if;
  return new;
end $$;

-- A message's moderation status, for the queue and the RPC.
create or replace function public.message_status(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case when removed_at is null then 'published' else 'removed' end from public.messages where id = p_id;
$$;
revoke all on function public.message_status(uuid) from public, anon, authenticated;

-- moderate_target, as in 0010, plus messages (remove / restore set removed_at).
create or replace function public.moderate_target(
  p_target_type text, p_target_id uuid, p_action text, p_reason text default null
) returns table (status_after text, resolved_reports integer)
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before text;
  v_after text;
  v_report_status text;
  v_resolved integer;
begin
  if not public.is_moderator() then raise exception 'Moderators only' using errcode = '42501'; end if;
  if p_target_type not in ('place', 'event', 'profile', 'message') then raise exception 'moderation:invalid_target' using errcode = 'P0001'; end if;
  if p_action not in ('dismiss', 'review', 'remove', 'restore') then raise exception 'moderation:invalid_action' using errcode = 'P0001'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'moderation:reason_too_long' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('moderation:' || p_target_type || ':' || p_target_id::text, 0));
  if p_target_type = 'place' then
    select p.status into v_before from public.places p where p.id = p_target_id for update;
  elsif p_target_type = 'event' then
    select e.status into v_before from public.events e where e.id = p_target_id for update;
  elsif p_target_type = 'message' then
    select case when m.removed_at is null then 'published' else 'removed' end into v_before from public.messages m where m.id = p_target_id for update;
  else
    perform 1 from public.profiles pr where pr.id = p_target_id;
  end if;
  if not found then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;

  v_after := v_before;
  if p_action = 'remove' then
    if p_target_type = 'profile' then raise exception 'moderation:cannot_remove_profile' using errcode = 'P0001'; end if;
    if v_before = 'removed' then raise exception 'moderation:already_removed' using errcode = 'P0001'; end if;
    if v_reason is null then raise exception 'moderation:reason_required' using errcode = 'P0001'; end if;
    v_after := 'removed'; v_report_status := 'reviewed';
  elsif p_action = 'restore' then
    if v_before is distinct from 'removed' then raise exception 'moderation:not_removed' using errcode = 'P0001'; end if;
    v_after := 'published'; v_report_status := 'dismissed';
  elsif p_action = 'dismiss' then
    v_report_status := 'dismissed';
  else
    v_report_status := 'reviewed';
  end if;

  update public.reports r set status = v_report_status, resolved_at = now()
   where r.target_type = p_target_type and r.target_id = p_target_id and r.status = 'open';
  get diagnostics v_resolved = row_count;
  if p_action in ('dismiss', 'review') and v_resolved = 0 then raise exception 'moderation:nothing_open' using errcode = 'P0001'; end if;

  if v_after is distinct from v_before then
    perform set_config('findmaxxing.moderation', 'on', true);
    if p_target_type = 'place' then
      update public.places set status = v_after where id = p_target_id;
    elsif p_target_type = 'event' then
      update public.events set status = v_after where id = p_target_id;
    else
      update public.messages set removed_at = case when v_after = 'removed' then now() else null end where id = p_target_id;
    end if;
    perform set_config('findmaxxing.moderation', 'off', true);
  end if;

  insert into public.moderation_actions (moderator_id, action, target_type, target_id, reason, status_before, status_after, resolved_reports)
  values (auth.uid(), p_action, p_target_type, p_target_id, v_reason, v_before, v_after, v_resolved);
  return query select v_after, v_resolved;
end $$;

-- The queue and snapshot learn messages: the label is the start of the text.
create or replace function public.moderation_queue(
  p_after_first timestamptz default null, p_after_id uuid default null, p_limit integer default 31
) returns table (target_type text, target_id uuid, report_count integer, first_reported_at timestamptz, last_reported_at timestamptz, reasons text[], target_label text, target_status text)
language sql stable security definer set search_path = public as $$
  with grouped as (
    select r.target_type, r.target_id, count(*)::integer as report_count, min(r.created_at) as first_reported_at,
           max(r.created_at) as last_reported_at, array_agg(distinct r.reason order by r.reason) as reasons
    from public.reports r where r.status = 'open' group by r.target_type, r.target_id
  )
  select g.target_type, g.target_id, g.report_count, g.first_reported_at, g.last_reported_at, g.reasons,
         case g.target_type
           when 'place' then (select p.name from public.places p where p.id = g.target_id)
           when 'event' then (select e.title from public.events e where e.id = g.target_id)
           when 'message' then (select left(m.body, 60) from public.messages m where m.id = g.target_id)
           else (select pr.display_name from public.profiles pr where pr.id = g.target_id)
         end,
         case g.target_type
           when 'place' then (select p.status from public.places p where p.id = g.target_id)
           when 'event' then (select e.status from public.events e where e.id = g.target_id)
           when 'message' then public.message_status(g.target_id)
           else (select case when exists (select 1 from public.local_revocations lr where lr.user_id = g.target_id) then 'revoked' else 'active' end)
         end
  from grouped g
  where public.is_moderator()
    and (p_after_first is null or (g.first_reported_at, g.target_id) > (p_after_first, p_after_id))
  order by g.first_reported_at, g.target_id
  limit least(greatest(coalesce(p_limit, 31), 1), 101);
$$;

create or replace function public.moderation_target(p_target_type text, p_target_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case
    when not public.is_moderator() then null
    when p_target_type = 'place' then (
      select jsonb_build_object('label', p.name, 'status', p.status, 'visibility', p.visibility, 'city', p.city,
        'neighborhood', p.neighborhood, 'body', p.description, 'extra', p.local_tip,
        'ownerId', p.creator_id, 'ownerUsername', o.username, 'createdAt', p.created_at)
      from public.places p left join public.profiles o on o.id = p.creator_id where p.id = p_target_id)
    when p_target_type = 'event' then (
      select jsonb_build_object('label', e.title, 'status', e.status, 'visibility', null, 'city', null,
        'neighborhood', null, 'body', e.description, 'extra', e.location_name,
        'ownerId', e.creator_id, 'ownerUsername', o.username, 'createdAt', e.created_at)
      from public.events e left join public.profiles o on o.id = e.creator_id where e.id = p_target_id)
    when p_target_type = 'message' then (
      select jsonb_build_object('label', left(m.body, 60), 'status', public.message_status(m.id), 'visibility', null, 'city', null,
        'neighborhood', null, 'body', m.body, 'extra', null,
        'ownerId', m.sender_id, 'ownerUsername', o.username, 'createdAt', m.created_at)
      from public.messages m left join public.profiles o on o.id = m.sender_id where m.id = p_target_id)
    when p_target_type = 'profile' then (
      select jsonb_build_object('label', pr.display_name, 'status',
        case when exists (select 1 from public.local_revocations lr where lr.user_id = pr.id) then 'revoked' else 'active' end,
        'visibility', null, 'city', pr.home_city, 'neighborhood', null, 'body', pr.bio, 'extra', null,
        'ownerId', pr.id, 'ownerUsername', pr.username, 'createdAt', pr.created_at)
      from public.profiles pr where pr.id = p_target_id)
    else null
  end;
$$;

-- Realtime (Supabase only): broadcast message inserts; RLS filters who receives them.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end $$;
