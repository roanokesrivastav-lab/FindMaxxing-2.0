-- ============================================================================
-- FindMaxxing — bounded discovery queries.
--
-- Discovery used to fetch the newest 500 places / 200 events and filter in the
-- browser, so anything past the cutoff could not be found at all. These
-- functions filter in SQL (bounding box, text, category, tags) and leave
-- ordering, keyset pagination and limits to the caller, who uses them for two
-- read models:
--
--   * paginated lists  — full rows, ordered, cursor-paged
--   * map markers      — compact columns, capped, ranked by notability
--
-- Visibility: the functions are SECURITY INVOKER, so the places/events RLS
-- policies (can_view_place / can_view_event) apply to every row they return.
--
-- They are deliberately plain `language sql`, STABLE, with no SET clause and
-- fully qualified names. That keeps them inlinable: the planner folds the body
-- into the caller's query, so ORDER BY / LIMIT from PostgREST can use the
-- indexes below instead of sorting a materialized function result.
--
-- Text matching: p_text is matched as a literal substring (LIKE wildcards are
-- escaped here, not trusted from the client). Taxonomy keywords ("hoops" ->
-- pickup-sports) live in TypeScript, so the caller expands them and passes the
-- matching category and interest slugs in p_text_categories / p_text_tags.
-- ============================================================================

create or replace function public.discover_like_pattern(p_text text)
returns text
language sql
immutable
as $$
  select case
    when p_text is null or btrim(p_text) = '' then null
    else '%' || replace(replace(replace(btrim(p_text), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  end;
$$;

-- Bounding-box test that also handles boxes crossing the antimeridian
-- (west > east). A null box matches everything.
create or replace function public.discover_in_bounds(
  lat double precision, lng double precision,
  p_north double precision, p_south double precision,
  p_east double precision, p_west double precision
) returns boolean
language sql
immutable
as $$
  select p_north is null
      or (
        lat between p_south and p_north
        and case when p_west <= p_east then lng between p_west and p_east
                 else lng >= p_west or lng <= p_east end
      );
$$;

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
  -- Events that end (or, with no end, start) before this are excluded.
  p_ends_after timestamptz default null,
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
    and (p_category is null or e.category_slug = p_category)
    and (
      coalesce(cardinality(p_tags), 0) = 0
      or exists (
        select 1 from public.event_tags t
        where t.event_id = e.id and t.interest_slug = any (p_tags)
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

revoke all on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, uuid) from public;
revoke all on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, timestamptz, uuid) from public;
grant execute on function public.discover_places(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_events(double precision, double precision, double precision, double precision, text, text[], text[], text, text[], timestamptz, timestamptz, uuid) to anon, authenticated;
grant execute on function public.discover_like_pattern(text) to anon, authenticated;
grant execute on function public.discover_in_bounds(double precision, double precision, double precision, double precision, double precision, double precision) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Indexes for the two orderings and the tag filters
-- ----------------------------------------------------------------------------
create index if not exists places_discover_recent_idx
  on public.places (created_at desc, id desc) where status = 'published';
create index if not exists places_discover_notable_idx
  on public.places (rating_count desc, save_count desc, id) where status = 'published';
create index if not exists events_discover_upcoming_idx
  on public.events (starts_at, id) where status = 'published';
create index if not exists event_tags_interest_idx
  on public.event_tags (interest_slug);
