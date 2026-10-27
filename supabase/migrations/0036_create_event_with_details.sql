-- ============================================================================
-- FindMaxxing — create an event, its tags and the creator's attendance in one
-- transaction (docs/native-release-blockers.md).
--
-- The web Supabase adapter and the mobile app used to insert the event, then
-- its tags, then the creator's attendance as three requests: a failure after
-- the first left an untagged event its creator was not attending. This does
-- the same three inserts in one call, so they all happen or none do.
--
-- It runs as the caller (security invoker): the insert policies on events,
-- event_tags and event_attendees, the rate limit, the price guard and the
-- join checks apply exactly as they did to the separate requests. The creator
-- is always auth.uid(); there is no parameter for it.
--
-- The demo twin is events.create in src/lib/data/demo/repository.ts, which
-- already does all three in one step.
-- ============================================================================

create or replace function public.create_event_with_details(
  p_title text, p_description text, p_place_id uuid, p_location_name text, p_address text,
  p_lat double precision, p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity integer, p_tags text[]
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  created_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.events (
    title, description, place_id, location_name, address, lat, lng,
    starts_at, ends_at, creator_id, category_slug, capacity
  ) values (
    p_title, p_description, p_place_id, p_location_name, p_address, p_lat, p_lng,
    p_starts_at, p_ends_at, auth.uid(), p_category_slug, p_capacity
  ) returning id into created_id;

  insert into public.event_tags (event_id, interest_slug)
    select distinct created_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;

  insert into public.event_attendees (event_id, user_id) values (created_id, auth.uid());

  return created_id;
end $$;

revoke all on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[]) from public, anon;
grant execute on function public.create_event_with_details(text, text, uuid, text, text, double precision, double precision, timestamptz, timestamptz, text, integer, text[]) to authenticated;
