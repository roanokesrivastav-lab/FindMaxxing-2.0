-- ============================================================================
-- FindMaxxing — discovery filters and aggregates for the list pages.
--
-- The events, New this week, tags, neighborhoods and place-picker pages used to
-- fetch a fixed-size list (500 places / 300 events) and filter or count it in
-- the browser, so anything past the cutoff silently vanished. This migration
-- moves what those pages need into SQL:
--
--   * discover_places / discover_events gain neighborhood, created-after and
--     (events) starts-before filters, so every page is a cursor page of the
--     same two functions;
--   * discover_neighborhoods() and discover_tag_counts() compute the index
--     pages' groupings and counts over the whole data set.
--
-- All of them are SECURITY INVOKER, so RLS (can_view_place / can_view_event)
-- decides which rows are counted: a locals-only place never inflates a count
-- for someone who cannot see it. The two list functions stay plain
-- `language sql stable` with no SET clause, so they remain inlinable.
-- ============================================================================

-- Display form of a neighborhood: surrounding whitespace removed.
create or replace function public.discover_neighborhood_name(p_neighborhood text)
returns text
language sql
immutable
as $$
  select regexp_replace(p_neighborhood, '^\s+|\s+$', '', 'g');
$$;

-- Comparison key: neighborhoods differ in case and spacing across
-- contributors. The SQL twin of neighborhoodKey() in src/lib/utils/neighborhoods.ts.
create or replace function public.discover_neighborhood_key(p_neighborhood text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(public.discover_neighborhood_name(p_neighborhood), '\s+', ' ', 'g'));
$$;

drop function if exists public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, uuid);
drop function if exists public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, timestamptz, uuid);

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
  -- Matched on discover_neighborhood_key, so case and spacing do not matter.
  p_neighborhood text default null,
  -- Only places created at or after this instant.
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
    -- Written out (not only via discover_in_bounds) so the lat range can use
    -- places_lat_lng_idx as an index condition.
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
      or p.name ilike public.discover_like_pattern(p_text)
      or p.description ilike public.discover_like_pattern(p_text)
      or p.local_tip ilike public.discover_like_pattern(p_text)
      or p.neighborhood ilike public.discover_like_pattern(p_text)
      or p.category_slug = any (p_text_categories)
      or exists (
        select 1 from public.place_tags t
        where t.place_id = p.id and t.interest_slug = any (p_text_tags)
      )
    )
    and (p_neighborhood is null or public.discover_neighborhood_key(p.neighborhood) = public.discover_neighborhood_key(p_neighborhood))
    and (p_created_after is null or p.created_at >= p_created_after)
    -- Keyset cursor for the list read model: (created_at desc, id desc).
    -- A row comparison, not an OR of column tests, so it is an index condition
    -- on places_discover_recent_idx and deep pages do not sort.
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
  -- An event matches when its linked place is published, in this neighborhood,
  -- and visible to the viewer.
  p_neighborhood text default null,
  p_created_after timestamptz default null,
  -- Events that end (or, with no end, start) before this are excluded.
  p_ends_after timestamptz default null,
  -- Events that start at or after this are excluded (Today / This week).
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
      or e.title ilike public.discover_like_pattern(p_text)
      or e.description ilike public.discover_like_pattern(p_text)
      or e.location_name ilike public.discover_like_pattern(p_text)
      or e.category_slug = any (p_text_categories)
      or exists (
        select 1 from public.event_tags t
        where t.event_id = e.id and t.interest_slug = any (p_text_tags)
      )
    )
    -- Keyset cursor for the list read model: (starts_at asc, id asc).
    and (p_after_starts_at is null or (e.starts_at, e.id) > (p_after_starts_at, p_after_id));
$$;

-- ----------------------------------------------------------------------------
-- Aggregates. Names, cities and categories are compared in the C collation so
-- ties resolve the same way in every database and in the demo store.
-- ----------------------------------------------------------------------------

-- One row per neighborhood over visible published places, biggest first.
create or replace function public.discover_neighborhoods()
returns table (
  key text,
  name text,
  city text,
  place_count integer,
  top_categories text[],
  lat double precision,
  lng double precision
)
language sql
stable
security invoker
as $$
  with visible as (
    select public.discover_neighborhood_key(p.neighborhood) as k,
           public.discover_neighborhood_name(p.neighborhood) as n,
           p.city as c, p.category_slug as cat, p.lat as la, p.lng as ln
    from public.places p
    where p.status = 'published'
      and public.discover_neighborhood_key(p.neighborhood) <> ''
  ),
  per_category as (
    select k, cat, count(*) as cnt from visible group by k, cat
  ),
  totals as (
    select k,
           min(n collate "C") as n,
           min(c collate "C") as c,
           count(*)::integer as cnt,
           avg(la) as la,
           avg(ln) as ln
    from visible group by k
  )
  select t.k, t.n, t.c, t.cnt,
         (select array_agg(pc.cat order by pc.cnt desc, pc.cat collate "C") from per_category pc where pc.k = t.k),
         t.la, t.ln
  from totals t
  order by t.cnt desc, t.n collate "C", t.k collate "C";
$$;

-- Places and upcoming events carrying each interest. Events ending before
-- p_ends_after are not counted (null counts them all).
create or replace function public.discover_tag_counts(p_ends_after timestamptz default null)
returns table (interest_slug text, place_count integer, event_count integer)
language sql
stable
security invoker
as $$
  with pc as (
    select t.interest_slug as s, count(*)::integer as n
    from public.place_tags t
    join public.places p on p.id = t.place_id
    where p.status = 'published'
    group by t.interest_slug
  ),
  ec as (
    select t.interest_slug as s, count(*)::integer as n
    from public.event_tags t
    join public.events e on e.id = t.event_id
    where e.status = 'published'
      and (p_ends_after is null or coalesce(e.ends_at, e.starts_at) >= p_ends_after)
    group by t.interest_slug
  )
  select coalesce(pc.s, ec.s), coalesce(pc.n, 0), coalesce(ec.n, 0)
  from pc full join ec on pc.s = ec.s
  order by 1;
$$;

revoke all on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, uuid) from public;
revoke all on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, timestamptz, timestamptz, uuid) from public;
revoke all on function public.discover_neighborhoods() from public;
revoke all on function public.discover_tag_counts(timestamptz) from public;
grant execute on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], text, timestamptz, timestamptz, timestamptz, timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_neighborhoods() to anon, authenticated;
grant execute on function public.discover_tag_counts(timestamptz) to anon, authenticated;
grant execute on function public.discover_neighborhood_name(text) to anon, authenticated;
grant execute on function public.discover_neighborhood_key(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Neighborhood pages: equality on the key, newest first within it.
-- ----------------------------------------------------------------------------
create index if not exists places_neighborhood_key_idx
  on public.places (public.discover_neighborhood_key(neighborhood), created_at desc, id desc)
  where status = 'published';
