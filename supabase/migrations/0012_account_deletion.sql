-- ============================================================================
-- FindMaxxing — account deletion.
--
-- Deleting an account deletes the auth user (a server-side admin call); the
-- profile follows through its foreign key, and everything below follows the
-- profile:
--
--   * places and events they created: deleted (they were SET NULL, which left
--     ownerless listings nobody could edit or delete)
--   * photos they uploaded to anyone's place: deleted (they were SET NULL, which
--     kept a photo row whose stored objects the deletion removes)
--   * ratings, saves, lists, follows, attendance: already cascade
--   * reports they filed: KEPT, with the reporter cleared. An open report about
--     harmful content should not vanish because the person who filed it left,
--     and a removal decision should still show what it was based on. Nothing
--     identifies them afterwards.
--   * moderation history they wrote: kept, moderator cleared (0010).
-- ============================================================================

alter table public.places drop constraint places_creator_id_fkey;
alter table public.places
  add constraint places_creator_id_fkey foreign key (creator_id) references public.profiles (id) on delete cascade;

alter table public.events drop constraint events_creator_id_fkey;
alter table public.events
  add constraint events_creator_id_fkey foreign key (creator_id) references public.profiles (id) on delete cascade;

alter table public.place_photos drop constraint place_photos_uploader_id_fkey;
alter table public.place_photos
  add constraint place_photos_uploader_id_fkey foreign key (uploader_id) references public.profiles (id) on delete cascade;

alter table public.reports alter column reporter_id drop not null;
alter table public.reports drop constraint reports_reporter_id_fkey;
alter table public.reports
  add constraint reports_reporter_id_fkey foreign key (reporter_id) references public.profiles (id) on delete set null;

-- The owner trigger refuses deleting an event other people joined. That rule
-- is for owners tidying up, not for an account being deleted: when the
-- creator's profile is already gone, the cascade must go through.
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql as $$
begin
  if current_setting('findmaxxing.moderation', true) = 'on' and public.is_moderator() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and old.creator_id is not null
     and not exists (select 1 from public.profiles where id = old.creator_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if old.status <> 'published' or coalesce(old.ends_at, old.starts_at) <= now() then
      raise exception 'Only future published events can be edited or cancelled' using errcode = 'P0001';
    end if;
    if new.status not in ('published', 'cancelled') then
      raise exception 'Invalid event status' using errcode = 'P0001';
    end if;
    if new.status = 'published' and coalesce(new.ends_at, new.starts_at) <= now() then
      raise exception 'Events must remain in the future when edited' using errcode = 'P0001';
    end if;
    if new.status = 'published' and new.capacity is not null and
       new.capacity < (select count(*) from public.event_attendees where event_id = old.id) then
      raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
    end if;
    if new.status = 'cancelled' and (
      new.title, new.description, new.place_id, new.location_name, new.address,
      new.lat, new.lng, new.starts_at, new.ends_at, new.creator_id,
      new.category_slug, new.capacity
    ) is distinct from (
      old.title, old.description, old.place_id, old.location_name, old.address,
      old.lat, old.lng, old.starts_at, old.ends_at, old.creator_id,
      old.category_slug, old.capacity
    ) then
      raise exception 'Cancelling an event cannot also change its details' using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.event_attendees
      where event_id = old.id and user_id is distinct from old.creator_id
    ) then
      raise exception 'Events with other attendees must be cancelled instead' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- Every stored object an account deletion must remove, for the service role
-- only: photos the user uploaded anywhere, and every photo on places they
-- created (those cascade away, and other people's objects would be orphaned).
-- Avatars and never-attached uploads live in the user's own folders, which the
-- deletion lists separately.
create or replace function public.account_storage_paths(p_user_id uuid)
returns table (storage_path text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct ph.storage_path
  from public.place_photos ph
  left join public.places p on p.id = ph.place_id
  where ph.storage_path is not null
    and (ph.uploader_id = p_user_id or p.creator_id = p_user_id);
$$;

revoke all on function public.account_storage_paths(uuid) from public, anon, authenticated;
grant execute on function public.account_storage_paths(uuid) to service_role;
