-- ============================================================================
-- FindMaxxing — public and personal place photos (roadmap 2.8).
--
-- Naming: "private place photos" already means 0005's place_photos whose objects
-- follow place visibility (readable by anyone who can see a public place). This
-- ticket's owner-only photo is called the PERSONAL photo everywhere, and it never
-- touches the place-photos bucket or the place_photos table and policies.
--
-- 1. Personal photo: one per user and place, required (by the app, see below) for
--    a user's first rating or review of a place. Only its owner can ever read it:
--    a private bucket `personal-photos` whose objects live under the owner's
--    folder, storage policies that check that folder against auth.uid() and
--    nothing else (no moderator, no friend, no place owner), a table with
--    owner-only RLS, and no definer function, view or notification that reads it.
--    The app delivers it through short-lived signed URLs created with the
--    owner's own session.
-- 2. Public photo: one per place, chosen by the team (moderators or admins) from
--    the place's photos, with who set it and a permission note. It leads the place
--    page and cards (it becomes the first photo).
--
-- The first-rating requirement is enforced in the app (ratePlaceAction), behind
-- the pilotExplore flag, not by a trigger: with the flag off ratings must behave
-- exactly as today, and existing clients (including the native app, which cannot
-- upload a personal photo yet) must keep working.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Personal photos
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('personal-photos', 'personal-photos', false, 5242880, array['image/webp'])
on conflict (id) do update set public = false;

create table public.personal_place_photos (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  place_id      uuid not null references public.places (id) on delete cascade,
  storage_path  text not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, place_id),
  -- The object must sit in the owner's own folder of the personal-photos bucket.
  constraint personal_place_photos_own_folder check (storage_path like user_id::text || '/%')
);

alter table public.personal_place_photos enable row level security;

create policy "owners read own personal photos" on public.personal_place_photos for select
  using (user_id = auth.uid());
create policy "owners add personal photos to places they can see" on public.personal_place_photos for insert
  with check (user_id = auth.uid() and public.can_view_place(place_id));
create policy "owners replace own personal photos" on public.personal_place_photos for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owners remove own personal photos" on public.personal_place_photos for delete
  using (user_id = auth.uid());

revoke update on public.personal_place_photos from anon, authenticated;
grant update (storage_path) on public.personal_place_photos to authenticated;
revoke all on public.personal_place_photos from anon;

create or replace function public.touch_personal_place_photo()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := clock_timestamp();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger personal_place_photos_touch
  before insert or update on public.personal_place_photos
  for each row execute function public.touch_personal_place_photo();
create trigger personal_place_photos_block_suspended before insert or update or delete on public.personal_place_photos
  for each row execute function public.block_suspended_writes();

-- Upload gate for the personal bucket: the same account checks and the same
-- per-hour photo limit as place photos (0030's count_upload is left untouched).
create or replace function public.count_personal_upload(p_name text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null or not starts_with(p_name, auth.uid()::text || '/') then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text, 0));
  if public.account_is_closing(auth.uid()) then raise exception 'account_deletion_in_progress' using errcode = 'P0001'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  perform public.check_rate_limit('photos');
  return true;
end $$;
revoke all on function public.count_personal_upload(text) from public, anon, authenticated;
grant execute on function public.count_personal_upload(text) to authenticated;

-- Owner-only storage access. Nothing else grants access to this bucket.
create policy "owners read own personal photo objects" on storage.objects for select
  using (bucket_id = 'personal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owners upload own personal photo objects" on storage.objects for insert
  with check (bucket_id = 'personal-photos' and (storage.foldername(name))[1] = auth.uid()::text
              and public.count_personal_upload(name));
create policy "owners replace own personal photo objects" on storage.objects for update
  using (bucket_id = 'personal-photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'personal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owners delete own personal photo objects" on storage.objects for delete
  using (bucket_id = 'personal-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ----------------------------------------------------------------------------
-- 2. Public photo (team-chosen, with permission)
-- ----------------------------------------------------------------------------
create table public.place_public_photos (
  place_id         uuid primary key references public.places (id) on delete cascade,
  photo_id         uuid not null unique references public.place_photos (id) on delete cascade,
  set_by           uuid references public.profiles (id) on delete set null,
  permission_note  text not null check (char_length(btrim(permission_note)) between 1 and 300),
  created_at       timestamptz not null default now()
);

alter table public.place_public_photos enable row level security;
create policy "public photo credits follow the place" on public.place_public_photos for select
  using (public.can_view_place(place_id));
-- Written only through set_place_public_photo().
revoke insert, update, delete on public.place_public_photos from anon, authenticated;

-- Moderators (and admins) choose a place's public photo from its photos, saying
-- whose it is or what permission covers it. The chosen photo becomes the first
-- photo, so every card and page that leads with a photo leads with this one.
create or replace function public.set_place_public_photo(p_place uuid, p_photo uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_moderator() then
    raise exception 'Only the team can set a public photo' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) = 0 then
    raise exception 'Say who took it or what permission covers it' using errcode = '22023';
  end if;
  if not exists (select 1 from public.place_photos where id = p_photo and place_id = p_place) then
    raise exception 'That photo is not one of this place''s photos' using errcode = '22023';
  end if;
  insert into public.place_public_photos (place_id, photo_id, set_by, permission_note)
  values (p_place, p_photo, auth.uid(), btrim(p_note))
  on conflict (place_id) do update set photo_id = excluded.photo_id, set_by = excluded.set_by,
    permission_note = excluded.permission_note, created_at = now();
  update public.place_photos ph
     set sort_order = ordered.n
    from (
      select id, row_number() over (order by (id = p_photo) desc, sort_order, id) - 1 as n
        from public.place_photos where place_id = p_place
    ) ordered
   where ph.id = ordered.id;
end $$;
revoke all on function public.set_place_public_photo(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_place_public_photo(uuid, uuid, text) to authenticated;
