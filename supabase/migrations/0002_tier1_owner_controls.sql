-- FindMaxxing Tier 1 owner controls.
-- This migration is additive; 0001_init.sql remains the baseline schema.

alter table public.place_photos add column if not exists storage_path text;

-- Event edits are limited to future published events. Cancellation is also
-- limited to future published events; the owner may still delete only events
-- with no attendees other than the creator.
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql as $$
begin
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
    if new.status = 'published' and new.capacity is not null and
       new.capacity < (select count(*) from public.event_attendees where event_id = old.id) then
      raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if (select count(*) from public.event_attendees where event_id = old.id) > 1 then
      raise exception 'Events with other attendees must be cancelled instead' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists guard_owner_event_change on public.events;
create trigger guard_owner_event_change
  before update or delete on public.events
  for each row execute function public.guard_owner_event_change();

-- RLS remains the production authorization boundary. The trigger supplies the
-- time/attendance invariants that a row policy cannot safely express alone.
drop policy if exists "users update own events" on public.events;
create policy "users update own events" on public.events for update
  using (creator_id = auth.uid() and status = 'published' and coalesce(ends_at, starts_at) > now())
  with check (creator_id = auth.uid() and status in ('published', 'cancelled'));

drop policy if exists "users delete own events" on public.events;
create policy "users delete own events" on public.events for delete
  using (creator_id = auth.uid() and (select count(*) from public.event_attendees a where a.event_id = id) <= 1);

-- Participants and creators can continue to read cancelled events. Cancelled
-- events are therefore available by direct link and in participant activity,
-- while public browsing remains restricted by repository queries to published.
drop policy if exists "visible events" on public.events;
create policy "visible events" on public.events for select
  using (status in ('published', 'cancelled') or creator_id = auth.uid() or exists (
    select 1 from public.event_attendees a where a.event_id = id and a.user_id = auth.uid()
  ));

-- A place owner may remove a photo only through the photo row's uploader rule;
-- storage cleanup for place deletion uses the owner relationship below before
-- the cascading row delete.
create policy "place owners delete photo objects" on storage.objects for delete
  using (
    bucket_id = 'place-photos'
    and exists (
      select 1
      from public.place_photos ph
      join public.places p on p.id = ph.place_id
      where ph.storage_path = name and p.creator_id = auth.uid()
    )
  );

-- Keep the database-level photo authorization explicit after adding storage_path.
drop policy if exists "uploaders remove own photos" on public.place_photos;
create policy "uploaders remove own photos" on public.place_photos for delete
  using (uploader_id = auth.uid());
