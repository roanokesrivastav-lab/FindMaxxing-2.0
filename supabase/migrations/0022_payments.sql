-- ============================================================================
-- FindMaxxing — payments: paid event tickets and the Plus subscription.
--
-- What is paid (pending owner confirmation, see README):
--   * Tickets: a host with a Stripe payout account (Connect Express) can put a
--     price on an event. Buying holds a spot for 30 minutes while Stripe
--     Checkout runs; the webhook turns the hold into a ticket and a place on
--     the attendee list. Cancelling the event refunds every ticket.
--   * Plus: convenience only. More lists, more AI trip plans a day, a
--     supporter badge, and no ads. Never visibility, ranking or reach.
--
-- Money records are owner-only. Clients never write tickets, entitlements or
-- payout accounts: Stripe webhooks and the cron do, with the service role.
-- Capacity stays right under concurrency: holds and confirmations take the
-- event row lock that check_event_join() takes (0001_init.sql), and pending
-- holds count against capacity.
-- ============================================================================

alter table public.events add column price_cents integer check (price_cents is null or price_cents between 100 and 50000);
alter table public.events add column currency text not null default 'usd' check (currency = 'usd');

alter table public.profiles add column supporter boolean not null default false;

create table public.host_accounts (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id  text not null unique,
  charges_enabled    boolean not null default false,
  updated_at         timestamptz not null default now()
);

create table public.tickets (
  id                   uuid primary key default gen_random_uuid(),
  -- Money records outlive the event and the buyer's account (anonymized).
  event_id             uuid references public.events (id) on delete set null,
  user_id              uuid references public.profiles (id) on delete set null,
  status               text not null check (status in ('pending', 'paid', 'expired', 'refund_pending', 'refunded')),
  amount_cents         integer not null check (amount_cents > 0),
  currency             text not null default 'usd',
  checkout_session_id  text unique,
  payment_intent_id    text unique,
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now(),
  paid_at              timestamptz,
  refunded_at          timestamptz
);
-- One live ticket per person per event.
create unique index tickets_one_live_idx on public.tickets (event_id, user_id) where status in ('pending', 'paid', 'refund_pending');
create index tickets_event_idx on public.tickets (event_id, status);

create table public.stripe_customers (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  customer_id  text not null unique
);

create table public.entitlements (
  user_id                 uuid primary key references public.profiles (id) on delete cascade,
  plan                    text not null default 'plus' check (plan = 'plus'),
  status                  text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused')),
  current_period_end      timestamptz,
  stripe_subscription_id  text unique,
  updated_at              timestamptz not null default now()
);

-- Every webhook delivery we processed, so a redelivery is a no-op. No payloads kept.
create table public.stripe_events (
  id           text primary key,
  type         text not null,
  object_id    text,
  received_at  timestamptz not null default now()
);

alter table public.host_accounts enable row level security;
alter table public.tickets enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.entitlements enable row level security;
alter table public.stripe_events enable row level security;

create policy "hosts read their payout account" on public.host_accounts for select using (user_id = auth.uid());
create policy "buyers read their tickets" on public.tickets for select using (user_id = auth.uid());
create policy "users read their customer" on public.stripe_customers for select using (user_id = auth.uid());
create policy "users read their plan" on public.entitlements for select using (user_id = auth.uid());
revoke insert, update, delete on public.host_accounts, public.tickets, public.stripe_customers, public.entitlements from anon, authenticated;
revoke all on public.stripe_events from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Plus
-- ----------------------------------------------------------------------------
create or replace function public.is_plus(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user and e.status in ('active', 'trialing', 'past_due')
      and (e.current_period_end is null or e.current_period_end > now()));
$$;
revoke all on function public.is_plus(uuid) from public, anon;
grant execute on function public.is_plus(uuid) to authenticated;

-- The badge follows the plan. Nobody sets it on their own profile.
create or replace function public.sync_supporter()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set supporter = public.is_plus(coalesce(new.user_id, old.user_id)) where id = coalesce(new.user_id, old.user_id);
  return coalesce(new, old);
end $$;
create trigger entitlements_sync_supporter after insert or update or delete on public.entitlements
  for each row execute function public.sync_supporter();

create or replace function public.guard_supporter()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and (tg_op = 'INSERT' and new.supporter or tg_op = 'UPDATE' and new.supporter is distinct from old.supporter) then
    raise exception 'payments:supporter_is_earned' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard_supporter before insert or update on public.profiles
  for each row execute function public.guard_supporter();

-- Perk: lists beyond the 100 cap (1,000 as a sanity bound).
create or replace function public.check_saved_list_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  existing int;
  cap int := case when public.is_plus(new.owner_id) then 1000 else 100 end;
begin
  perform pg_advisory_xact_lock(hashtextextended('saved_lists:' || new.owner_id::text, 0));
  select count(*) into existing from public.saved_lists where owner_id = new.owner_id;
  if existing >= cap then
    raise exception 'You can have at most % lists', cap using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Perk: 30 AI trip plans a day instead of 10.
insert into public.rate_limit_rules (action, max_count, window_seconds, label) values
  ('trip_plans_plus', 30, 86400, 'trip plans'),
  ('tickets', 20, 3600, 'ticket checkouts');

create or replace function public.consume_trip_plan()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.check_rate_limit(case when public.is_plus(auth.uid()) then 'trip_plans_plus' else 'trip_plans' end);
end $$;
revoke all on function public.consume_trip_plan() from public, anon;
grant execute on function public.consume_trip_plan() to authenticated;

-- ----------------------------------------------------------------------------
-- Tickets
-- ----------------------------------------------------------------------------
-- The price changes only here: owners, future published events, nobody but the
-- host going and no tickets yet, and (for a price) a payout account that can
-- take charges.
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
     or exists (select 1 from public.event_attendees a where a.event_id = p_event and a.user_id <> e.creator_id) then
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

create or replace function public.guard_event_price()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.price_cents is not null and auth.uid() is not null then
    raise exception 'payments:price_via_function' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.price_cents is distinct from old.price_cents
     and coalesce(current_setting('findmaxxing.pricing', true), 'off') <> 'on' and auth.uid() is not null then
    raise exception 'payments:price_via_function' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger events_guard_price before insert or update on public.events for each row execute function public.guard_event_price();

-- A paid event is joined by buying a ticket; the host goes free.
create or replace function public.check_event_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  current_count int;
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
    select count(*) into current_count from public.event_attendees where event_id = new.event_id;
    if current_count >= ev.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- Holds a spot for 30 minutes (Stripe Checkout's shortest expiry). Pending
-- holds count against capacity, so two buyers can't both get the last spot.
create or replace function public.reserve_ticket(p_event uuid)
returns table (ticket_id uuid, amount_cents integer, currency text, expires_at timestamptz, event_title text, host_account text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  e public.events%rowtype;
  t public.tickets%rowtype;
  taken int;
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
    if e.capacity is not null then
      select (select count(*) from public.event_attendees a where a.event_id = p_event)
           + (select count(*) from public.tickets x where x.event_id = p_event and x.status = 'pending') into taken;
      if taken >= e.capacity then raise exception 'This event is full' using errcode = 'P0001'; end if;
    end if;
    perform public.check_rate_limit('tickets');
    insert into public.tickets (event_id, user_id, status, amount_cents, currency, expires_at)
    values (p_event, auth.uid(), 'pending', e.price_cents, e.currency, now() + interval '30 minutes')
    returning * into t;
  end if;
  return query select t.id, t.amount_cents, t.currency, t.expires_at, e.title,
    (select h.stripe_account_id from public.host_accounts h where h.user_id = e.creator_id and h.charges_enabled);
end $$;
revoke all on function public.reserve_ticket(uuid) from public, anon;
grant execute on function public.reserve_ticket(uuid) to authenticated;

-- The host's view of sales on their own event. Nobody else's purchases.
create or replace function public.event_ticket_summary(p_event uuid)
returns table (paid integer, pending integer, refunded integer, revenue_cents integer)
language sql stable security definer set search_path = public as $$
  select count(*) filter (where t.status = 'paid')::integer,
         count(*) filter (where t.status = 'pending' and t.expires_at > now())::integer,
         count(*) filter (where t.status in ('refund_pending', 'refunded'))::integer,
         coalesce(sum(t.amount_cents) filter (where t.status = 'paid'), 0)::integer
  from public.tickets t join public.events e on e.id = t.event_id
  where t.event_id = p_event and e.creator_id = auth.uid();
$$;
revoke all on function public.event_ticket_summary(uuid) from public, anon;
grant execute on function public.event_ticket_summary(uuid) to authenticated;

-- Cancelling an event: holds end, and paid tickets are queued for refund.
create or replace function public.refund_on_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('cancelled', 'removed') and old.status = 'published' then
    update public.tickets set status = 'expired' where event_id = new.id and status = 'pending';
    update public.tickets set status = 'refund_pending' where event_id = new.id and status = 'paid';
  end if;
  return new;
end $$;
create trigger events_refund_on_cancel after update of status on public.events for each row execute function public.refund_on_cancel();

-- ----------------------------------------------------------------------------
-- Service role only: Stripe webhooks, checkout, the cron
-- ----------------------------------------------------------------------------
-- The latest checkout for a hold. A payment through an older one confirms
-- nothing ('unknown') and the webhook refunds it.
create or replace function public.attach_checkout_session(p_ticket uuid, p_session text)
returns void language sql security definer set search_path = public as $$
  update public.tickets set checkout_session_id = p_session where id = p_ticket and status = 'pending';
$$;

-- checkout.session.completed. Idempotent: a redelivery changes nothing. If
-- the hold had lapsed and the event filled up, or it closed, the payment is
-- queued for refund instead.
create or replace function public.confirm_ticket(p_session text, p_payment_intent text, p_amount integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  t public.tickets%rowtype;
begin
  select * into t from public.tickets where checkout_session_id = p_session for update;
  if not found then return 'unknown'; end if;
  if t.status <> 'pending' and t.status <> 'expired' then return 'duplicate'; end if;
  if p_amount is distinct from t.amount_cents then
    update public.tickets set status = 'refund_pending', payment_intent_id = p_payment_intent where id = t.id;
    return 'refund';
  end if;
  begin
    -- Paid first: check_event_join() lets a paid ticket holder in.
    update public.tickets set status = 'paid', payment_intent_id = p_payment_intent, paid_at = now() where id = t.id;
    insert into public.event_attendees (event_id, user_id) values (t.event_id, t.user_id) on conflict do nothing;
    return 'confirmed';
  exception when others then
    update public.tickets set status = 'refund_pending', payment_intent_id = p_payment_intent where id = t.id;
    return 'refund';
  end;
end $$;

create or replace function public.expire_checkout(p_session text)
returns void language sql security definer set search_path = public as $$
  update public.tickets set status = 'expired' where checkout_session_id = p_session and status = 'pending';
$$;

create or replace function public.tickets_to_refund()
returns table (ticket_id uuid, payment_intent_id text)
language sql stable security definer set search_path = public as $$
  select id, payment_intent_id from public.tickets where status = 'refund_pending' and payment_intent_id is not null order by created_at, id;
$$;

-- charge.refunded: the ticket is refunded and the place is given up.
create or replace function public.mark_ticket_refunded(p_payment_intent text)
returns void language plpgsql security definer set search_path = public as $$
declare
  t public.tickets%rowtype;
begin
  update public.tickets set status = 'refunded', refunded_at = coalesce(refunded_at, now())
  where payment_intent_id = p_payment_intent and status in ('paid', 'refund_pending') returning * into t;
  if found then delete from public.event_attendees where event_id = t.event_id and user_id = t.user_id; end if;
end $$;

create or replace function public.set_entitlement(p_user uuid, p_status text, p_period_end timestamptz, p_subscription text)
returns void language sql security definer set search_path = public as $$
  insert into public.entitlements (user_id, status, current_period_end, stripe_subscription_id, updated_at)
  values (p_user, p_status, p_period_end, p_subscription, now())
  on conflict (user_id) do update set status = excluded.status, current_period_end = excluded.current_period_end,
    stripe_subscription_id = excluded.stripe_subscription_id, updated_at = now();
$$;

create or replace function public.link_stripe_customer(p_user uuid, p_customer text)
returns void language sql security definer set search_path = public as $$
  insert into public.stripe_customers (user_id, customer_id) values (p_user, p_customer)
  on conflict (user_id) do update set customer_id = excluded.customer_id;
$$;

create or replace function public.set_host_account(p_user uuid, p_account text, p_charges_enabled boolean)
returns void language sql security definer set search_path = public as $$
  insert into public.host_accounts (user_id, stripe_account_id, charges_enabled, updated_at) values (p_user, p_account, p_charges_enabled, now())
  on conflict (user_id) do update set stripe_account_id = excluded.stripe_account_id, charges_enabled = excluded.charges_enabled, updated_at = now();
$$;

-- True the first time an event id is seen.
create or replace function public.record_stripe_event(p_id text, p_type text, p_object text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.stripe_events (id, type, object_id) values (p_id, p_type, p_object);
  return true;
exception when unique_violation then
  return false;
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'attach_checkout_session(uuid, text)', 'confirm_ticket(text, text, integer)', 'expire_checkout(text)', 'tickets_to_refund()',
    'mark_ticket_refunded(text)', 'set_entitlement(uuid, text, timestamptz, text)', 'link_stripe_customer(uuid, text)',
    'set_host_account(uuid, text, boolean)', 'record_stripe_event(text, text, text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Writes on money tables are refused for suspended accounts too (they have no client writes anyway).
create trigger tickets_block_suspended before insert or update or delete on public.tickets for each row execute function public.block_suspended_writes();
