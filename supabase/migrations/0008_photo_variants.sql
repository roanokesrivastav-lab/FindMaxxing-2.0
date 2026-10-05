-- ============================================================================
-- FindMaxxing — place-photo size variants.
--
-- The image pipeline stores each place photo at its storage_path (the large
-- size) plus smaller copies beside it: `owner/abc.webp` has `owner/abc.md.webp`
-- and `owner/abc.sm.webp`. Only the large object has a place_photos row, so the
-- storage policies, which match objects to rows by exact storage_path, would
-- deny every smaller size. Here objects match on a shared stem instead, so each
-- variant follows exactly the visibility and delete rules of its photo.
--
-- Legacy `.jpg` / `.png` originals have no siblings. scripts/migrate-images.ts
-- stores pipeline output for them at a new `.webp` path and repoints the row;
-- the stem ignores the extension either way.
-- ============================================================================

-- `owner/abc.webp`, `owner/abc.md.webp`, `owner/abc.jpg` → `owner/abc`.
create or replace function public.photo_object_stem(object_name text)
returns text
language sql
immutable
as $$
  select regexp_replace(object_name, '(\.(sm|md))?\.(jpe?g|png|webp)$', '', 'i');
$$;

grant execute on function public.photo_object_stem(text) to anon, authenticated;

create index if not exists place_photos_storage_stem_idx
  on public.place_photos (public.photo_object_stem(storage_path))
  where storage_path is not null;

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
    where ph.storage_path is not null
      and public.photo_object_stem(ph.storage_path) = public.photo_object_stem(object_name)
      and public.can_view_place(ph.place_id)
  );
$$;

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
    where ph.storage_path is not null
      and public.photo_object_stem(ph.storage_path) = public.photo_object_stem(object_name)
  );
$$;

-- Place owners clean up every size of a photo on their place, not just the
-- large one, before the cascading row delete.
drop policy if exists "place owners delete photo objects" on storage.objects;
create policy "place owners delete photo objects" on storage.objects for delete
  using (
    bucket_id = 'place-photos'
    and exists (
      select 1
      from public.place_photos ph
      join public.places p on p.id = ph.place_id
      where ph.storage_path is not null
        and public.photo_object_stem(ph.storage_path) = public.photo_object_stem(name)
        and p.creator_id = auth.uid()
    )
  );
