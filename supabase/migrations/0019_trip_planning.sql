-- ============================================================================
-- FindMaxxing — AI trip planning: a per-user daily limit.
--
-- Plans are built server-side by a Claude agent that only reads (through the
-- caller's own session, so RLS applies to every tool). Nothing is written
-- until the person saves the plan as a list, which goes through the usual
-- saved-list rules. The one thing to bound is how often anyone can ask:
-- 10 plans a day, counted by the same limiter as every other write.
-- The app calls check_rate_limit('trip_plans') before each plan.
-- ============================================================================

insert into public.rate_limit_rules (action, max_count, window_seconds, label)
values ('trip_plans', 10, 86400, 'trip plans');
