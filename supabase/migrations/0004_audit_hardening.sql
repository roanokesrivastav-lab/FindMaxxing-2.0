-- Security and consistency fixes discovered during the Tier 2 audit.

-- Centralize place visibility so parent and child-table policies cannot drift.
create or replace function public.can_view_place(target_place_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.places p
    where p.id = target_place_id
      and (
        p.creator_id = auth.uid()
        or (
          p.status = 'published'
          and (
            p.visibility = 'public'
            or (p.visibility = 'locals' and public.is_local(p.city))
          )
        )
      )
  );
$$;

revoke all on function public.can_view_place(uuid) from public;
grant execute on function public.can_view_place(uuid) to anon, authenticated;

-- Events inherit the visibility of a linked place. This prevents a public event
-- pin from disclosing a locals-only place's name and exact coordinates.
create or replace function public.can_view_event(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        e.creator_id = auth.uid()
        or (
          e.status = 'published'
          and (e.place_id is null or public.can_view_place(e.place_id))
        )
        or (
          e.status = 'cancelled'
          and exists (
            select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = auth.uid()
          )
        )
      )
  );
$$;

revoke all on function public.can_view_event(uuid) from public;
grant execute on function public.can_view_event(uuid) to anon, authenticated;

-- `is_local` answers a question about the current user's profile and should not
-- be callable as an anonymous public RPC. RLS policies still invoke it through
-- the security-definer visibility functions above.
revoke all on function public.is_local(text) from public;
grant execute on function public.is_local(text) to authenticated;

drop policy if exists "visible places" on public.places;
create policy "visible places" on public.places for select
  using (public.can_view_place(id));

drop policy if exists "visible events" on public.events;
create policy "visible events" on public.events for select
  using (public.can_view_event(id));

drop policy if exists "event tags are public" on public.event_tags;
create policy "visible event tags" on public.event_tags for select
  using (public.can_view_event(event_id));

drop policy if exists "attendees are public" on public.event_attendees;
create policy "visible event attendees" on public.event_attendees for select
  using (public.can_view_event(event_id));

drop policy if exists "users join as self" on public.event_attendees;
create policy "users join visible events" on public.event_attendees for insert
  with check (user_id = auth.uid() and public.can_view_event(event_id));

drop policy if exists "users create events" on public.events;
create policy "users create events" on public.events for insert
  with check (
    creator_id = auth.uid()
    and status = 'published'
    and (place_id is null or public.can_view_place(place_id))
  );

drop policy if exists "place tags are public" on public.place_tags;
create policy "visible place tags" on public.place_tags for select
  using (public.can_view_place(place_id));

drop policy if exists "place photos are public" on public.place_photos;
create policy "visible place photos" on public.place_photos for select
  using (public.can_view_place(place_id));

drop policy if exists "ratings are public" on public.place_ratings;
create policy "visible place ratings" on public.place_ratings for select
  using (public.can_view_place(place_id));

drop policy if exists "users rate as self" on public.place_ratings;
create policy "users rate visible places" on public.place_ratings for insert
  with check (user_id = auth.uid() and public.can_view_place(place_id));

drop policy if exists "users update own rating" on public.place_ratings;
create policy "users update own rating" on public.place_ratings for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_view_place(place_id));

drop policy if exists "users save as self" on public.saved_places;
create policy "users save visible places" on public.saved_places for insert
  with check (user_id = auth.uid() and public.can_view_place(place_id));

drop policy if exists "signed-in users add place photos" on public.place_photos;
create policy "signed-in users add place photos" on public.place_photos for insert
  with check (
    uploader_id = auth.uid()
    and storage_path is not null
    and storage_path like auth.uid()::text || '/%'
    and public.can_view_place(place_id)
  );

drop policy if exists "uploaders remove own photos" on public.place_photos;
create policy "uploaders or place owners remove photos" on public.place_photos for delete
  using (
    uploader_id = auth.uid()
    or exists (
      select 1 from public.places p
      where p.id = place_id and p.creator_id = auth.uid()
    )
  );

-- Serialize photo-count checks per place. Without the advisory lock, two
-- concurrent inserts can both observe five rows and produce seven photos.
create or replace function public.check_place_photo_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing int;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.place_id::text, 0));
  select count(*) into existing from public.place_photos where place_id = new.place_id;
  if existing >= 6 then
    raise exception 'A place can have at most 6 photos' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Correct Tier 1's total-attendee check and ensure an edit cannot move a
-- published event into the past. Cancelling may only change the status.
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

drop policy if exists "users update own events" on public.events;
create policy "users update own events" on public.events for update
  using (creator_id = auth.uid() and status = 'published' and coalesce(ends_at, starts_at) > now())
  with check (
    creator_id = auth.uid()
    and status in ('published', 'cancelled')
    and (status = 'cancelled' or coalesce(ends_at, starts_at) > now())
    and (place_id is null or public.can_view_place(place_id))
  );

drop policy if exists "users delete own events" on public.events;
create policy "users delete own events" on public.events for delete
  using (
    creator_id = auth.uid()
    and not exists (
      select 1 from public.event_attendees a
      where a.event_id = id and a.user_id is distinct from creator_id
    )
  );

-- Polymorphic report targets cannot use a normal foreign key, so validate them
-- at insertion time. Reports remain after later target deletion by design.
create or replace function public.check_report_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type = 'place' and not exists (select 1 from public.places where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  elsif new.target_type = 'event' and not exists (select 1 from public.events where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  elsif new.target_type = 'profile' and not exists (select 1 from public.profiles where id = new.target_id) then
    raise exception 'Report target does not exist' using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists reports_check_target on public.reports;
create trigger reports_check_target
  before insert on public.reports
  for each row execute function public.check_report_target();

-- Transactional application operations. Storage uploads happen first, but all
-- relational writes now commit or roll back together.
create or replace function public.create_place_with_details(
  p_name text, p_description text, p_local_tip text, p_category_slug text,
  p_lat double precision, p_lng double precision, p_address text,
  p_neighborhood text, p_city text, p_visibility text, p_tags text[], p_photos jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  created_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_visibility not in ('public', 'locals') then
    raise exception 'Invalid place visibility' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) image
    where image->>'url' is null
       or image->>'storagePath' is null
       or (image->>'storagePath') not like auth.uid()::text || '/%'
  ) then
    raise exception 'Invalid place photo' using errcode = 'P0001';
  end if;
  insert into public.places (
    name, description, local_tip, category_slug, lat, lng, address,
    neighborhood, city, creator_id, visibility
  ) values (
    p_name, p_description, p_local_tip, p_category_slug, p_lat, p_lng,
    p_address, p_neighborhood, p_city, auth.uid(), p_visibility
  ) returning id into created_id;

  insert into public.place_tags (place_id, interest_slug)
    select created_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;

  insert into public.place_photos (place_id, url, storage_path, uploader_id, sort_order)
    select created_id, image->>'url', image->>'storagePath', auth.uid(), ordinality - 1
    from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) with ordinality as items(image, ordinality);

  return created_id;
end $$;

create or replace function public.update_place_with_tags(
  p_id uuid, p_name text, p_description text, p_local_tip text,
  p_category_slug text, p_lat double precision, p_lng double precision,
  p_address text, p_neighborhood text, p_city text, p_tags text[]
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  updated_id uuid;
begin
  update public.places set
    name = p_name, description = p_description, local_tip = p_local_tip,
    category_slug = p_category_slug, lat = p_lat, lng = p_lng,
    address = p_address, neighborhood = p_neighborhood, city = p_city
  where id = p_id and creator_id = auth.uid()
  returning id into updated_id;
  if updated_id is null then raise exception 'You do not own this place' using errcode = '42501'; end if;

  delete from public.place_tags where place_id = p_id;
  insert into public.place_tags (place_id, interest_slug)
    select p_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;
  return updated_id;
end $$;

create or replace function public.update_event_with_tags(
  p_id uuid, p_title text, p_description text, p_place_id uuid,
  p_location_name text, p_address text, p_lat double precision,
  p_lng double precision, p_starts_at timestamptz, p_ends_at timestamptz,
  p_category_slug text, p_capacity int, p_tags text[]
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  updated_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_place_id is not null and not public.can_view_place(p_place_id) then
    raise exception 'Linked place is not visible to you' using errcode = '42501';
  end if;
  update public.events set
    title = p_title, description = p_description, place_id = p_place_id,
    location_name = p_location_name, address = p_address, lat = p_lat,
    lng = p_lng, starts_at = p_starts_at, ends_at = p_ends_at,
    category_slug = p_category_slug, capacity = p_capacity
  where id = p_id and creator_id = auth.uid()
  returning id into updated_id;
  if updated_id is null then raise exception 'You do not own this event' using errcode = '42501'; end if;

  delete from public.event_tags where event_id = p_id;
  insert into public.event_tags (event_id, interest_slug)
    select p_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;
  return updated_id;
end $$;

revoke all on function public.create_place_with_details(text,text,text,text,double precision,double precision,text,text,text,text,text[],jsonb) from public;
revoke all on function public.update_place_with_tags(uuid,text,text,text,text,double precision,double precision,text,text,text,text[]) from public;
revoke all on function public.update_event_with_tags(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,text,int,text[]) from public;
grant execute on function public.create_place_with_details(text,text,text,text,double precision,double precision,text,text,text,text,text[],jsonb) to authenticated;
grant execute on function public.update_place_with_tags(uuid,text,text,text,text,double precision,double precision,text,text,text,text[]) to authenticated;
grant execute on function public.update_event_with_tags(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,text,int,text[]) to authenticated;
