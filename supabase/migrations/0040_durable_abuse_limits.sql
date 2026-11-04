-- Shared server-only abuse limits (security batch 1, part 0.1a: F3/F7 and the ad request cap).
-- Raw IPs/emails never enter these tables: callers pass 64-hex HMAC keys (src/server/limiters.ts).
-- The signed ad beacon and ad billing changes are NOT here; they are reserved for 0041 (0.1b).
create table public.server_abuse_counters (
  action text not null, key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null, expires_at timestamptz not null,
  count integer not null check (count >= 0), primary key(action,key_hash)
);
create index server_abuse_expiry on public.server_abuse_counters(expires_at);
alter table public.server_abuse_counters enable row level security;
revoke all on public.server_abuse_counters from public, anon, authenticated;

-- One place for the policy: caps are selected by the server's action name, never by a client-supplied max.
-- Must match ABUSE_LIMITS in src/lib/abuseLimits.ts (tests/abuse-limits.test.ts compares them).
-- *_unknown are the deliberately generous shared buckets used when a request carries no trusted client IP
-- (owner decision D1); sign-in and reset never use a shared IP bucket.
create function public.server_abuse_budgets(p_keys jsonb, p_now timestamptz)
returns table(action text, key_hash text, cap integer, seconds integer, win timestamptz)
language sql stable set search_path = public as $$
  select k.action, k.key_hash, rules.cap, rules.seconds,
    to_timestamp(floor(extract(epoch from p_now) / rules.seconds) * rules.seconds)
  from (select distinct x->>'action' as action, x->>'key' as key_hash from jsonb_array_elements(p_keys) x) k
  left join (values
    ('signin_ip', 20, 900), ('signin_email', 5, 900),
    ('signup_ip', 5, 3600), ('signup_email', 5, 3600), ('signup_unknown', 50, 3600),
    ('reset_ip', 5, 3600), ('reset_email', 5, 3600),
    ('ads', 120, 3600),
    ('geocode', 30, 60), ('geocode_unknown', 300, 60)
  ) as rules(action, cap, seconds) on rules.action = k.action
  order by k.action, k.key_hash;
$$;
revoke all on function public.server_abuse_budgets(jsonb,timestamptz) from public, anon, authenticated;

-- Lock keys in a stable order; check ALL budgets before reserving any of them, so a key at its cap
-- never spends another key's budget. Returns 0 when admitted, else the seconds until the blocking
-- window ends.
-- p_now is taken before the lock, so a request stamped in an older window can arrive after one in a
-- newer window. It is counted against the newest stored window; a key never moves back to an older
-- window (that would reset its count and let alternating stale/fresh requests through).
create function public.consume_server_abuse(p_keys jsonb, p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = public as $$
declare r record; stored record; wins timestamptz[] := '{}'; win timestamptz; used integer; wait_seconds integer := 0; i integer := 0;
begin
  if p_keys is null or jsonb_typeof(p_keys) <> 'array' or jsonb_array_length(p_keys) not between 1 and 4 then
    raise exception 'Invalid limiter keys';
  end if;
  if exists (select 1 from jsonb_array_elements(p_keys) x
             where jsonb_typeof(x) <> 'object' or coalesce(x->>'key', '') !~ '^[0-9a-f]{64}$') then
    raise exception 'Invalid limiter key';
  end if;
  for r in select * from public.server_abuse_budgets(p_keys, p_now) loop
    if r.cap is null then raise exception 'Unknown limiter action'; end if;
    perform pg_advisory_xact_lock(hashtextextended('abuse:' || r.action || ':' || r.key_hash, 0));
    select c.window_start, c.count into stored from public.server_abuse_counters c
      where c.action = r.action and c.key_hash = r.key_hash;
    win := greatest(r.win, stored.window_start);
    used := case when stored.window_start = win then stored.count else 0 end;
    wins := wins || win;
    if coalesce(used, 0) >= r.cap then
      wait_seconds := greatest(wait_seconds,
        ceil(extract(epoch from (win + make_interval(secs => r.seconds) - p_now)))::integer);
    end if;
  end loop;
  if wait_seconds > 0 then return wait_seconds; end if;
  for r in select * from public.server_abuse_budgets(p_keys, p_now) loop
    i := i + 1;
    win := wins[i];
    insert into public.server_abuse_counters(action, key_hash, window_start, expires_at, count)
      values (r.action, r.key_hash, win, win + make_interval(secs => r.seconds), 1)
      on conflict (action, key_hash) do update set window_start = excluded.window_start, expires_at = excluded.expires_at,
        count = case when server_abuse_counters.window_start = excluded.window_start
                     then server_abuse_counters.count + 1 else 1 end;
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
  at := clock_timestamp(); -- read after the row lock, so a waiter sees the winner's next_at
  update public.geocode_provider_gate set next_at=at + interval '1.1 seconds' where id and next_at<=at;
  return found;
end $$;
revoke all on function public.claim_geocode_provider() from public, anon, authenticated;
grant execute on function public.claim_geocode_provider() to service_role;

-- Bounded cleanup, called in a short loop by the daily purge-analytics cron. Returns rows deleted.
create function public.purge_server_abuse(p_limit integer default 10000, p_now timestamptz default now())
returns integer language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  delete from public.server_abuse_counters where (action,key_hash) in
    (select action,key_hash from public.server_abuse_counters where expires_at < p_now
     order by expires_at limit least(greatest(coalesce(p_limit, 10000), 1), 10000));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_server_abuse(integer,timestamptz) from public, anon, authenticated;
grant execute on function public.purge_server_abuse(integer,timestamptz) to service_role;
