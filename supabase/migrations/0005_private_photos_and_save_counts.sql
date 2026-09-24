-- ============================================================================
-- FindMaxxing — private place photos and trustworthy save counts.
--
-- Two gaps found after the Tier 2 audit:
--
--   1. place_photos rows respected place visibility, but the objects lived in a
--      public bucket. Anyone holding an object URL could fetch a locals-only
--      place's photo without a session. The bucket becomes private; reads go
--      through a storage policy that applies the same can_view_place() rule,
--      and the app delivers photos through short-lived signed URLs.
--
--   2. The save total was a client-side count over saved_places, whose policy
--      exposes only the viewer's own rows, so everyone saw 0 or 1. The total is
--      now a denormalized column maintained by a definer trigger, like
--      rating_count: aggregate visible, savers still private.
--
-- Avatars stay public: they are part of the public profile.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Private place photos
-- ----------------------------------------------------------------------------

-- Rows written before 0002 kept only the public URL. Recover the object path so
-- every Storage-backed photo can be delivered through the private path.
update public.place_photos
   set storage_path = substring(url from '/storage/v1/object/public/place-photos/(.+)$')
 where storage_path is null
   and url ~ '/storage/v1/object/public/place-photos/.+';

create index if not exists place_photos_storage_path_idx
  on public.place_photos (storage_path)
  where storage_path is not null;

update storage.buckets set public = false where id = 'place-photos';

-- True when the object backs at least one photo row the current user may see.
-- Definer rights so the storage policy is not subject to place_photos RLS; the
-- visibility decision is still delegated to can_view_place().
create or replace function public.can_view_place_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.place_photos ph
    where ph.storage_path = object_name
      and public.can_view_place(ph.place_id)
  );
$$;

revoke all on function public.can_view_place_photo_object(text) from public;
grant execute on function public.can_view_place_photo_object(text) to anon, authenticated;

-- True when the object backs at least one photo row, whatever the caller may
-- see. Definer rights are the point: evaluated under the caller's own RLS, an
-- uploader who cannot view the attached place would also not see the
-- attachment row, and their folder exception would never expire.
create or replace function public.has_attached_photo_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.place_photos ph
    where ph.storage_path = object_name
  );
$$;

revoke all on function public.has_attached_photo_object(text) from public;
grant execute on function public.has_attached_photo_object(text) to anon, authenticated;

drop policy if exists "public read images" on storage.objects;
drop policy if exists "public read avatars" on storage.objects;
drop policy if exists "read visible place photos" on storage.objects;

create policy "public read avatars" on storage.objects for select
  using (bucket_id = 'avatars');

-- Uploaders can read their own objects only while they are not yet attached
-- to a photo row (the window between upload and insert, plus cleanup of
-- orphaned uploads). Once attached, the object follows place visibility for
-- everyone: the uploader-folder exception must not outlive it, even when the
-- uploader cannot view the place it was attached to. Orphaned objects (never
-- attached, or detached by photo-row deletion) stay readable by their
-- uploader, which keeps the documented cleanup path working.
create policy "read visible place photos" on storage.objects for select
  using (
    bucket_id = 'place-photos'
    and (
      (
        (storage.foldername(name))[1] = auth.uid()::text
        and not public.has_attached_photo_object(name)
      )
      or public.can_view_place_photo_object(name)
    )
  );

-- ----------------------------------------------------------------------------
-- 2. Save counts
-- ----------------------------------------------------------------------------
alter table public.places
  add column if not exists save_count int not null default 0 check (save_count >= 0);

update public.places p
   set save_count = (select count(*) from public.saved_places s where s.place_id = p.id);

-- Increments rather than recounts: the UPDATE takes the place row lock and
-- re-evaluates save_count against the latest committed value, so concurrent
-- saves cannot lose an update the way a snapshot recount could.
create or replace function public.refresh_place_save_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.places set save_count = save_count + 1 where id = new.place_id;
  elsif tg_op = 'DELETE' then
    update public.places set save_count = greatest(save_count - 1, 0) where id = old.place_id;
  end if;
  return null;
end $$;

drop trigger if exists saved_places_refresh_count on public.saved_places;
create trigger saved_places_refresh_count
  after insert or delete on public.saved_places
  for each row execute function public.refresh_place_save_count();

-- Aggregates are server-maintained. A direct client insert could otherwise
-- start a place with an arbitrary save or rating total; column UPDATE grants
-- already exclude them.
create or replace function public.reset_place_aggregates()
returns trigger
language plpgsql
as $$
begin
  new.save_count := 0;
  new.rating_avg := 0;
  new.rating_count := 0;
  return new;
end $$;

drop trigger if exists places_reset_aggregates on public.places;
create trigger places_reset_aggregates
  before insert on public.places
  for each row execute function public.reset_place_aggregates();

-- Aggregate maintenance should not look like a content edit.
create or replace function public.set_place_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['save_count', 'rating_avg', 'rating_count', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['save_count', 'rating_avg', 'rating_count', 'updated_at']) then
    new.updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists places_updated_at on public.places;
create trigger places_updated_at
  before update on public.places
  for each row execute function public.set_place_updated_at();
