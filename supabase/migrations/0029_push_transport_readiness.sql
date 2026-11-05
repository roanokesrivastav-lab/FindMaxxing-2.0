-- Claim one notification separately for each ready transport. A browser
-- credential outage must not consume browser work while Expo is available.
alter table public.notifications add column push_claimed_kinds text[] not null default '{}'
  check (push_claimed_kinds <@ array['web','expo']::text[]);

create or replace function public.claim_transport_push_batch(p_now timestamptz default now(), p_limit integer default 100,
  p_daily_cap integer default 5, p_kinds text[] default array['web','expo'])
returns table (notification_id uuid, user_id uuid, type text, actor_username text, subject_type text, subject_id uuid,
               label text, detail text, count integer, devices jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n record; s public.notification_settings%rowtype; v_devices jsonb; v_hour integer; v_kinds text[];
begin
  if p_kinds is null or not (p_kinds <@ array['web','expo']::text[]) then raise exception 'Unknown push transport' using errcode='P0001'; end if;
  if cardinality(p_kinds)=0 then return; end if;
  for n in
    select x.* from public.notifications x where x.push_state='pending' and (
      x.created_at < p_now-interval '24 hours'
      or not exists (select 1 from public.push_subscriptions d where d.user_id=x.user_id)
      or exists (select 1 from public.notification_settings ns where ns.user_id=x.user_id and not (x.type=any(ns.push_types)))
      or exists (select 1 from public.push_subscriptions d where d.user_id=x.user_id and d.kind=any(p_kinds) and not (d.kind=any(x.push_claimed_kinds))))
    order by x.created_at,x.id limit least(greatest(coalesce(p_limit,100),1),1000) for update skip locked
  loop
    select * into s from public.notification_settings ns where ns.user_id=n.user_id;
    select coalesce(jsonb_agg(jsonb_build_object('kind',d.kind,'endpoint',d.endpoint,'p256dh',d.p256dh,'auth',d.auth) order by d.created_at,d.id),'[]'::jsonb)
      into v_devices from public.push_subscriptions d where d.user_id=n.user_id and d.kind=any(p_kinds) and not (d.kind=any(n.push_claimed_kinds));
    if (s.user_id is not null and not (n.type=any(s.push_types)))
      or not exists (select 1 from public.push_subscriptions d where d.user_id=n.user_id)
      or n.created_at < p_now-interval '24 hours' then
      update public.notifications set push_state='skipped' where id=n.id;
      continue;
    end if;
    if v_devices='[]'::jsonb then continue; end if;
    if s.user_id is not null and s.quiet_start is not null then
      v_hour := extract(hour from p_now at time zone s.time_zone)::integer;
      if (s.quiet_start<s.quiet_end and v_hour>=s.quiet_start and v_hour<s.quiet_end)
        or (s.quiet_start>s.quiet_end and (v_hour>=s.quiet_start or v_hour<s.quiet_end)) then continue; end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('push_cap:' || n.user_id::text,0));
    if cardinality(n.push_claimed_kinds)=0 then
      if (select count(*) from public.push_log l where l.user_id=n.user_id and l.sent_at>p_now-interval '24 hours')>=p_daily_cap then
        update public.notifications set push_state='capped' where id=n.id;
        continue;
      end if;
      insert into public.push_log(user_id,notification_id,sent_at) values(n.user_id,n.id,p_now);
    end if;
    v_kinds := array(select distinct value->>'kind' from jsonb_array_elements(v_devices));
    update public.notifications set push_claimed_kinds=n.push_claimed_kinds || v_kinds,
      push_state=case when exists (select 1 from public.push_subscriptions d where d.user_id=n.user_id
        and not (d.kind=any(n.push_claimed_kinds || v_kinds))) then 'pending' else 'sent' end where id=n.id;
    return query select n.id,n.user_id,n.type,(select username from public.profiles where id=n.actor_id),
      n.subject_type,n.subject_id,n.label,n.detail,n.count,v_devices;
  end loop;
end $$;
revoke all on function public.claim_transport_push_batch(timestamptz, integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.claim_transport_push_batch(timestamptz, integer, integer, text[]) to service_role;

-- Preserve the prior service-only RPC contract for older callers/tests. New
-- application code always supplies transport readiness to the new function.
create or replace function public.claim_push_batch(p_now timestamptz default now(),p_limit integer default 100,p_daily_cap integer default 5)
returns table (notification_id uuid, user_id uuid, type text, actor_username text, subject_type text, subject_id uuid,
               label text, detail text, count integer, devices jsonb)
language sql security definer set search_path = public as $$
  select * from public.claim_transport_push_batch(p_now,p_limit,p_daily_cap,array['web','expo']);
$$;
