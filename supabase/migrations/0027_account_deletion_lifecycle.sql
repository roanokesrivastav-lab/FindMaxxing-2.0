-- A service-only deletion journal, deliberately without a cascading user FK.
-- It survives Auth deletion and records enough to retry external cleanup.
create table public.account_deletion_jobs (
  user_id uuid primary key,
  storage_paths jsonb not null default '[]'::jsonb,
  removed_storage_paths jsonb not null default '[]'::jsonb,
  stripe_customer_id text,
  stripe_subscription_ids text[] not null default '{}',
  canceled_subscription_ids text[] not null default '{}',
  billing_complete boolean not null default false,
  storage_complete boolean not null default false,
  lease_token uuid,
  leased_until timestamptz not null default '-infinity',
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.account_deletion_jobs enable row level security;
revoke all on public.account_deletion_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.account_deletion_jobs to service_role;

-- Caller-bound for ordinary sessions; service callers have no JWT subject.
create or replace function public.account_is_closing(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case when auth.uid() is not null and auth.uid() <> p_user then false
    else exists (select 1 from public.account_deletion_jobs where user_id = p_user)
      or not exists (select 1 from public.profiles where id = p_user) end;
$$;
revoke all on function public.account_is_closing(uuid) from public, anon;
grant execute on function public.account_is_closing(uuid) to authenticated, service_role;

-- Serialize a closing account against signed-in writes, including uploads.
create or replace function public.block_suspended_writes()
returns trigger language plpgsql security definer set search_path = public as $$
declare target_owner uuid;
begin
  if auth.uid() is not null then
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
    if exists (select 1 from public.suspensions where user_id = auth.uid()) then
      raise exception 'account_suspended' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.account_deletion_jobs where user_id = auth.uid()) then
      raise exception 'account_deletion_in_progress' using errcode = 'P0001';
    end if;
  end if;
  -- A late payment must refund rather than admit a closing buyer.
  if tg_table_name = 'event_attendees' and tg_op = 'INSERT' then
    target_owner := (to_jsonb(new)->>'user_id')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('account_close:' || target_owner::text, 0));
    if exists (select 1 from public.account_deletion_jobs where user_id = target_owner) then
      raise exception 'account_deletion_in_progress' using errcode = 'P0001';
    end if;
  end if;
  -- Another person cannot attach new photos to a place being deleted.
  if tg_table_name = 'place_photos' and tg_op in ('INSERT', 'UPDATE') then
    select creator_id into target_owner from public.places where id = (to_jsonb(new)->>'place_id')::uuid;
    if target_owner is not null then
      perform pg_advisory_xact_lock(hashtextextended('account_close:' || target_owner::text, 0));
      if exists (select 1 from public.account_deletion_jobs where user_id = target_owner) then
        raise exception 'account_deletion_in_progress' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.count_upload(p_bucket text, p_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  if public.account_is_closing(auth.uid()) then raise exception 'account_deletion_in_progress' using errcode = 'P0001'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  if p_bucket = 'avatars' then perform public.check_rate_limit('avatars');
  elsif p_bucket = 'place-photos' and p_name !~ '\.(sm|md)\.[a-z]+$' then perform public.check_rate_limit('photos'); end if;
  return true;
end $$;

-- Inventory Storage metadata in one transaction, including nested folders,
-- unattached uploads and other people's photos on the owner's places. This
-- avoids Storage list API pagination and snapshots paths before cascades.
create or replace function public.prepare_account_deletion(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare paths jsonb; customer text; subscription text; previous jsonb; has_objects boolean;
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
  -- Close future events now so a late confirmation cannot admit another buyer.
  update public.events set status = 'cancelled' where creator_id = p_user and status = 'published' and starts_at > now();
  update public.tickets set status = 'expired' where status = 'pending'
    and (user_id = p_user or event_id in (select id from public.events where creator_id = p_user));
end $$;

create or replace function public.claim_account_deletion(p_user uuid)
returns setof public.account_deletion_jobs language plpgsql security definer set search_path = public as $$
begin
  perform public.prepare_account_deletion(p_user);
  return query update public.account_deletion_jobs
    set lease_token = gen_random_uuid(), leased_until = now() + interval '10 minutes', updated_at = now()
    where user_id = p_user and completed_at is null and leased_until <= now() returning *;
end $$;

create or replace function public.save_account_deletion_progress(p_user uuid, p_lease uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.account_deletion_jobs set
    removed_storage_paths = case when p_patch ? 'removed' then
      (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select distinct x from jsonb_array_elements(removed_storage_paths || (p_patch->'removed')) x) merged)
      else removed_storage_paths end,
    canceled_subscription_ids = case when p_patch ? 'canceled' then
      array(select distinct x from unnest(canceled_subscription_ids || array(select jsonb_array_elements_text(p_patch->'canceled'))) x)
      else canceled_subscription_ids end,
    stripe_subscription_ids = case when p_patch ? 'subscriptions' then array(select jsonb_array_elements_text(p_patch->'subscriptions')) else stripe_subscription_ids end,
    billing_complete = coalesce((p_patch->>'billing')::boolean, billing_complete),
    storage_complete = coalesce((p_patch->>'storage')::boolean, storage_complete),
    leased_until = case when p_patch->>'release' = 'true' then '-infinity'::timestamptz else now() + interval '10 minutes' end,
    updated_at = now()
    where user_id = p_user and lease_token = p_lease and completed_at is null;
  if not found then raise exception 'Deletion lease lost' using errcode = 'P0001'; end if;
  if p_patch->>'complete' = 'true' then
    if exists (select 1 from auth.users where id = p_user)
      or exists (select 1 from public.account_deletion_jobs where user_id = p_user and (not billing_complete or not storage_complete)) then
      raise exception 'Deletion is not complete' using errcode = 'P0001';
    end if;
    -- Only the tombstone remains; personal object paths/billing identifiers go.
    update public.account_deletion_jobs set completed_at = now(), storage_paths = '[]', removed_storage_paths = '[]', stripe_customer_id = null,
      stripe_subscription_ids = '{}', canceled_subscription_ids = '{}', lease_token = null, leased_until = '-infinity' where user_id = p_user;
  end if;
end $$;

-- Also preserve the lifecycle when an administrator deletes Auth directly.
create or replace function public.journal_profile_deletion()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- An admin repairing a profile while its Auth user still exists is not an
  -- account deletion. During the Auth FK cascade, the Auth row is already gone.
  if not exists (select 1 from auth.users where id = old.id) then
    perform public.prepare_account_deletion(old.id);
  end if;
  return old;
end $$;
create trigger profiles_journal_deletion before delete on public.profiles for each row execute function public.journal_profile_deletion();

-- Event deletion (including cascades) must preserve future refund obligations.
create or replace function public.refund_before_event_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.tickets set status = 'expired' where event_id = old.id and status = 'pending';
  if old.starts_at > now() then
    update public.tickets set status = 'refund_pending' where event_id = old.id and status = 'paid';
  end if;
  return old;
end $$;
create trigger events_refund_before_delete before delete on public.events for each row execute function public.refund_before_event_delete();

-- Late Stripe events are acknowledged without recreating a closed profile's
-- customer/plan/payout state. Lock against preparation, including missing users.
create or replace function public.set_entitlement(p_user uuid, p_status text, p_period_end timestamptz, p_subscription text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || p_user::text, 0));
  if public.account_is_closing(p_user) then return; end if;
  insert into public.entitlements (user_id, status, current_period_end, stripe_subscription_id, updated_at)
  values (p_user, p_status, p_period_end, p_subscription, now()) on conflict (user_id) do update
    set status = excluded.status, current_period_end = excluded.current_period_end, stripe_subscription_id = excluded.stripe_subscription_id, updated_at = now();
end $$;
create or replace function public.link_stripe_customer(p_user uuid, p_customer text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || p_user::text, 0));
  if public.account_is_closing(p_user) then return; end if;
  insert into public.stripe_customers(user_id, customer_id) values (p_user, p_customer)
    on conflict (user_id) do update set customer_id = excluded.customer_id;
end $$;
create or replace function public.set_host_account(p_user uuid, p_account text, p_charges_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || p_user::text, 0));
  if public.account_is_closing(p_user) then return; end if;
  insert into public.host_accounts(user_id, stripe_account_id, charges_enabled, updated_at) values (p_user, p_account, p_charges_enabled, now())
    on conflict (user_id) do update set stripe_account_id = excluded.stripe_account_id, charges_enabled = excluded.charges_enabled, updated_at = now();
end $$;

do $$ declare f text; begin
  foreach f in array array['prepare_account_deletion(uuid)', 'claim_account_deletion(uuid)', 'save_account_deletion_progress(uuid, uuid, jsonb)',
    'set_entitlement(uuid, text, timestamptz, text)', 'link_stripe_customer(uuid, text)', 'set_host_account(uuid, text, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
