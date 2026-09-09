-- ============================================================================
-- FindMaxxing Tier 2 — the community layer.
--
-- Additive over 0001_init.sql and 0002_tier1_owner_controls.sql. Nothing here
-- changes an existing column's meaning; it opens up capability the baseline
-- schema already anticipated:
--
--   * locals-only visibility becomes reachable, with a concrete "who is a
--     local" rule expressed once, in SQL, and mirrored by the demo store
--   * owners may hide and unhide their own listings
--   * places accept a bounded photo set instead of a single cover
--   * reports gain two read paths that leak no reporter identity
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Who counts as a local
--
-- A viewer is a local of a city when either is true:
--   1. their profile home city matches, or
--   2. they have contributed at least one published place there.
--
-- SECURITY DEFINER so the function bypasses row-level security on the tables it
-- reads. That is required, not incidental: this runs inside the places SELECT
-- policy, and an invoker-rights function reading public.places from there would
-- recurse into the policy that called it.
-- ----------------------------------------------------------------------------
create or replace function public.is_local(target_city text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    target_city is not null
    and auth.uid() is not null
    and (
      exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.home_city is not null
          and lower(btrim(p.home_city)) = lower(btrim(target_city))
      )
      or exists (
        select 1
        from public.places pl
        where pl.creator_id = auth.uid()
          and pl.status = 'published'
          and lower(btrim(pl.city)) = lower(btrim(target_city))
      )
    );
$$;

comment on function public.is_local(text) is
  'True when the current user has the given city as their home city, or has contributed a published place there. Used by the locals-only visibility tier.';

-- Locals-only places become visible to locals. Creators always see their own.
drop policy if exists "visible places" on public.places;
create policy "visible places" on public.places for select
  using (
    creator_id = auth.uid()
    or (
      status = 'published'
      and (
        visibility = 'public'
        or (visibility = 'locals' and public.is_local(city))
      )
    )
  );

-- ----------------------------------------------------------------------------
-- Owner-writable status and visibility
--
-- Owners may hide and unhide, and may choose a visibility tier. 'pending' and
-- 'removed' stay reserved for moderation via the service role: the WITH CHECK
-- below is what makes that reservation real rather than a UI convention.
-- ----------------------------------------------------------------------------
grant update (status, visibility) on public.places to authenticated;

drop policy if exists "users update own places" on public.places;
create policy "users update own places" on public.places for update
  using (creator_id = auth.uid())
  with check (
    creator_id = auth.uid()
    and status in ('published', 'hidden')
    and visibility in ('public', 'locals', 'private')
  );

-- A place may only be created in a state its owner is allowed to set.
drop policy if exists "users create places" on public.places;
create policy "users create places" on public.places for insert
  with check (
    creator_id = auth.uid()
    and status = 'published'
    and visibility in ('public', 'locals')
  );

-- ----------------------------------------------------------------------------
-- Bounded photo sets
-- ----------------------------------------------------------------------------
create or replace function public.check_place_photo_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing int;
begin
  select count(*) into existing from public.place_photos where place_id = new.place_id;
  if existing >= 6 then
    raise exception 'A place can have at most 6 photos' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists place_photos_limit on public.place_photos;
create trigger place_photos_limit
  before insert on public.place_photos
  for each row execute function public.check_place_photo_limit();

-- Photos may be contributed by any signed-in user, not only the place creator,
-- so a gallery can grow from the community. Removal stays with the uploader
-- (0001) or the place owner (0002).
drop policy if exists "owners add place photos" on public.place_photos;
create policy "signed-in users add place photos" on public.place_photos for insert
  with check (
    uploader_id = auth.uid()
    and exists (
      select 1 from public.places p
      where p.id = place_id and p.status = 'published'
    )
  );

-- ----------------------------------------------------------------------------
-- Where reports go
--
-- Two read paths, neither of which exposes who filed a report:
--
--   reports_i_filed        — the reporter's own history, with status
--   reports_about_my_stuff — anonymized reports against your places/events
--
-- Both are definer-rights views: they bypass RLS on public.reports and do their
-- own filtering, so the reporter_id column is not merely unselected, it is
-- unreachable. A moderation console over the base table remains service-role
-- work and is deliberately not built here.
-- ----------------------------------------------------------------------------
create or replace view public.reports_i_filed as
  select r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at
  from public.reports r
  where r.reporter_id = auth.uid();

create or replace view public.reports_about_my_stuff as
  select r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at
  from public.reports r
  where
    (
      r.target_type = 'place'
      and exists (select 1 from public.places p where p.id = r.target_id and p.creator_id = auth.uid())
    )
    or (
      r.target_type = 'event'
      and exists (select 1 from public.events e where e.id = r.target_id and e.creator_id = auth.uid())
    );

grant select on public.reports_i_filed to authenticated;
grant select on public.reports_about_my_stuff to authenticated;

comment on view public.reports_about_my_stuff is
  'Reports filed against the current user''s own places and events, without reporter identity.';
