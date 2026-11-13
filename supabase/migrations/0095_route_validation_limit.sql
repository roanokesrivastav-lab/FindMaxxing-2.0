-- Roadmap 6.1: a durable cap on walking-route validations (6.0 decision R-3), so a refresh loop
-- cannot burn a routing provider's quota. Trips lane; allocated in the 2026-11-12 preflight.
--
-- It adds ONE action to the 0040 limiter and changes nothing else: same table, same
-- consume_server_abuse, same grants. Every earlier budget is repeated unchanged below, because the
-- policy lives in one function. Must match ABUSE_LIMITS in src/lib/abuseLimits.ts
-- (tests/abuse-limits.test.ts compares the effective policy).
--
--   route_validation: 60 per signed-in user per hour. The key is an HMAC of the authenticated user
--   id, made by the server (src/server/limiters.ts); no raw id is stored.
create or replace function public.server_abuse_budgets(p_keys jsonb, p_now timestamptz)
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
    ('geocode', 30, 60), ('geocode_unknown', 300, 60),
    ('route_validation', 60, 3600)
  ) as rules(action, cap, seconds) on rules.action = k.action
  order by k.action, k.key_hash;
$$;
-- Replacing a function keeps its privileges; said again so the file stands on its own.
revoke all on function public.server_abuse_budgets(jsonb,timestamptz) from public, anon, authenticated;
