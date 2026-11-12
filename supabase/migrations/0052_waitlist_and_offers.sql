-- ============================================================================
-- FindMaxxing — 4.4: waitlist, offers and the atomic join (docs/features/4.0.md
-- §6, §7, §11, §13; docs/features/4.4.md).
--
-- The rules this file exists to keep:
--   * ONE LOCK ORDER. Every path that can change who holds a seat first takes
--       select … from public.events where id = <event> for update
--     the same lock the join trigger, reserve_ticket() and set_event_price()
--     already take. A participant row is locked second, never first.
--   * ONE CAPACITY DEFINITION. findmaxxing_private.seats_taken() =
--       going + live offers + live pending paid holds
--     where "live" is compared against clock_timestamp() at the moment of
--     asking. The join trigger, join_event, accept_offer, offer_next,
--     reserve_ticket, the capacity-edit guard and events_readiness all call it.
--   * event_attendees STILL MEANS EXACTLY "GOING". Every other state lives in
--     event_participants, and a person never has a row in both for one event.
--   * Waitlists and offers are for free events. Paid events keep their flow.
--   * Clients no longer insert or delete event_attendees rows (phase 2, D-I):
--     the definer functions here, confirm_ticket() and mark_ticket_refunded()
--     are the only writers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Notification types: an offer, and an offer that ran out. The offer dedupe
-- keys carry two ids and a timestamp, so the key length limit goes up.
-- ----------------------------------------------------------------------------
alter table public.notifications drop constraint notifications_dedupe_key_check;
alter table public.notifications add constraint notifications_dedupe_key_check check (dedupe_key is null or char_length(dedupe_key) <= 200);

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_not_happening', 'event_offer', 'event_offer_expired'));

create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_not_happening', 'event_offer', 'event_offer_expired'];
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
  'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready', 'event_not_happening',
  'event_offer', 'event_offer_expired'];
-- People who have event changes pushed get offers pushed: an offer is time-limited.
update public.notification_settings set push_types = push_types || array['event_offer', 'event_offer_expired']
  where 'event_changed' = any(push_types) and not ('event_offer' = any(push_types));

-- ----------------------------------------------------------------------------
-- Participants: every state that is not "going".
-- ----------------------------------------------------------------------------
create sequence public.event_waitlist_seq;
revoke all on sequence public.event_waitlist_seq from public, anon, authenticated;

create table public.event_participants (
  event_id          uuid not null references public.events (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  status            text not null check (status in ('interested', 'waitlisted', 'offered', 'declined', 'left')),
  -- FIFO place in line, from one global sequence. Kept while a person is skipped as ineligible.
  queue_position    bigint,
  offered_at        timestamptz,
  offer_expires_at  timestamptz,
  reason            text check (reason is null or reason in ('declined', 'expired', 'removed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (event_id, user_id),
  check ((status = 'waitlisted') = (queue_position is not null)),
  check ((status = 'offered') = (offered_at is not null and offer_expires_at is not null))
);
create index event_participants_queue_idx on public.event_participants (event_id, queue_position) where status = 'waitlisted';
create index event_participants_offers_idx on public.event_participants (offer_expires_at) where status = 'offered';
create index event_participants_user_idx on public.event_participants (user_id);

-- Whether the caller runs this event (its creator; 0053 adds series hosts).
-- For RLS policies, which cannot reach the private schema.
create or replace function public.is_event_host(p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select findmaxxing_private.can_host_event(p_event, auth.uid());
$$;
revoke all on function public.is_event_host(uuid) from public, anon, authenticated;
grant execute on function public.is_event_host(uuid) to anon, authenticated, service_role;

alter table public.event_participants enable row level security;
-- People see their own row; hosts see every row of their events. Everyone else
-- gets counts only, through events_readiness().
create policy "own row or host" on public.event_participants for select
  using (user_id = auth.uid() or public.is_event_host(event_id));
revoke all on public.event_participants from anon, authenticated;
grant select on public.event_participants to authenticated;

-- A person is going OR has a participant row, never both. The other half of
-- this invariant is in check_event_join(), which deletes the participant row.
create or replace function public.guard_event_participant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.event_attendees a where a.event_id = new.event_id and a.user_id = new.user_id) then
    raise exception 'events:already_going' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger event_participants_guard before insert or update on public.event_participants
  for each row execute function public.guard_event_participant();

-- ----------------------------------------------------------------------------
-- Capacity accounting: the one definition (extends 0051).
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.seats_taken(p_event uuid)
returns integer language sql volatile security definer set search_path = public as $$
  select ((select count(*) from public.event_attendees a where a.event_id = p_event)
        + (select count(*) from public.event_participants p where p.event_id = p_event and p.status = 'offered' and p.offer_expires_at > clock_timestamp())
        + (select count(*) from public.tickets t where t.event_id = p_event and t.status = 'pending' and t.expires_at > clock_timestamp()))::integer;
$$;
revoke all on function findmaxxing_private.seats_taken(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Whether another person could see the event (D-M: skipped at offer time if
-- not). can_view_event() and everything under it answer for auth.uid(), so the
-- question is asked as that person and the caller is put back straight after.
-- The setting is transaction-local; an error aborts the transaction anyway.
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.can_user_view_event(p_user uuid, p_event uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_previous text := current_setting('request.jwt.claim.sub', true);
  v_ok boolean;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  v_ok := public.can_view_event(p_event);
  perform set_config('request.jwt.claim.sub', coalesce(v_previous, ''), true);
  return coalesce(v_ok, false);
end $$;
revoke all on function findmaxxing_private.can_user_view_event(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- offer_next: hand open seats to the people at the front of the line.
-- Internal. Callers already hold the event lock; it is taken again here so a
-- caller that forgot still serializes (re-locking a row you hold is free).
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.offer_next(p_event uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  v_user uuid;
  v_skipped uuid[] := '{}';
  v_at timestamptz;
  n integer := 0;
begin
  select * into e from public.events where id = p_event for update;
  -- Free, published, not over, and not inside the 30-minute cutoff (D-D):
  -- inside it a freed seat is simply open.
  if not found or e.status <> 'published' or e.price_cents is not null
     or coalesce(e.ends_at, e.starts_at) < now()
     or clock_timestamp() >= e.starts_at - interval '30 minutes' then
    return 0;
  end if;
  loop
    exit when e.capacity is not null and findmaxxing_private.seats_taken(p_event) >= e.capacity;
    select p.user_id into v_user from public.event_participants p
    where p.event_id = p_event and p.status = 'waitlisted' and not (p.user_id = any(v_skipped))
    order by p.queue_position limit 1 for update;
    exit when not found;
    -- D-M: suspended, closing, or no longer able to see it: skipped, place kept.
    if exists (select 1 from public.suspensions s where s.user_id = v_user)
       or exists (select 1 from public.account_deletion_jobs j where j.user_id = v_user)
       or not findmaxxing_private.can_user_view_event(v_user, p_event) then
      v_skipped := v_skipped || v_user;
      continue;
    end if;
    v_at := clock_timestamp();
    update public.event_participants
       set status = 'offered', queue_position = null, offered_at = v_at, reason = null,
           offer_expires_at = least(v_at + interval '2 hours', e.starts_at - interval '30 minutes')
     where event_id = p_event and user_id = v_user;
    -- Explicit, with a null actor: nobody "did" this, and the change trigger
    -- says nothing for service work. One notification per offer, however often this runs.
    perform public.notify(v_user, 'event_offer', null, 'event', e.id, e.title, null,
      'event_offer:' || e.id || ':' || v_user || ':' || (extract(epoch from v_at) * 1000000)::bigint);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function findmaxxing_private.offer_next(uuid) from public, anon, authenticated, service_role;

-- Offers past their expiry at p_now become declined/expired, their holders are
-- told once, and the seats are passed on. Callers hold the event lock.
create or replace function findmaxxing_private.settle_offers(p_event uuid, p_now timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_title text;
  n integer := 0;
begin
  perform 1 from public.events where id = p_event for update;
  select title into v_title from public.events where id = p_event;
  for r in
    select p.user_id, p.offered_at from public.event_participants p
    where p.event_id = p_event and p.status = 'offered' and p.offer_expires_at <= p_now
    order by p.offered_at for update
  loop
    update public.event_participants
       set status = 'declined', reason = 'expired', offered_at = null, offer_expires_at = null
     where event_id = p_event and user_id = r.user_id;
    perform public.notify(r.user_id, 'event_offer_expired', null, 'event', p_event, v_title, null,
      'event_offer_expired:' || p_event || ':' || r.user_id || ':' || (extract(epoch from r.offered_at) * 1000000)::bigint);
    n := n + 1;
  end loop;
  perform findmaxxing_private.offer_next(p_event);
  return n;
end $$;
revoke all on function findmaxxing_private.settle_offers(uuid, timestamptz) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The join rule for every insert into event_attendees, whoever makes it
-- (replaces 0022). Under the event lock it uses seats_taken(); a person with a
-- live offer converts it, because the offer already holds their seat.
-- ----------------------------------------------------------------------------
create or replace function public.check_event_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  p public.event_participants%rowtype;
  v_has_offer boolean;
begin
  select * into ev from public.events where id = new.event_id for update;
  if not found or ev.status <> 'published' then
    raise exception 'Event is not open for joining' using errcode = 'P0001';
  end if;
  if coalesce(ev.ends_at, ev.starts_at) < now() then
    raise exception 'This event has already ended' using errcode = 'P0001';
  end if;
  if ev.price_cents is not null and new.user_id is distinct from ev.creator_id
     and not exists (select 1 from public.tickets t where t.event_id = ev.id and t.user_id = new.user_id and t.status = 'paid') then
    raise exception 'payments:ticket_required' using errcode = 'P0001';
  end if;
  -- Offers that ran out stop holding and pass on before the seat is judged,
  -- so nobody takes a seat that the next person in line is owed.
  perform findmaxxing_private.settle_offers(ev.id, clock_timestamp());
  select * into p from public.event_participants where event_id = new.event_id and user_id = new.user_id for update;
  v_has_offer := found and p.status = 'offered' and p.offer_expires_at > clock_timestamp();
  if ev.capacity is not null and not v_has_offer and findmaxxing_private.seats_taken(ev.id) >= ev.capacity then
    raise exception 'This event is full' using errcode = 'P0001';
  end if;
  delete from public.event_participants where event_id = new.event_id and user_id = new.user_id;
  return new;
end $$;

-- A seat given up, however it happened (leave, refund, removal, an account
-- deleted, moderation), is handed on. Nothing happens while the event itself
-- is being deleted (its row is gone) or when it is not published.
create or replace function public.offer_seat_after_leave()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform findmaxxing_private.offer_next(old.event_id);
  return null;
end $$;
-- Named to run after the chat, notification and interaction triggers.
create trigger event_attendees_z_offer_next after delete on public.event_attendees
  for each row execute function public.offer_seat_after_leave();

-- Capacity going up frees seats; a moved start moves the offer cutoff.
create or replace function public.offers_follow_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.starts_at is distinct from old.starts_at then
    update public.event_participants
       set offer_expires_at = least(offer_expires_at, greatest(offered_at, new.starts_at - interval '30 minutes'))
     where event_id = new.id and status = 'offered';
  end if;
  if new.status = 'published' and (new.capacity is distinct from old.capacity or new.starts_at is distinct from old.starts_at) then
    perform findmaxxing_private.offer_next(new.id);
  end if;
  return null;
end $$;
create trigger events_offers_follow_change after update of capacity, starts_at on public.events
  for each row execute function public.offers_follow_event_change();

-- ----------------------------------------------------------------------------
-- Atomic RPCs. All: active account, then the event lock, then anything else.
-- ----------------------------------------------------------------------------
create or replace function public.join_event(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  p public.event_participants%rowtype;
  v_has_offer boolean;
begin
  perform findmaxxing_private.require_active_account();
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if e.status <> 'published' then raise exception 'Event is not open for joining' using errcode = 'P0001'; end if;
  if coalesce(e.ends_at, e.starts_at) < now() then raise exception 'This event has already ended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    return 'going';
  end if;
  if e.price_cents is not null then
    -- Paid events have no waitlist (D-L): a ticket holder or the host takes a
    -- seat if one is free, and the trigger answers "full" otherwise.
    if e.creator_id is distinct from auth.uid()
       and not exists (select 1 from public.tickets t where t.event_id = p_event and t.user_id = auth.uid() and t.status = 'paid') then
      raise exception 'payments:ticket_required' using errcode = 'P0001';
    end if;
    insert into public.event_attendees (event_id, user_id) values (p_event, auth.uid());
    return 'going';
  end if;
  perform findmaxxing_private.settle_offers(p_event, clock_timestamp());
  select * into p from public.event_participants where event_id = p_event and user_id = auth.uid() for update;
  v_has_offer := found and p.status = 'offered' and p.offer_expires_at > clock_timestamp();
  if v_has_offer or e.capacity is null or findmaxxing_private.seats_taken(p_event) < e.capacity then
    insert into public.event_attendees (event_id, user_id) values (p_event, auth.uid());
    return 'going';
  end if;
  insert into public.event_participants (event_id, user_id, status, queue_position)
  values (p_event, auth.uid(), 'waitlisted', nextval('public.event_waitlist_seq'))
  on conflict (event_id, user_id) do update
    set status = 'waitlisted', offered_at = null, offer_expires_at = null, reason = null,
        queue_position = case when event_participants.status = 'waitlisted' then event_participants.queue_position else excluded.queue_position end;
  return 'waitlisted';
end $$;
revoke all on function public.join_event(uuid) from public, anon, authenticated;
grant execute on function public.join_event(uuid) to authenticated;

create or replace function public.leave_event(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  p public.event_participants%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform 1 from public.events where id = p_event for update;
  if not found then return 'left'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    -- The delete trigger hands the seat on.
    delete from public.event_attendees where event_id = p_event and user_id = auth.uid();
    insert into public.event_participants (event_id, user_id, status) values (p_event, auth.uid(), 'left');
    return 'left';
  end if;
  select * into p from public.event_participants where event_id = p_event and user_id = auth.uid() for update;
  if found and p.status <> 'left' then
    update public.event_participants
       set status = 'left', queue_position = null, offered_at = null, offer_expires_at = null, reason = null
     where event_id = p_event and user_id = auth.uid();
    if p.status = 'offered' then perform findmaxxing_private.settle_offers(p_event, clock_timestamp()); end if;
  end if;
  return 'left';
end $$;
revoke all on function public.leave_event(uuid) from public, anon, authenticated;
grant execute on function public.leave_event(uuid) to authenticated;

-- interested <-> none. Never touches going, the waitlist or a seat.
create or replace function public.set_interest(p_event uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  p public.event_participants%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    return 'going';
  end if;
  select * into p from public.event_participants where event_id = p_event and user_id = auth.uid() for update;
  if coalesce(p_on, false) then
    if found and p.status in ('waitlisted', 'offered', 'interested') then return p.status; end if;
    if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then
      raise exception 'Event is not open for joining' using errcode = 'P0001';
    end if;
    insert into public.event_participants (event_id, user_id, status) values (p_event, auth.uid(), 'interested')
    on conflict (event_id, user_id) do update set status = 'interested', reason = null;
    return 'interested';
  end if;
  if found and p.status = 'interested' then
    delete from public.event_participants where event_id = p_event and user_id = auth.uid();
    return 'none';
  end if;
  return case when found then p.status else 'none' end;
end $$;
revoke all on function public.set_interest(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_interest(uuid, boolean) to authenticated;

-- Converts the seat the offer already holds. Expiry and acceptance are decided
-- under the same lock against the same clock, so exactly one of them happens.
-- An expired offer is not silently re-queued.
create or replace function public.accept_offer(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  p public.event_participants%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    return 'going';
  end if;
  select * into p from public.event_participants where event_id = p_event and user_id = auth.uid() for update;
  if found and p.status = 'declined' and p.reason = 'expired' then return 'offer_expired'; end if;
  if not found or p.status <> 'offered' then
    raise exception 'events:no_offer' using errcode = 'P0001';
  end if;
  if p.offer_expires_at <= clock_timestamp() then
    perform findmaxxing_private.settle_offers(p_event, clock_timestamp());
    return 'offer_expired';
  end if;
  if e.status <> 'published' then raise exception 'Event is not open for joining' using errcode = 'P0001'; end if;
  if coalesce(e.ends_at, e.starts_at) < now() then raise exception 'This event has already ended' using errcode = 'P0001'; end if;
  insert into public.event_attendees (event_id, user_id) values (p_event, auth.uid());
  return 'going';
end $$;
revoke all on function public.accept_offer(uuid) from public, anon, authenticated;
grant execute on function public.accept_offer(uuid) to authenticated;

create or replace function public.decline_offer(p_event uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  p public.event_participants%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  perform 1 from public.events where id = p_event for update;
  if not found then raise exception 'events:not_found' using errcode = 'P0002'; end if;
  select * into p from public.event_participants where event_id = p_event and user_id = auth.uid() for update;
  if not found or p.status <> 'offered' then
    return case when found then p.status else 'none' end;
  end if;
  update public.event_participants
     set status = 'declined', reason = 'declined', offered_at = null, offer_expires_at = null
   where event_id = p_event and user_id = auth.uid();
  perform findmaxxing_private.settle_offers(p_event, clock_timestamp());
  return 'declined';
end $$;
revoke all on function public.decline_offer(uuid) from public, anon, authenticated;
grant execute on function public.decline_offer(uuid) to authenticated;

-- A host takes someone off the going list, the waitlist or an offer.
-- A paid attendee is not removed here: that would keep their money (D-H is
-- about a buyer choosing to leave, not a host removing them).
create or replace function public.host_remove_participant(p_event uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
  p public.event_participants%rowtype;
begin
  perform findmaxxing_private.require_active_account();
  select * into e from public.events where id = p_event for update;
  if not found or not findmaxxing_private.can_host_event(p_event, auth.uid()) then
    raise exception 'events:not_found' using errcode = 'P0002';
  end if;
  if p_user is null or p_user = auth.uid() or p_user is not distinct from e.creator_id then
    raise exception 'events:cannot_remove_host' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = p_user) then
    if exists (select 1 from public.tickets t where t.event_id = p_event and t.user_id = p_user and t.status in ('paid', 'refund_pending')) then
      raise exception 'events:paid_attendee' using errcode = 'P0001';
    end if;
    delete from public.event_attendees where event_id = p_event and user_id = p_user;
    insert into public.event_participants (event_id, user_id, status, reason) values (p_event, p_user, 'left', 'removed');
    return 'removed';
  end if;
  select * into p from public.event_participants where event_id = p_event and user_id = p_user for update;
  if not found or p.status not in ('waitlisted', 'offered', 'interested') then return 'none'; end if;
  update public.event_participants
     set status = 'left', reason = 'removed', queue_position = null, offered_at = null, offer_expires_at = null
   where event_id = p_event and user_id = p_user;
  if p.status = 'offered' then perform findmaxxing_private.settle_offers(p_event, clock_timestamp()); end if;
  return 'removed';
end $$;
revoke all on function public.host_remove_participant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.host_remove_participant(uuid, uuid) to authenticated;

-- The sweep (service role: the 15-minute notifications cron). It only tidies
-- and passes seats on: an expired offer stopped holding at its expiry anyway.
-- Events are taken in id order so two runs cannot deadlock. p_now null = the
-- database clock.
create or replace function public.expire_offers(p_now timestamptz default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  r record;
  n integer := 0;
begin
  for r in
    select distinct p.event_id from public.event_participants p
    where p.status = 'offered' and p.offer_expires_at <= v_now order by p.event_id
  loop
    perform 1 from public.events where id = r.event_id for update;
    n := n + findmaxxing_private.settle_offers(r.event_id, v_now);
  end loop;
  return n;
end $$;
revoke all on function public.expire_offers(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_offers(timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- Readiness now knows about offers (through seats_taken) and the waitlist.
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
         e.decision_deadline, e.time_zone, e.venue_status, e.decision,
         (select count(*)::integer from public.event_participants p where p.event_id = e.id and p.status = 'waitlisted')
  from public.events e
  cross join lateral (select count(*)::integer as going from public.event_attendees a where a.event_id = e.id) g
  where e.id = any(p_events[1:200]) and public.can_view_event(e.id);
$$;

-- ----------------------------------------------------------------------------
-- Owner guard: capacity cannot go below going + live offers (extends 0012).
-- Now security definer so it can count offers whoever makes the change. The
-- UPDATE has already locked the event row when this runs, so the count is
-- serialized against every join.
-- ----------------------------------------------------------------------------
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_going integer;
  v_offers integer;
begin
  if current_setting('findmaxxing.moderation', true) = 'on' and public.is_moderator() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and old.creator_id is not null
     and not exists (select 1 from public.profiles where id = old.creator_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if old.status <> 'published' or coalesce(old.ends_at, old.starts_at) <= now() then
      raise exception 'Only future published events can be edited or cancelled' using errcode = 'P0001';
    end if;
    if new.status not in ('published', 'cancelled') then
      raise exception 'Invalid event status' using errcode = 'P0001';
    end if;
    if new.status = 'published' and coalesce(new.ends_at, new.starts_at) <= now() then
      raise exception 'Events must remain in the future when edited' using errcode = 'P0001';
    end if;
    if new.status = 'published' and new.capacity is not null then
      select count(*) into v_going from public.event_attendees where event_id = old.id;
      select count(*) into v_offers from public.event_participants
        where event_id = old.id and status = 'offered' and offer_expires_at > clock_timestamp();
      if new.capacity < v_going then
        raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
      end if;
      if new.capacity < v_going + v_offers then
        raise exception 'Capacity cannot be below the people going plus the offers being held' using errcode = 'P0001';
      end if;
    end if;
    if new.status = 'cancelled' and (
      new.title, new.description, new.place_id, new.location_name, new.address,
      new.lat, new.lng, new.starts_at, new.ends_at, new.creator_id,
      new.category_slug, new.capacity
    ) is distinct from (
      old.title, old.description, old.place_id, old.location_name, old.address,
      old.lat, old.lng, old.starts_at, old.ends_at, old.creator_id,
      old.category_slug, old.capacity
    ) then
      raise exception 'Cancelling an event cannot also change its details' using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.event_attendees
      where event_id = old.id and user_id is distinct from old.creator_id
    ) then
      raise exception 'Events with other attendees must be cancelled instead' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- ----------------------------------------------------------------------------
-- Paid flow: same rules as 0022, with the shared capacity definition, and the
-- price locked while anyone is waitlisted or holds an offer.
-- ----------------------------------------------------------------------------
create or replace function public.set_event_price(p_event uuid, p_cents integer)
returns void language plpgsql security definer set search_path = public as $$
declare
  e public.events%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or e.creator_id is distinct from auth.uid() then raise exception 'payments:not_found' using errcode = 'P0002'; end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then raise exception 'payments:event_closed' using errcode = 'P0001'; end if;
  if p_cents is not null and (p_cents < 100 or p_cents > 50000) then raise exception 'payments:bad_price' using errcode = 'P0001'; end if;
  if exists (select 1 from public.tickets t where t.event_id = p_event and t.status in ('pending', 'paid', 'refund_pending'))
     or exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id <> e.creator_id)
     or exists (select 1 from public.event_participants p where p.event_id = p_event and p.status in ('waitlisted', 'offered')) then
    raise exception 'payments:price_locked' using errcode = 'P0001';
  end if;
  if p_cents is not null and not exists (select 1 from public.host_accounts h where h.user_id = auth.uid() and h.charges_enabled) then
    raise exception 'payments:no_payout_account' using errcode = 'P0001';
  end if;
  perform set_config('findmaxxing.pricing', 'on', true);
  update public.events set price_cents = p_cents where id = p_event;
  perform set_config('findmaxxing.pricing', 'off', true);
end $$;

create or replace function public.reserve_ticket(p_event uuid)
returns table (ticket_id uuid, amount_cents integer, currency text, expires_at timestamptz, event_title text, host_account text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  e public.events%rowtype;
  t public.tickets%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then raise exception 'payments:not_found' using errcode = 'P0002'; end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then raise exception 'payments:event_closed' using errcode = 'P0001'; end if;
  if e.price_cents is null then raise exception 'payments:free_event' using errcode = 'P0001'; end if;
  if e.creator_id = auth.uid() or exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    raise exception 'payments:already_going' using errcode = 'P0001';
  end if;
  -- Holds that ran out stop holding.
  update public.tickets set status = 'expired' where event_id = p_event and status = 'pending' and tickets.expires_at <= now();
  select * into t from public.tickets where event_id = p_event and user_id = auth.uid() and status in ('pending', 'paid', 'refund_pending');
  if found then
    if t.status <> 'pending' then raise exception 'payments:already_going' using errcode = 'P0001'; end if;
  else
    if e.capacity is not null and findmaxxing_private.seats_taken(p_event) >= e.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
    perform public.check_rate_limit('tickets');
    insert into public.tickets (event_id, user_id, status, amount_cents, currency, expires_at)
    values (p_event, auth.uid(), 'pending', e.price_cents, e.currency, now() + interval '30 minutes')
    returning * into t;
  end if;
  return query select t.id, t.amount_cents, t.currency, t.expires_at, e.title,
    (select h.stripe_account_id from public.host_accounts h where h.user_id = e.creator_id and h.charges_enabled);
end $$;

-- ----------------------------------------------------------------------------
-- Creating an event: the creator's own attendance goes through join_event(),
-- because clients no longer insert into event_attendees (below).
-- ----------------------------------------------------------------------------
create or replace function public.create_event_with_details(
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

  perform public.join_event(created_id);

  return created_id;
end $$;

-- ----------------------------------------------------------------------------
-- Phase 2 (D-I, same release): clients cannot write event_attendees. Reads are
-- unchanged. A build that still inserts or deletes directly gets a permission
-- error; nothing can overbook or jump the queue around the functions above.
-- ----------------------------------------------------------------------------
drop policy "users join visible events" on public.event_attendees;
drop policy "users leave as self" on public.event_attendees;
revoke insert, update, delete, truncate on public.event_attendees from anon, authenticated;
