-- ============================================================================
-- FindMaxxing — first-run onboarding.
--
-- New accounts go through /welcome once: interests, home city (with the local
-- tier explained), optional location, then the map filtered to their
-- interests. onboarded_at records that it was finished or skipped, so it never
-- shows again. Everyone who signed up before this migration counts as done.
-- ============================================================================

alter table public.profiles add column onboarded_at timestamptz;

update public.profiles set onboarded_at = created_at where onboarded_at is null;

-- The owner may mark it done (or, harmlessly, not done) like any profile field.
grant update (onboarded_at) on public.profiles to authenticated;
