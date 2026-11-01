-- Shared server-only limits. Raw IPs/emails never enter these tables.
create table public.server_abuse_counters (
  action text not null, key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null, expires_at timestamptz not null,
  count integer not null check (count >= 0), primary key(action,key_hash)
);
create index server_abuse_expiry on public.server_abuse_counters(expires_at);
alter table public.server_abuse_counters enable row level security;
revoke all on public.server_abuse_counters from public, anon, authenticated;

-- Limits are selected by the server's policy name, never by a client-supplied max.
-- Lock keys in a stable order; check ALL budgets before reserving any of them.
create function public.consume_server_abuse(p_keys jsonb, p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = public as $$
declare r record; cap integer; seconds integer; win timestamptz; used integer; wait_seconds integer := 0;
begin
  if jsonb_typeof(p_keys) <> 'array' or jsonb_array_length(p_keys) not between 1 and 4 then
    raise exception 'Invalid limiter keys';
  end if;
  for r in select distinct x->>'action' as action, x->>'key' as key from jsonb_array_elements(p_keys) x order by 1,2 loop
    if r.key is null or r.key !~ '^[0-9a-f]{64}$' then raise exception 'Invalid limiter key'; end if;
    case r.action
      when 'signin_ip' then cap := 20; seconds := 900;
      when 'signin_email' then cap := 5; seconds := 900;
      when 'signup_ip' then cap := 5; seconds := 3600;
      when 'signup_email' then cap := 5; seconds := 3600;
      when 'reset_ip' then cap := 5; seconds := 3600;
      when 'reset_email' then cap := 5; seconds := 3600;
      when 'ads' then cap := 120; seconds := 3600;
      when 'beacon' then cap := 240; seconds := 3600;
      when 'geocode' then cap := 30; seconds := 60;
      else raise exception 'Unknown limiter action';
    end case;
    perform pg_advisory_xact_lock(hashtextextended('abuse:' || r.action || ':' || r.key, 0));
    win := to_timestamp(floor(extract(epoch from p_now) / seconds) * seconds);
    select c.count into used from public.server_abuse_counters c
      where c.action=r.action and c.key_hash=r.key and c.window_start=win;
    if coalesce(used,0) >= cap then
      wait_seconds := greatest(wait_seconds, ceil(extract(epoch from (win + make_interval(secs=>seconds) - p_now)))::integer);
    end if;
  end loop;
  if wait_seconds > 0 then return wait_seconds; end if;
  for r in select distinct x->>'action' as action, x->>'key' as key from jsonb_array_elements(p_keys) x order by 1,2 loop
    seconds := case when r.action in ('signin_ip','signin_email') then 900 when r.action='geocode' then 60 else 3600 end;
    win := to_timestamp(floor(extract(epoch from p_now) / seconds) * seconds);
    insert into public.server_abuse_counters(action,key_hash,window_start,expires_at,count)
      values(r.action,r.key,win,win + make_interval(secs=>seconds),1)
      on conflict(action,key_hash) do update set window_start=excluded.window_start, expires_at=excluded.expires_at,
        count=case when server_abuse_counters.window_start=excluded.window_start then server_abuse_counters.count+1 else 1 end;
  end loop;
  return 0;
end $$;
revoke all on function public.consume_server_abuse(jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.consume_server_abuse(jsonb,timestamptz) to service_role;

-- No queue: admit at most one Nominatim call per 1.1 seconds application-wide.
create table public.geocode_provider_gate (id boolean primary key default true check(id), next_at timestamptz not null);
insert into public.geocode_provider_gate values(true,'-infinity');
alter table public.geocode_provider_gate enable row level security;
revoke all on public.geocode_provider_gate from public, anon, authenticated;
create function public.claim_geocode_provider() returns boolean
language plpgsql security definer set search_path=public as $$
declare at timestamptz;
begin
  perform 1 from public.geocode_provider_gate where id for update;
  at := clock_timestamp();
  update public.geocode_provider_gate set next_at=at + interval '1.1 seconds' where id and next_at<=at;
  return found;
end $$;
revoke all on function public.claim_geocode_provider() from public, anon, authenticated;
grant execute on function public.claim_geocode_provider() to service_role;

create table public.ad_beacon_nonces (nonce uuid primary key, expires_at timestamptz not null);
create index ad_beacon_expiry on public.ad_beacon_nonces(expires_at);
create table public.ad_client_daily (
  campaign_id uuid not null references public.ad_campaigns(id) on delete cascade,
  key_hash text not null check(key_hash ~ '^[0-9a-f]{64}$'), day date not null,
  count integer not null check(count between 1 and 3), primary key(campaign_id,key_hash,day)
);
alter table public.ad_beacon_nonces enable row level security;
alter table public.ad_client_daily enable row level security;
revoke all on public.ad_beacon_nonces, public.ad_client_daily from public, anon, authenticated;

-- Selection never bills. Existing serve_ad callers safely stop charging too.
create or replace function public.serve_ad(
  p_slot text, p_north double precision, p_south double precision, p_east double precision, p_west double precision,
  p_category text, p_now timestamptz default now()
) returns table(campaign_id uuid,kind text,target_id uuid,headline text,body text)
language sql security definer set search_path=public as $$
  select c.id,c.kind,coalesce(c.place_id,c.event_id),c.headline,c.body
  from public.ad_campaigns c
  cross join lateral (select coalesce(sum(i.impressions),0) total,
    coalesce(sum(i.impressions) filter(where i.day=(p_now at time zone 'UTC')::date),0) today
    from public.ad_impressions i where i.campaign_id=c.id) n
  where c.kind=case p_slot when 'places' then 'place' when 'events' then 'event' end
    and c.status='active' and c.starts_at<=p_now and c.ends_at>p_now
    and public.ad_target_ok(c.kind,c.place_id,c.event_id,c.advertiser_id)
    and (c.category_slug is null or p_category is null or c.category_slug=p_category)
    and (c.north is null or p_north is null or (c.south<p_north and c.north>p_south and c.west<p_east and c.east>p_west))
    and n.total < public.ad_impression_budget(c.budget_cents)
    and n.today < ceil(public.ad_impression_budget(c.budget_cents)::numeric / greatest(ceil(extract(epoch from(c.ends_at-c.starts_at))/86400),1))
  order by n.today,c.id limit 1;
$$;
revoke all on function public.serve_ad(text,double precision,double precision,double precision,double precision,text,timestamptz) from public, anon, authenticated;
grant execute on function public.serve_ad(text,double precision,double precision,double precision,double precision,text,timestamptz) to service_role;

-- The HTTP server verifies the signed token before calling this service-only RPC.
create function public.record_ad_impression(p_campaign uuid,p_slot text,p_client_hash text,p_nonce uuid,p_expires timestamptz,p_now timestamptz default clock_timestamp())
returns boolean language plpgsql security definer set search_path=public as $$
declare c public.ad_campaigns%rowtype; total bigint; today bigint; used integer; d date := (p_now at time zone 'UTC')::date;
begin
  if p_expires is null or p_expires<=p_now or p_expires>p_now+interval '5 minutes'
    or p_nonce is null or p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  -- A row lock also serializes pause/refund/expiry updates. Re-read totals AFTER it.
  select * into c from public.ad_campaigns where id=p_campaign for update;
  if not found or c.status<>'active' or c.starts_at>p_now or c.ends_at<=p_now
    or c.kind is distinct from case p_slot when 'places' then 'place' when 'events' then 'event' end
    or not public.ad_target_ok(c.kind,c.place_id,c.event_id,c.advertiser_id) then return false; end if;
  select coalesce(sum(impressions),0),coalesce(sum(impressions) filter(where day=d),0) into total,today
    from public.ad_impressions where campaign_id=c.id;
  select count into used from public.ad_client_daily where campaign_id=c.id and key_hash=p_client_hash and day=d;
  if coalesce(used,0)>=3 or total>=public.ad_impression_budget(c.budget_cents)
    or today>=ceil(public.ad_impression_budget(c.budget_cents)::numeric/greatest(ceil(extract(epoch from(c.ends_at-c.starts_at))/86400),1)) then return false; end if;
  insert into public.ad_beacon_nonces values(p_nonce,p_expires) on conflict do nothing;
  if not found then return false; end if;
  insert into public.ad_client_daily values(c.id,p_client_hash,d,1)
    on conflict(campaign_id,key_hash,day) do update set count=ad_client_daily.count+1;
  insert into public.ad_impressions values(c.id,d,p_slot,1)
    on conflict(campaign_id,day,slot) do update set impressions=ad_impressions.impressions+1;
  if total+1>=public.ad_impression_budget(c.budget_cents) then update public.ad_campaigns set status='ended' where id=c.id; end if;
  return true;
end $$;
revoke all on function public.record_ad_impression(uuid,text,text,uuid,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.record_ad_impression(uuid,text,text,uuid,timestamptz,timestamptz) to service_role;

-- Bounded cleanup from the existing hourly cron; no raw identifiers to retain.
create function public.purge_server_abuse() returns void language plpgsql security definer set search_path=public as $$
begin
  delete from public.server_abuse_counters where (action,key_hash) in
    (select action,key_hash from public.server_abuse_counters where expires_at<now() order by expires_at limit 10000);
  delete from public.ad_beacon_nonces where nonce in
    (select nonce from public.ad_beacon_nonces where expires_at<now() order by expires_at limit 10000);
  delete from public.ad_client_daily where (campaign_id,key_hash,day) in
    (select campaign_id,key_hash,day from public.ad_client_daily where day<(now() at time zone 'UTC')::date order by day limit 10000);
end $$;
revoke all on function public.purge_server_abuse() from public, anon, authenticated;
grant execute on function public.purge_server_abuse() to service_role;
