-- ============================================================================
-- Roadmap 4.5a, first slice (4.0 Amendment A1 revision 3: A1.2, A1.9): event
-- admission. Functions and one trigger only. No table, column, grant or policy
-- changes; 0052 stays reserved for the deferred waitlist work.
--
--   * One capacity rule on every way in. Seats taken = people going + live paid
--     holds. A hold is live strictly before its expires_at.
--   * check_event_join(): every event_attendees insert meets that rule. A paid
--     ticket lets its holder TRY to come in; it does not hold a seat. The host
--     still needs no ticket, and capacity applies to the host as before.
--   * confirm_ticket(): locks in one order (the buyer's account, the event, the
--     ticket), re-reads the ticket, and decides on one clock read taken after
--     the locks. Same four results and the same refund-pending contract.
--   * reserve_ticket(): the caller's account lock first; the same clock for the
--     sweep, the count and the new hold's expiry.
--   * A host cannot lower capacity below seats taken, so a live hold is not
--     stranded. guard_owner_event_change() is security invoker and the seat
--     count is private on purpose, so the floor is its own definer trigger.
--
-- Lock order everywhere: account_close:<user> advisory lock, then the event
-- row, then ticket rows, then attendee rows.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Seats taken at a moment. Callers pass the clock they read after taking the
-- event lock, so one decision uses one time.
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.seats_taken_at(p_event uuid, p_at timestamptz)
returns integer language sql volatile security definer set search_path = public as $$
  select ((select count(*) from public.event_attendees a where a.event_id = p_event)
        + (select count(*) from public.tickets t where t.event_id = p_event and t.status = 'pending' and t.expires_at > p_at))::integer;
$$;
revoke all on function findmaxxing_private.seats_taken_at(uuid, timestamptz) from public, anon, authenticated, service_role;

-- The read-model entry point from 0051 (events_readiness), now the same definition at "now".
create or replace function findmaxxing_private.seats_taken(p_event uuid)
returns integer language sql volatile security definer set search_path = public as $$
  select findmaxxing_private.seats_taken_at(p_event, clock_timestamp());
$$;
revoke all on function findmaxxing_private.seats_taken(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Every attendee insert: the legacy direct write from web and native, the host
-- at creation, and the service insert that fulfils a ticket.
-- Same rules, order and messages as 0022; only the count changed.
-- ----------------------------------------------------------------------------
create or replace function public.check_event_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  v_at timestamptz;
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
  if ev.capacity is not null then
    -- Read after the event lock. A paid ticket is not an exemption: its holder may have left and
    -- the seat gone to someone else, or to someone who is paying for it right now.
    v_at := clock_timestamp();
    if findmaxxing_private.seats_taken_at(ev.id, v_at) >= ev.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Holds a spot for 30 minutes. Same checks, messages and result as 0022.
-- ----------------------------------------------------------------------------
create or replace function public.reserve_ticket(p_event uuid)
returns table (ticket_id uuid, amount_cents integer, currency text, expires_at timestamptz, event_title text, host_account text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  e public.events%rowtype;
  t public.tickets%rowtype;
  v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- The caller's account lock, before any event or ticket row. The tickets trigger
  -- (block_suspended_writes) takes this same lock, and account closure holds it while it expires
  -- this person's pending tickets, so taking it later would be the reverse order.
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  select * into e from public.events where id = p_event for update;
  if not found or not public.can_view_event(p_event) then raise exception 'payments:not_found' using errcode = 'P0002'; end if;
  if e.status <> 'published' or coalesce(e.ends_at, e.starts_at) < now() then raise exception 'payments:event_closed' using errcode = 'P0001'; end if;
  if e.price_cents is null then raise exception 'payments:free_event' using errcode = 'P0001'; end if;
  if e.creator_id = auth.uid() or exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id = auth.uid()) then
    raise exception 'payments:already_going' using errcode = 'P0001';
  end if;
  -- One clock for this decision, read after the event lock: the sweep, the count and the new
  -- hold's expiry all use it. now() is the transaction's start and may be long before the lock.
  v_at := clock_timestamp();
  -- Holds that ran out stop holding.
  update public.tickets set status = 'expired' where event_id = p_event and status = 'pending' and tickets.expires_at <= v_at;
  select * into t from public.tickets where event_id = p_event and user_id = auth.uid() and status in ('pending', 'paid', 'refund_pending');
  if found then
    if t.status <> 'pending' then raise exception 'payments:already_going' using errcode = 'P0001'; end if;
  else
    if e.capacity is not null and findmaxxing_private.seats_taken_at(p_event, v_at) >= e.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
    perform public.check_rate_limit('tickets');
    insert into public.tickets (event_id, user_id, status, amount_cents, currency, expires_at)
    values (p_event, auth.uid(), 'pending', e.price_cents, e.currency, v_at + interval '30 minutes')
    returning * into t;
  end if;
  return query select t.id, t.amount_cents, t.currency, t.expires_at, e.title,
    (select h.stripe_account_id from public.host_accounts h where h.user_id = e.creator_id and h.charges_enabled);
end $$;
revoke all on function public.reserve_ticket(uuid) from public, anon;
grant execute on function public.reserve_ticket(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- checkout.session.completed. Idempotent: a redelivery changes nothing.
-- Results as before: unknown, duplicate, refund, confirmed.
-- ----------------------------------------------------------------------------
create or replace function public.confirm_ticket(p_session text, p_payment_intent text, p_amount integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  seen public.tickets%rowtype;   -- a first look, without a lock, only to learn which rows to lock
  t public.tickets%rowtype;      -- the ticket as it is once locked; every decision uses this
  v_event boolean := false;
  v_at timestamptz;
begin
  select * into seen from public.tickets where checkout_session_id = p_session;
  if not found then return 'unknown'; end if;
  -- 1. The buyer's account. The attendee insert below reaches block_suspended_writes(), which
  --    takes this lock for the row's user even for a service caller; account closure takes it
  --    first and then expires the buyer's pending tickets.
  if seen.user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || seen.user_id::text, 0));
  end if;
  -- 2. The event.
  if seen.event_id is not null then
    perform 1 from public.events where id = seen.event_id for update;
    v_event := found;
  end if;
  -- 3. The ticket, read again now that it cannot change.
  select * into t from public.tickets where id = seen.id for update;
  if not found or t.checkout_session_id is distinct from p_session then return 'unknown'; end if;
  -- A reference may have become null since the first look (the event was deleted, the buyer
  -- anonymized): that is handled as a refund below. It can never legitimately point somewhere
  -- else; if it does, the locks above are for the wrong rows, so stop and let the caller retry.
  if (t.user_id is not null and t.user_id is distinct from seen.user_id)
     or (t.event_id is not null and t.event_id is distinct from seen.event_id) then
    raise exception 'payments:ticket_changed' using errcode = '40001';
  end if;
  -- One clock, read after all three locks.
  v_at := clock_timestamp();
  if t.status not in ('pending', 'expired') then return 'duplicate'; end if;
  if t.status = 'expired' or t.expires_at <= v_at or p_amount is distinct from t.amount_cents
     or t.event_id is null or not v_event or t.user_id is null then
    update public.tickets set status = 'refund_pending', payment_intent_id = p_payment_intent where id = t.id;
    return 'refund';
  end if;
  begin
    -- Paid first: this hold stops being a live hold, so the capacity check in check_event_join()
    -- counts the other people going and the other live holds, not this buyer twice.
    update public.tickets set status = 'paid', payment_intent_id = p_payment_intent, paid_at = v_at where id = t.id;
    insert into public.event_attendees (event_id, user_id) values (t.event_id, t.user_id) on conflict do nothing;
    return 'confirmed';
  exception when others then
    -- A lock or concurrency failure is not a verdict about this payment: let it out so the webhook
    -- is retried. Anything else (the event closed, it is full, the buyer's account is closing)
    -- means the payment cannot become a seat, and it is refunded.
    if sqlstate in ('40P01', '40001', '55P03', '57014') then raise; end if;
    update public.tickets set status = 'refund_pending', payment_intent_id = p_payment_intent where id = t.id;
    return 'refund';
  end;
end $$;
revoke all on function public.confirm_ticket(text, text, integer) from public, anon, authenticated;
grant execute on function public.confirm_ticket(text, text, integer) to service_role;

-- ----------------------------------------------------------------------------
-- The owner guard, exactly as in 0012 except that its attendee-count floor is
-- gone (the floor below replaces it).
-- ----------------------------------------------------------------------------
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
    -- The capacity floor moved to findmaxxing_private.guard_event_capacity_floor() (0053), which also
    -- counts live paid holds. One floor, in one place.
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
-- Capacity cannot be lowered below seats taken. Runs under the row lock the
-- UPDATE already holds, so it is serialized with joins, reservations and
-- confirmations. Raising capacity, or leaving it alone, is never refused: an
-- event that is already over its limit (a hold stranded before this migration)
-- can still be edited, and settles as its holds are paid or run out.
-- The message is the one clients already map.
-- ----------------------------------------------------------------------------
create or replace function findmaxxing_private.guard_event_capacity_floor()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz;
begin
  if new.status <> 'published' or new.capacity is null then return new; end if;
  if old.capacity is not null and new.capacity >= old.capacity then return new; end if;
  v_at := clock_timestamp();
  if new.capacity < findmaxxing_private.seats_taken_at(old.id, v_at) then
    raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function findmaxxing_private.guard_event_capacity_floor() from public, anon, authenticated, service_role;

-- Named to fire straight after guard_owner_event_change (triggers fire in name order), so "you do
-- not own this event" is still the first answer to someone who does not.
drop trigger if exists guard_owner_event_change_capacity_floor on public.events;
create trigger guard_owner_event_change_capacity_floor
  before update on public.events
  for each row execute function findmaxxing_private.guard_event_capacity_floor();

-- The direct join relies on its account lock being taken before the event lock: on an
-- event_attendees insert, "…_block_suspended" (the account lock) must fire before "…_check_join"
-- (the event lock). Triggers fire in name order; fail the migration if that ever stops being true.
do $$
declare names text[];
begin
  select array_agg(t.tgname::text order by t.tgname) into names from pg_trigger t
   where t.tgrelid = 'public.event_attendees'::regclass and not t.tgisinternal
     and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4   -- before, insert
     and t.tgname in ('event_attendees_block_suspended', 'event_attendees_check_join');
  if names is distinct from array['event_attendees_block_suspended', 'event_attendees_check_join'] then
    raise exception 'event_attendees insert triggers are missing or out of order: %', names;
  end if;
end $$;
