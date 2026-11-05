-- Roadmap 4.4: waitlist and offers (4.0 spec §6, §7, §11, §13, §14; batch 4.4).
--
-- event_attendees keeps meaning exactly "going" (D-B). Every other state lives in event_participants:
-- interested / waitlisted / offered (holds a seat until offer_expires_at) / declined / left.
-- seats_taken = going + live offers + live pending paid holds, compared against clock_timestamp(), so an
-- expired offer stops holding at offer_expires_at exactly, before any sweep runs.
--
-- Every seat-changing path takes `select ... from events where id = p_event for update` first: the same
-- lock the join trigger, reserve_ticket and set_event_price use, so old and new paths serialize per event.
--
-- Legacy writes (§13): phase 1 (new check_event_join that uses seats_taken and cannot jump the queue,
-- an after-delete trigger that passes freed seats on) and phase 2 (D-I, accepted: no native build has
-- shipped) in the same migration: authenticated users can no longer insert or delete event_attendees
-- directly, except a creator adding themselves to their own event (create_event_with_details runs as the
-- caller and inserts the creator's attendance). The only other writers are the definer RPCs below,
-- confirm_ticket and mark_ticket_refunded, plus cascades.
--
-- Paid events (§11, D-L): waitlists and offers apply only to free events. join_event on a priced event
-- raises payments:ticket_required; offer_next is a no-op on priced events; set_event_price refuses while
-- anyone is waitlisted or offered. reserve_ticket, confirm_ticket and mark_ticket_refunded are unchanged.

-- ---------------------------------------------------------------------------
-- Participants
-- ---------------------------------------------------------------------------
create sequence if not exists public.event_queue_seq;

create table if not exists public.event_participants (
  event_id          uuid not null references public.events (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  status            text not null check (status in ('interested', 'waitlisted', 'offered', 'declined', 'left')),
  -- FIFO across the whole app (a global sequence); kept while waitlisted or offered.
  queue_position    bigint,
  offered_at        timestamptz,
  offer_expires_at  timestamptz,
  reason            text check (reason is null or reason in ('declined', 'expired', 'removed', 'cancelled')),
  updated_at        timestamptz not null default now(),
  primary key (event_id, user_id),
  check (status not in ('waitlisted', 'offered') or queue_position is not null),
  check (status <> 'offered' or (offered_at is not null and offer_expires_at is not null))
);
create index if not exists event_participants_queue_idx on public.event_participants (event_id, status, queue_position);
create index if not exists event_participants_offers_idx on public.event_participants (offer_expires_at) where status = 'offered';
create index if not exists event_participants_user_idx on public.event_participants (user_id);

alter table public.event_participants enable row level security;
-- Each person sees their own row; the event's creator sees every row of their event (D-K: names to
-- hosts only). Everyone else sees counts through event_readiness(). No direct writes for API roles.
drop policy if exists "own or hosted participant rows" on public.event_participants;
create policy "own or hosted participant rows" on public.event_participants for select
  using (user_id = auth.uid() or exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()));
revoke insert, update, delete, truncate on public.event_participants from anon, authenticated;
revoke all on sequence public.event_queue_seq from anon, authenticated;

-- Invariant: a going row or a participant row for an event, never both.
create or replace function public.check_participant_not_going()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.event_attendees a where a.event_id = new.event_id and a.user_id = new.user_id) then
    raise exception 'Already going' using errcode = 'P0001';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists event_participants_not_going on public.event_participants;
create trigger event_participants_not_going before insert or update on public.event_participants
  for each row execute function public.check_participant_not_going();

-- ---------------------------------------------------------------------------
-- Seats (§6.2): one definition everywhere
-- ---------------------------------------------------------------------------
create or replace function public.event_seats_held(p_event uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select (select count(*) from public.event_participants p
           where p.event_id = p_event and p.status = 'offered' and p.offer_expires_at > clock_timestamp())::integer
       + (select count(*) from public.tickets t
           where t.event_id = p_event and t.status = 'pending' and t.expires_at > clock_timestamp())::integer
$$;
revoke all on function public.event_seats_held(uuid) from public, anon, authenticated;

create or replace function public.seats_taken(p_event uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select (select count(*) from public.event_attendees a where a.event_id = p_event)::integer + public.event_seats_held(p_event)
$$;
revoke all on function public.seats_taken(uuid) from public, anon, authenticated;

-- Readiness now reports the waitlist count (count only, never names).
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
    'waitlist', (select count(*)::integer from public.event_participants p where p.event_id = e.id and p.status = 'waitlisted')
  );
end $$;

-- Whether p_user could see the event (can_view_event answers for auth.uid()). Internal only.
create or replace function public.can_view_event_as(p_user uuid, p_event uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev text := current_setting('request.jwt.claim.sub', true);
  v_ok boolean;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  v_ok := public.can_view_event(p_event);
  perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
  return v_ok;
end $$;
revoke all on function public.can_view_event_as(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Offers (§6.3, D-D: 2 hours, capped to 30 minutes before the start; D-M: skip ineligible, keep place)
-- ---------------------------------------------------------------------------
create or replace function public.offer_next(p_event uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.events%rowtype;
  cand public.event_participants%rowtype;
  v_now timestamptz;
  v_n integer := 0;
  v_skip uuid[] := '{}';
begin
  select * into e from public.events where id = p_event for update;
  if not found or e.status <> 'published' or e.price_cents is not null then return 0; end if;
  loop
    v_now := clock_timestamp();
    exit when v_now >= e.starts_at - interval '30 minutes';
    -- No capacity (removed by the host): everyone still waiting is offered a seat.
    exit when e.capacity is not null and public.seats_taken(p_event) >= e.capacity;
    select * into cand from public.event_participants p
      where p.event_id = p_event and p.status = 'waitlisted' and not (p.user_id = any(v_skip))
      order by p.queue_position
      limit 1
      for update;
    exit when not found;
    -- Suspended, closing, or no longer able to see the event: skipped for now, place kept (D-M).
    if exists (select 1 from public.suspensions s where s.user_id = cand.user_id)
       or exists (select 1 from public.account_deletion_jobs j where j.user_id = cand.user_id)
       or not public.can_view_event_as(cand.user_id, p_event) then
      v_skip := v_skip || cand.user_id;
      continue;
    end if;
    update public.event_participants
      set status = 'offered', offered_at = v_now,
          offer_expires_at = least(v_now + interval '2 hours', e.starts_at - interval '30 minutes'), reason = null
      where event_id = p_event and user_id = cand.user_id;
    perform public.notify(cand.user_id, 'event_offer', null, 'event', p_event, e.title, null,
      'event_offer:' || p_event || ':' || (extract(epoch from v_now) * 1000)::bigint, 'A spot opened up for you');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.offer_next(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Phase 1: the join trigger enforces the same rules on every path (§13)
-- ---------------------------------------------------------------------------
create or replace function public.check_event_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  own public.event_participants%rowtype;
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
  select * into own from public.event_participants where event_id = new.event_id and user_id = new.user_id for update;
  -- A live offer already holds this person's seat: converting it never displaces anyone.
  if not (found and own.status = 'offered' and own.offer_expires_at > clock_timestamp()) and ev.capacity is not null then
    -- Open seats go to the queue first, so a direct insert can never jump it.
    perform public.offer_next(new.event_id);
    if public.seats_taken(new.event_id) >= ev.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
  end if;
  delete from public.event_participants where event_id = new.event_id and user_id = new.user_id;
  return new;
end $$;

-- A freed seat is passed on, whoever deleted the going row (leave, refund, removal, account deletion).
create or replace function public.attendee_left_offer_next()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Skipped while the event itself is being deleted (the row is gone) or is not published.
  if exists (select 1 from public.events e where e.id = old.event_id and e.status = 'published') then
    perform public.offer_next(old.event_id);
  end if;
  return old;
end $$;
drop trigger if exists event_attendees_offer_next on public.event_attendees;
create trigger event_attendees_offer_next after delete on public.event_attendees
  for each row execute function public.attendee_left_offer_next();

-- Capacity increases pass seats on; a cancellation (or any end of publication) ends every live offer.
create or replace function public.event_change_participants()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status <> 'published' and old.status = 'published' then
    update public.event_participants set status = 'declined', reason = 'cancelled'
      where event_id = new.id and status = 'offered';
  elsif new.status = 'published' and old.capacity is not null and (new.capacity is null or new.capacity > old.capacity) then
    perform public.offer_next(new.id);
  end if;
  return new;
end $$;
drop trigger if exists events_participants_change on public.events;
create trigger events_participants_change after update of status, capacity on public.events
  for each row when (old.status is distinct from new.status or old.capacity is distinct from new.capacity)
  execute function public.event_change_participants();

-- Capacity can't drop below going + live offers (extends 0012's guard; everything else unchanged).
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql as $$
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
    if new.status = 'published' and new.capacity is not null and
       new.capacity < (select count(*) from public.event_attendees where event_id = old.id) then
      raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
    end if;
    if new.status = 'published' and new.capacity is not null and new.capacity < (
         (select count(*) from public.event_attendees where event_id = old.id)
       + (select count(*) from public.event_participants p where p.event_id = old.id and p.status = 'offered' and p.offer_expires_at > clock_timestamp())) then
      raise exception 'Capacity cannot be below the people going plus open offers' using errcode = 'P0001';
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

-- The price locks while anyone is waitlisted or offered (extends payments:price_locked; else unchanged).
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
revoke all on function public.set_event_price(uuid, integer) from public, anon;
grant execute on function public.set_event_price(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic RPCs (§7)
-- ---------------------------------------------------------------------------
create or replace function public.require_active_caller()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if exists (select 1 from public.suspensions where user_id = auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.account_deletion_jobs where user_id = auth.uid()) then raise exception 'account_deletion_in_progress' using errcode = 'P0001'; end if;
  return auth.uid();
end $$;
revoke all on function public.require_active_caller() from public, anon, authenticated;

create or replace function public.join_event(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  own public.event_participants%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if e.status <> 'published' then raise exception 'Event is not open for joining' using errcode = 'P0001'; end if;
  if coalesce(e.ends_at, e.starts_at) < now() then raise exception 'This event has already ended' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = v_uid) then return 'going'; end if;
  if e.price_cents is not null and v_uid is distinct from e.creator_id then
    -- Paid events keep today's rule: a paid ticket admits (e.g. rejoining after leaving, D-H); no waitlist.
    if not exists (select 1 from public.tickets t where t.event_id = p_event and t.user_id = v_uid and t.status = 'paid') then
      raise exception 'payments:ticket_required' using errcode = 'P0001';
    end if;
    insert into public.event_attendees (event_id, user_id) values (p_event, v_uid);
    return 'going';
  end if;
  select * into own from public.event_participants where event_id = p_event and user_id = v_uid for update;
  if found and own.status = 'offered' and own.offer_expires_at > clock_timestamp() then
    insert into public.event_attendees (event_id, user_id) values (p_event, v_uid);
    return 'going';
  end if;
  if e.capacity is not null then perform public.offer_next(p_event); end if;
  if e.capacity is null or public.seats_taken(p_event) < e.capacity then
    insert into public.event_attendees (event_id, user_id) values (p_event, v_uid);
    return 'going';
  end if;
  if found and own.status = 'waitlisted' then return 'waitlisted'; end if;
  insert into public.event_participants (event_id, user_id, status, queue_position)
    values (p_event, v_uid, 'waitlisted', nextval('public.event_queue_seq'))
    on conflict (event_id, user_id) do update
      set status = 'waitlisted', queue_position = nextval('public.event_queue_seq'),
          offered_at = null, offer_expires_at = null, reason = null;
  return 'waitlisted';
end $$;

create or replace function public.leave_event(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  own public.event_participants%rowtype;
begin
  perform 1 from public.events where id = p_event for update;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = v_uid) then
    -- The after-delete trigger passes the seat on (offer_next).
    delete from public.event_attendees where event_id = p_event and user_id = v_uid;
    return 'left';
  end if;
  select * into own from public.event_participants where event_id = p_event and user_id = v_uid for update;
  if found and own.status in ('offered', 'waitlisted', 'interested') then
    update public.event_participants set status = 'left', offered_at = null, offer_expires_at = null, reason = null
      where event_id = p_event and user_id = v_uid;
    if own.status = 'offered' then perform public.offer_next(p_event); end if;
  end if;
  return 'left';
end $$;

create or replace function public.set_interest(p_event uuid, p_on boolean)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  own public.event_participants%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = v_uid) then return 'going'; end if;
  select * into own from public.event_participants where event_id = p_event and user_id = v_uid for update;
  if found and own.status in ('waitlisted', 'offered') then return own.status; end if;
  if p_on then
    if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then raise exception 'Event is not open' using errcode = 'P0001'; end if;
    insert into public.event_participants (event_id, user_id, status) values (p_event, v_uid, 'interested')
      on conflict (event_id, user_id) do update set status = 'interested', queue_position = null, offered_at = null, offer_expires_at = null, reason = null;
    return 'interested';
  end if;
  delete from public.event_participants where event_id = p_event and user_id = v_uid and status = 'interested';
  return 'none';
end $$;

create or replace function public.accept_offer(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  own public.event_participants%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found then raise exception 'Event not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = v_uid) then return 'going'; end if;
  select * into own from public.event_participants where event_id = p_event and user_id = v_uid for update;
  if found and own.status = 'offered' and own.offer_expires_at > clock_timestamp()
     and e.status = 'published' and coalesce(e.ends_at, e.starts_at) >= now() then
    insert into public.event_attendees (event_id, user_id) values (p_event, v_uid);
    return 'going';
  end if;
  -- Past its expiry (or the event closed): the person stays off the list; no silent re-queue.
  if found and own.status = 'offered' then
    update public.event_participants set status = 'declined', reason = 'expired', offered_at = own.offered_at
      where event_id = p_event and user_id = v_uid;
    perform public.notify(v_uid, 'event_offer_expired', null, 'event', p_event, e.title, null,
      'event_offer_expired:' || p_event || ':' || (extract(epoch from own.offered_at) * 1000)::bigint, 'Your spot offer ran out');
    perform public.offer_next(p_event);
  end if;
  return 'offer_expired';
end $$;

create or replace function public.decline_offer(p_event uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  own public.event_participants%rowtype;
begin
  perform 1 from public.events where id = p_event for update;
  select * into own from public.event_participants where event_id = p_event and user_id = v_uid for update;
  if not found or own.status <> 'offered' then return coalesce(own.status, 'none'); end if;
  update public.event_participants set status = 'declined', reason = 'declined' where event_id = p_event and user_id = v_uid;
  perform public.offer_next(p_event);
  return 'declined';
end $$;

-- Service (the 15-minute notifications cron): offers past expiry are declined (reason expired), the
-- person is told once, and the seat is offered to the next person.
create or replace function public.expire_offers(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event uuid;
  e public.events%rowtype;
  p public.event_participants%rowtype;
  v_n integer := 0;
begin
  for v_event in select distinct event_id from public.event_participants where status = 'offered' and offer_expires_at <= p_now loop
    select * into e from public.events where id = v_event for update;
    for p in select * from public.event_participants
             where event_id = v_event and status = 'offered' and offer_expires_at <= p_now for update loop
      update public.event_participants set status = 'declined', reason = 'expired' where event_id = v_event and user_id = p.user_id;
      perform public.notify(p.user_id, 'event_offer_expired', null, 'event', v_event, e.title, null,
        'event_offer_expired:' || v_event || ':' || (extract(epoch from p.offered_at) * 1000)::bigint, 'Your spot offer ran out');
      v_n := v_n + 1;
    end loop;
    perform public.offer_next(v_event);
  end loop;
  return v_n;
end $$;

create or replace function public.host_remove_participant(p_event uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  e public.events%rowtype;
  own public.event_participants%rowtype;
begin
  select * into e from public.events where id = p_event for update;
  if not found or e.creator_id is distinct from v_uid then raise exception 'You do not host this event' using errcode = '42501'; end if;
  if p_user = e.creator_id then raise exception 'The host cannot remove themselves' using errcode = 'P0001'; end if;
  if exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = p_user) then
    delete from public.event_attendees where event_id = p_event and user_id = p_user;
    return 'removed';
  end if;
  select * into own from public.event_participants where event_id = p_event and user_id = p_user for update;
  if found and own.status in ('waitlisted', 'offered') then
    update public.event_participants set status = 'left', reason = 'removed', offered_at = null, offer_expires_at = null
      where event_id = p_event and user_id = p_user;
    if own.status = 'offered' then perform public.offer_next(p_event); end if;
    return 'removed';
  end if;
  return 'none';
end $$;

revoke all on function public.join_event(uuid) from public, anon;
revoke all on function public.leave_event(uuid) from public, anon;
revoke all on function public.set_interest(uuid, boolean) from public, anon;
revoke all on function public.accept_offer(uuid) from public, anon;
revoke all on function public.decline_offer(uuid) from public, anon;
revoke all on function public.host_remove_participant(uuid, uuid) from public, anon;
grant execute on function public.join_event(uuid) to authenticated;
grant execute on function public.leave_event(uuid) to authenticated;
grant execute on function public.set_interest(uuid, boolean) to authenticated;
grant execute on function public.accept_offer(uuid) to authenticated;
grant execute on function public.decline_offer(uuid) to authenticated;
grant execute on function public.host_remove_participant(uuid, uuid) to authenticated;
revoke all on function public.expire_offers(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_offers(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Offer notifications (§9 rows "Offer made" / "Offer expired"; 4.6 adds the rest). Dedupe keys are
-- event_offer[_expired]:<event>:<offered_at ms>: unique per person already, and the spec's extra user id
-- would overflow the 100-character dedupe_key limit.
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
  'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired'));

create or replace function public.check_notification_settings()
returns trigger language plpgsql set search_path = public as $$
declare
  known text[] := array['new_follower', 'event_joined', 'event_tomorrow', 'event_soon', 'event_changed', 'event_cancelled',
                        'new_message', 'place_saved', 'place_rated', 'report_resolved', 'content_moderated', 'trip_plan_ready',
                        'event_offer', 'event_offer_expired'];
begin
  perform now() at time zone new.time_zone;
  if not (new.muted_types <@ known and new.push_types <@ known) then
    raise exception 'notifications:bad_type' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- Offers are time-critical: pushed by default, like cancellations.
alter table public.notification_settings alter column push_types set default array['new_follower', 'event_joined', 'event_tomorrow',
  'event_soon', 'event_changed', 'event_cancelled', 'new_message', 'report_resolved', 'content_moderated', 'trip_plan_ready',
  'event_offer', 'event_offer_expired'];
update public.notification_settings
  set push_types = push_types || array['event_offer', 'event_offer_expired']
  where 'event_cancelled' = any(push_types) and not ('event_offer' = any(push_types));

-- ---------------------------------------------------------------------------
-- Phase 2 (D-I): no direct join/leave for API users
-- ---------------------------------------------------------------------------
drop policy if exists "users join visible events" on public.event_attendees;
drop policy if exists "users join as self" on public.event_attendees;
drop policy if exists "users leave as self" on public.event_attendees;
-- create_event_with_details runs as the caller and adds the creator's own attendance.
drop policy if exists "creators attend their own events" on public.event_attendees;
create policy "creators attend their own events" on public.event_attendees for insert
  with check (user_id = auth.uid() and exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()));
