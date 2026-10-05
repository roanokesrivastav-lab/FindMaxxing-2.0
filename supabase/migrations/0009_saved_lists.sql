-- ============================================================================
-- FindMaxxing — saved lists.
--
-- saved_places stays the canonical bookmark: saving a place is still one row
-- there, and a saved place need not be in any list. Lists organize bookmarks:
-- a place can sit in several of its owner's lists.
--
-- The invariants live in two composite foreign keys, so no code path (and no
-- client talking to PostgREST directly) can break them:
--
--   * (list_id, owner_id) → saved_lists (id, owner_id): an item's owner is its
--     list's owner. Nobody can put anything in someone else's list.
--   * (owner_id, place_id) → saved_places (user_id, place_id): an item is
--     always one of its owner's bookmarks. No orphan items; unsaving a place
--     removes it from every list (and deleting a place already cascades to
--     saved_places, so it reaches the lists too).
--
-- Deleting a list removes its items and leaves the bookmarks alone.
-- ============================================================================

create table public.saved_lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  -- Stored normalized (see normalize_list_name), so the check and the unique
  -- index below judge exactly what the application does.
  name        text not null check (char_length(name) between 1 and 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Target for the items' composite foreign key.
  unique (id, owner_id)
);

-- One list per name per owner, ignoring case (and, through normalization, spacing).
create unique index saved_lists_owner_name_idx on public.saved_lists (owner_id, lower(name));
create index saved_lists_owner_updated_idx on public.saved_lists (owner_id, updated_at desc);

create table public.saved_list_items (
  list_id     uuid not null,
  owner_id    uuid not null,
  -- Also a plain key to places: redundant with the bookmark key below (place
  -- deletion reaches items through saved_places either way), but it is what
  -- lets PostgREST embed the place when reading a list.
  place_id    uuid not null references public.places (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (list_id, place_id),
  foreign key (list_id, owner_id) references public.saved_lists (id, owner_id) on delete cascade,
  foreign key (owner_id, place_id) references public.saved_places (user_id, place_id) on delete cascade
);

-- Memberships of one bookmark (the save button's "in these lists"), and the
-- cascade from saved_places.
create index saved_list_items_bookmark_idx on public.saved_list_items (owner_id, place_id);

-- ----------------------------------------------------------------------------
-- Name normalization, cap and bookkeeping
-- ----------------------------------------------------------------------------

-- Every whitespace run becomes one space and the ends are trimmed, with the
-- same explicit character class as normalizeListName() in
-- src/lib/data/savedLists.ts (exactly JavaScript's \s). btrim alone would keep
-- tabs and newlines, accepting a blank name and letting "Coffee shop" and
-- "Coffee  shop" coexist where the application sees one name.
create or replace function public.normalize_list_name(p_name text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    regexp_replace(p_name, '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'),
    '^ | $', '', 'g'
  );
$$;

-- Before the check constraint and the unique index, which see the result.
create or replace function public.normalize_saved_list_name()
returns trigger
language plpgsql
as $$
begin
  new.name := public.normalize_list_name(new.name);
  return new;
end $$;

create trigger saved_lists_normalize_name
  before insert or update of name on public.saved_lists
  for each row execute function public.normalize_saved_list_name();

-- Serialized per owner, like the photo cap: two concurrent inserts must not
-- both see 99 lists.
create or replace function public.check_saved_list_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing int;
begin
  perform pg_advisory_xact_lock(hashtextextended('saved_lists:' || new.owner_id::text, 0));
  select count(*) into existing from public.saved_lists where owner_id = new.owner_id;
  if existing >= 100 then
    raise exception 'You can have at most 100 lists' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger saved_lists_limit
  before insert on public.saved_lists
  for each row execute function public.check_saved_list_limit();

create or replace function public.touch_saved_list()
returns trigger
language plpgsql
as $$
begin
  -- RLS already refuses handing a list to someone else; this also covers the
  -- service role and keeps the items' composite key meaningful.
  if new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at then
    raise exception 'Only a list''s name can change' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger saved_lists_touch
  before update on public.saved_lists
  for each row execute function public.touch_saved_list();

-- Adding or removing a place counts as updating the list. Definer rights: the
-- cascade from an unsave runs this too, and the list row must be updatable
-- whatever the column grants.
create or replace function public.touch_saved_list_from_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.saved_lists
     set updated_at = now()
   where id = coalesce(new.list_id, old.list_id);
  return null;
end $$;

create trigger saved_list_items_touch
  after insert or delete on public.saved_list_items
  for each row execute function public.touch_saved_list_from_item();

-- ----------------------------------------------------------------------------
-- Row-level security: owners only
-- ----------------------------------------------------------------------------
alter table public.saved_lists      enable row level security;
alter table public.saved_list_items enable row level security;

create policy "owners see own lists" on public.saved_lists for select
  using (owner_id = auth.uid());
create policy "owners create own lists" on public.saved_lists for insert
  with check (owner_id = auth.uid());
create policy "owners rename own lists" on public.saved_lists for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
create policy "owners delete own lists" on public.saved_lists for delete
  using (owner_id = auth.uid());

create policy "owners see own list items" on public.saved_list_items for select
  using (owner_id = auth.uid());
-- The foreign keys already require the list and the bookmark to be the
-- caller's; the place must also still be one they can see, as for saving.
create policy "owners add to own lists" on public.saved_list_items for insert
  with check (owner_id = auth.uid() and public.can_view_place(place_id));
create policy "owners remove from own lists" on public.saved_list_items for delete
  using (owner_id = auth.uid());

-- Only the name can change: a list never moves to another owner, and items
-- are added or removed, never rewritten.
revoke update on public.saved_lists from anon, authenticated;
grant update (name) on public.saved_lists to authenticated;
revoke update on public.saved_list_items from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Read and write helpers (invoker rights: RLS applies)
-- ----------------------------------------------------------------------------

-- The caller's lists, most recently changed first, with how many of their
-- places the caller can open: published and visible, the same filter the
-- Saved page uses for bookmarks.
create or replace function public.saved_list_summaries()
returns table (id uuid, name text, created_at timestamptz, updated_at timestamptz, place_count integer)
language sql
stable
security invoker
as $$
  select l.id, l.name, l.created_at, l.updated_at,
         count(p.id)::integer
  from public.saved_lists l
  left join public.saved_list_items i on i.list_id = l.id
  left join public.places p on p.id = i.place_id and p.status = 'published'
  where l.owner_id = auth.uid()
  group by l.id
  order by l.updated_at desc, l.id;
$$;

-- Bookmark a place (if it is not already) and add it to one of the caller's
-- lists, in one transaction. Both inserts go through RLS; the foreign keys
-- reject a list the caller does not own.
create or replace function public.add_to_saved_list(p_list_id uuid, p_place_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from public.saved_lists where id = p_list_id) then
    raise exception 'List not found' using errcode = 'P0002';
  end if;
  insert into public.saved_places (user_id, place_id)
  values (auth.uid(), p_place_id)
  on conflict do nothing;
  insert into public.saved_list_items (list_id, owner_id, place_id)
  values (p_list_id, auth.uid(), p_place_id)
  on conflict do nothing;
end $$;

revoke all on function public.saved_list_summaries() from public;
revoke all on function public.add_to_saved_list(uuid, uuid) from public;
grant execute on function public.saved_list_summaries() to authenticated;
grant execute on function public.add_to_saved_list(uuid, uuid) to authenticated;
