-- ============================================================================
-- FindMaxxing — discovery at 50k places in one city, and "Nearest".
--
-- Measured with tests/helpers/measure-discovery.ts (see README, Performance):
--
--   * Text search walked the recency index and ran ILIKE on every row (~350 ms
--     at 50k in PGlite). Trigram GIN indexes now serve each searched column.
--     Under RLS, though, Postgres will not run a non-leakproof operator such as
--     ILIKE ahead of the row policy, so no index can serve it for an API
--     caller. The text match therefore runs in definer-rights helpers
--     (discover_place_text_ids / discover_event_text_ids) that use the indexes
--     and apply the same visibility rule themselves, so they return only ids
--     the caller could already see; the outer query still runs under RLS. They
--     match exactly the same rows as before: a record whose name, description,
--     local tip or neighborhood contains the text, or whose category or tags
--     the taxonomy keywords expand to.
--   * The places and events SELECT policies called can_view_place(id) /
--     can_view_event(id), which looked each row up again by id. They now test
--     the row's own columns; the child tables keep using the functions. A test
--     holds the policies and the functions to the same answer for every row.
--   * discover_places_nearest(): distance-ordered discovery from a point, with
--     a keyset cursor on (distance, id). A bounding box prefilters when given.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index if not exists places_name_trgm_idx         on public.places using gin (name extensions.gin_trgm_ops);
create index if not exists places_description_trgm_idx  on public.places using gin (description extensions.gin_trgm_ops);
create index if not exists places_local_tip_trgm_idx    on public.places using gin (local_tip extensions.gin_trgm_ops);
create index if not exists places_neighborhood_trgm_idx on public.places using gin (neighborhood extensions.gin_trgm_ops);
create index if not exists events_title_trgm_idx         on public.events using gin (title extensions.gin_trgm_ops);
create index if not exists events_description_trgm_idx   on public.events using gin (description extensions.gin_trgm_ops);
create index if not exists events_location_trgm_idx      on public.events using gin (location_name extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Row policies that read the row they are given
--
-- The places policy now calls is_local() itself, as the querying role, so anon
-- needs execute on it. It answers false for anon (no auth.uid()), so this
-- exposes nothing; 0004 had revoked it only because the definer-rights
-- can_view_place() made the grant unnecessary.
-- ----------------------------------------------------------------------------
grant execute on function public.is_local(text) to anon;
drop policy if exists "visible places" on public.places;
create policy "visible places" on public.places for select
  using (
    (creator_id = auth.uid() and status <> 'removed')
    or (
      status = 'published'
      and (visibility = 'public' or (visibility = 'locals' and public.is_local(city)))
    )
  );

drop policy if exists "visible events" on public.events;
create policy "visible events" on public.events for select
  using (
    (creator_id = auth.uid() and status <> 'removed')
    or (status = 'published' and (place_id is null or public.can_view_place(place_id)))
    or (
      status = 'cancelled'
      and exists (select 1 from public.event_attendees a where a.event_id = events.id and a.user_id = auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- Text matching through the indexes
--
-- Definer rights so the trigram indexes can be used (see the header). Each
-- helper repeats the row visibility rule of its table's policy, so it never
-- returns an id the caller could not read; tests/discovery-performance.test.ts
-- compares them with the policies row by row.
-- ----------------------------------------------------------------------------
create or replace function public.discover_place_text_ids(p_text text, p_text_categories text[], p_text_tags text[])
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with pattern as (select public.discover_like_pattern(p_text) as pat),
  matches as (
    select x.id from public.places x, pattern where x.name ilike pattern.pat
    union select x.id from public.places x, pattern where x.description ilike pattern.pat
    union select x.id from public.places x, pattern where x.local_tip ilike pattern.pat
    union select x.id from public.places x, pattern where x.neighborhood ilike pattern.pat
    union select x.id from public.places x where x.category_slug = any (p_text_categories)
    union select t.place_id from public.place_tags t where t.interest_slug = any (p_text_tags)
  )
  select p.id
  from matches m
  join public.places p on p.id = m.id
  where (p.creator_id = auth.uid() and p.status <> 'removed')
     or (p.status = 'published' and (p.visibility = 'public' or (p.visibility = 'locals' and public.is_local(p.city))));
$$;

create or replace function public.discover_event_text_ids(p_text text, p_text_categories text[], p_text_tags text[])
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with pattern as (select public.discover_like_pattern(p_text) as pat),
  matches as (
    select x.id from public.events x, pattern where x.title ilike pattern.pat
    union select x.id from public.events x, pattern where x.description ilike pattern.pat
    union select x.id from public.events x, pattern where x.location_name ilike pattern.pat
    union select x.id from public.events x where x.category_slug = any (p_text_categories)
    union select t.event_id from public.event_tags t where t.interest_slug = any (p_text_tags)
  )
  select m.id from matches m where public.can_view_event(m.id);
$$;

revoke all on function public.discover_place_text_ids(text, text[], text[]) from public;
revoke all on function public.discover_event_text_ids(text, text[], text[]) from public;
grant execute on function public.discover_place_text_ids(text, text[], text[]) to anon, authenticated;
grant execute on function public.discover_event_text_ids(text, text[], text[]) to anon, authenticated;
drop function if exists public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, uuid);
drop function if exists public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, timestamptz, timestamptz, uuid);

create or replace function public.discover_places(
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_text text default null,
  p_text_categories text[] default '{}',
  p_text_tags text[] default '{}',
  p_category text default null,
  p_tags text[] default '{}',
  p_neighborhood text default null,
  p_created_after timestamptz default null,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null
) returns setof public.places
language sql
stable
security invoker
as $$
  select p.*
  from public.places p
  where p.status = 'published'
    and (p_north is null or p.lat between p_south and p_north)
    and public.discover_in_bounds(p.lat, p.lng, p_north, p_south, p_east, p_west)
    and (p_category is null or p.category_slug = p_category)
    and (
      coalesce(cardinality(p_tags), 0) = 0
      or exists (
        select 1 from public.place_tags t
        where t.place_id = p.id and t.interest_slug = any (p_tags)
      )
    )
    and (
      public.discover_like_pattern(p_text) is null
      or p.id = any (array(select public.discover_place_text_ids(p_text, p_text_categories, p_text_tags)))
    )
    and (p_neighborhood is null or public.discover_neighborhood_key(p.neighborhood) = public.discover_neighborhood_key(p_neighborhood))
    and (p_created_after is null or p.created_at >= p_created_after)
    and (p_after_created_at is null or (p.created_at, p.id) < (p_after_created_at, p_after_id));
$$;

create or replace function public.discover_events(
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_text text default null,
  p_text_categories text[] default '{}',
  p_text_tags text[] default '{}',
  p_category text default null,
  p_tags text[] default '{}',
  p_neighborhood text default null,
  p_created_after timestamptz default null,
  p_ends_after timestamptz default null,
  p_starts_before timestamptz default null,
  p_after_starts_at timestamptz default null,
  p_after_id uuid default null
) returns setof public.events
language sql
stable
security invoker
as $$
  select e.*
  from public.events e
  where e.status = 'published'
    and (p_north is null or e.lat between p_south and p_north)
    and public.discover_in_bounds(e.lat, e.lng, p_north, p_south, p_east, p_west)
    and (p_ends_after is null or coalesce(e.ends_at, e.starts_at) >= p_ends_after)
    and (p_starts_before is null or e.starts_at < p_starts_before)
    and (p_created_after is null or e.created_at >= p_created_after)
    and (p_category is null or e.category_slug = p_category)
    and (
      coalesce(cardinality(p_tags), 0) = 0
      or exists (
        select 1 from public.event_tags t
        where t.event_id = e.id and t.interest_slug = any (p_tags)
      )
    )
    and (
      p_neighborhood is null
      or exists (
        select 1 from public.places pl
        where pl.id = e.place_id
          and pl.status = 'published'
          and public.discover_neighborhood_key(pl.neighborhood) = public.discover_neighborhood_key(p_neighborhood)
      )
    )
    and (
      public.discover_like_pattern(p_text) is null
      or e.id = any (array(select public.discover_event_text_ids(p_text, p_text_categories, p_text_tags)))
    )
    and (p_after_starts_at is null or (e.starts_at, e.id) > (p_after_starts_at, p_after_id));
$$;

-- ----------------------------------------------------------------------------
-- Nearest
-- ----------------------------------------------------------------------------

-- Metres between two points, equirectangular (accurate to well under 1% at
-- city scale), rounded to the centimetre so the demo store's JavaScript twin
-- (distanceMeters in src/lib/data/discovery.ts) orders ties the same way.
create or replace function public.distance_m(lat double precision, lng double precision, p_lat double precision, p_lng double precision)
returns double precision
language sql
immutable
as $$
  select round((6371008.8 * sqrt(
    power(radians(lat - p_lat), 2)
    + power(cos(radians((lat + p_lat) / 2)) * radians(lng - p_lng - 360 * round((lng - p_lng) / 360)), 2)
  ))::numeric, 2)::double precision;
$$;

-- Visible published places matching the usual filters, nearest first, with
-- a keyset cursor on (distance_m, id). The caller limits and fetches the full
-- rows by id. Invoker rights: RLS applies through discover_places.
create or replace function public.discover_places_nearest(
  p_lat double precision,
  p_lng double precision,
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_text text default null,
  p_text_categories text[] default '{}',
  p_text_tags text[] default '{}',
  p_category text default null,
  p_tags text[] default '{}',
  p_neighborhood text default null,
  p_created_after timestamptz default null,
  p_after_distance double precision default null,
  p_after_id uuid default null
) returns table (id uuid, distance_m double precision)
language sql
stable
security invoker
as $$
  select d.id, d.distance_m
  from (
    select p.id, public.distance_m(p.lat, p.lng, p_lat, p_lng) as distance_m
    from public.discover_places(
      p_north, p_south, p_east, p_west, p_text, p_text_categories, p_text_tags,
      p_category, p_tags, p_neighborhood, p_created_after
    ) p
  ) d
  where p_after_distance is null or (d.distance_m, d.id) > (p_after_distance, p_after_id)
  order by d.distance_m, d.id;
$$;

revoke all on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, uuid) from public;
revoke all on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, timestamptz, timestamptz, uuid) from public;
revoke all on function public.discover_places_nearest(double precision, double precision, double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, double precision, uuid) from public;
grant execute on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, timestamptz, timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_places_nearest(double precision, double precision, double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, double precision, uuid) to anon, authenticated;
grant execute on function public.distance_m(double precision, double precision, double precision, double precision) to anon, authenticated;
