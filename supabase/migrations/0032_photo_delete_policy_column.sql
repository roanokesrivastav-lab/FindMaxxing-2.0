-- ============================================================================
-- FindMaxxing — qualify the object name in the place-photo delete policy.
--
-- "place owners delete photo objects" (0008) compared photo_object_stem(name)
-- inside a subquery that joins public.places, which has its own `name`
-- column. Unqualified, `name` bound to places.name, so anyone could delete
-- another owner's photo object by naming one of their own places after its
-- storage path. Refer to the storage object's column explicitly.
-- ============================================================================
drop policy if exists "place owners delete photo objects" on storage.objects;
create policy "place owners delete photo objects" on storage.objects for delete
  using (
    bucket_id = 'place-photos'
    and exists (
      select 1
      from public.place_photos ph
      join public.places p on p.id = ph.place_id
      where ph.storage_path is not null
        and public.photo_object_stem(ph.storage_path) = public.photo_object_stem(objects.name)
        and p.creator_id = auth.uid()
    )
  );
