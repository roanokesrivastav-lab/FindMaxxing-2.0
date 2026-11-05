-- Existing ledger rows represent completed deliveries; do not re-run them.
alter table public.stripe_events
  add column processing_state text not null default 'complete' check (processing_state in ('pending', 'processing', 'complete')),
  add column lease_token uuid,
  add column processing_scope text,
  add column outcome text;
create table public.stripe_processing_locks (
  scope text primary key,
  lease_token uuid not null,
  leased_until timestamptz not null
);
alter table public.stripe_processing_locks enable row level security;
revoke all on public.stripe_processing_locks from public, anon, authenticated;
grant select, insert, update, delete on public.stripe_processing_locks to service_role;

-- Acquire BEFORE Stripe reads; events for different subscriptions belonging to
-- one user share a lease. Busy deliveries must return a retryable HTTP failure.
create or replace function public.claim_stripe_event(p_id text, p_type text, p_object text, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.stripe_events%rowtype; key text; token uuid := gen_random_uuid();
begin
  insert into public.stripe_events(id,type,object_id,processing_state) values (p_id,p_type,p_object,'pending') on conflict (id) do nothing;
  select * into e from public.stripe_events where id=p_id for update;
  if e.processing_state='complete' then return jsonb_build_object('state','complete','outcome',coalesce(e.outcome,'processed')); end if;
  key := case when p_user is null then 'event:' || p_id else 'user:' || p_user::text end;
  insert into public.stripe_processing_locks(scope,lease_token,leased_until) values (key,token,now()+interval '5 minutes')
    on conflict (scope) do update set lease_token=excluded.lease_token,leased_until=excluded.leased_until
    where stripe_processing_locks.leased_until<=now();
  if not found then return jsonb_build_object('state','busy'); end if;
  update public.stripe_events set processing_state='processing',lease_token=token,processing_scope=key where id=p_id;
  return jsonb_build_object('state','claimed','token',token);
end $$;

-- Plan update + completion commit together. A crashed/stale worker cannot
-- overwrite a newer remote snapshot, and closing accounts stay fenced.
create or replace function public.finish_stripe_event(p_id text, p_token uuid, p_outcome text, p_plan jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare e public.stripe_events%rowtype;
begin
  select * into e from public.stripe_events where id=p_id for update;
  if not found or e.processing_state<>'processing' or e.lease_token is distinct from p_token then
    raise exception 'Stripe event lease lost' using errcode='P0001';
  end if;
  perform 1 from public.stripe_processing_locks where scope=e.processing_scope and lease_token=p_token and leased_until>now() for update;
  if not found then raise exception 'Stripe event lease lost' using errcode='P0001'; end if;
  if p_plan is not null then
    if e.processing_scope is distinct from 'user:' || (p_plan->>'userId') then raise exception 'Stripe plan scope mismatch' using errcode='P0001'; end if;
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || (p_plan->>'userId'),0));
    if p_plan->>'customerId' is not null then
      if exists (select 1 from public.stripe_customers where user_id=(p_plan->>'userId')::uuid and customer_id<>p_plan->>'customerId') then
        raise exception 'Stripe customer changed' using errcode='P0001';
      end if;
      perform public.link_stripe_customer((p_plan->>'userId')::uuid,p_plan->>'customerId');
    end if;
    perform public.set_entitlement((p_plan->>'userId')::uuid,p_plan->>'status',(p_plan->>'periodEnd')::timestamptz,p_plan->>'subscriptionId');
  end if;
  update public.stripe_events set processing_state='complete',outcome=p_outcome,lease_token=null,processing_scope=null where id=p_id;
  delete from public.stripe_processing_locks where scope=e.processing_scope and lease_token=p_token;
end $$;

create or replace function public.release_stripe_event(p_id text, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare key text;
begin
  update public.stripe_events set processing_state='pending',lease_token=null
    where id=p_id and processing_state='processing' and lease_token=p_token returning processing_scope into key;
  if found then
    delete from public.stripe_processing_locks where scope=key and lease_token=p_token;
    update public.stripe_events set processing_scope=null where id=p_id;
  end if;
end $$;

-- Delayed success must not steal a slot after its hold was released.
create or replace function public.confirm_ticket(p_session text, p_payment_intent text, p_amount integer)
returns text language plpgsql security definer set search_path = public as $$
declare t public.tickets%rowtype;
begin
  select * into t from public.tickets where checkout_session_id=p_session for update;
  if not found then return 'unknown'; end if;
  if t.status not in ('pending','expired') then return 'duplicate'; end if;
  if t.status='expired' or t.expires_at<=now() or p_amount is distinct from t.amount_cents then
    update public.tickets set status='refund_pending',payment_intent_id=p_payment_intent where id=t.id;
    return 'refund';
  end if;
  begin
    update public.tickets set status='paid',payment_intent_id=p_payment_intent,paid_at=now() where id=t.id;
    insert into public.event_attendees(event_id,user_id) values(t.event_id,t.user_id) on conflict do nothing;
    return 'confirmed';
  exception when others then
    update public.tickets set status='refund_pending',payment_intent_id=p_payment_intent where id=t.id;
    return 'refund';
  end;
end $$;

do $$ declare f text; begin
  foreach f in array array['claim_stripe_event(text, text, text, uuid)', 'finish_stripe_event(text, uuid, text, jsonb)', 'release_stripe_event(text, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
