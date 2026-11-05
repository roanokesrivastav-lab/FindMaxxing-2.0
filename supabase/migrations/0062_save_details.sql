-- ============================================================================
-- FindMaxxing — richer saves (roadmap 3.1).
--
-- Save first, organise later: a save stays one insert of (user_id, place_id).
-- The details are optional columns on the save itself, so they live and die
-- with it: a private note, personal tags, a source URL, who recommended it, and
-- a want-to-go / visited status. All of it is owner-only: saved_places RLS
-- already shows a user only their own rows, and nothing else reads these
-- columns (no view, no definer function, no notification payload). The owner
-- may now update their own save, but only these columns.
-- ============================================================================

alter table public.saved_places
  add column note            text check (note is null or char_length(note) <= 500),
  add column tags            text[] not null default '{}'
                             check (cardinality(tags) <= 10),
  add column source_url      text check (source_url is null or (char_length(source_url) <= 500 and source_url ~* '^https?://')),
  add column recommended_by  text check (recommended_by is null or char_length(recommended_by) <= 80),
  add column status          text not null default 'want_to_go' check (status in ('want_to_go', 'visited')),
  add column updated_at      timestamptz not null default now();

-- Personal tags: lowercase, trimmed, 1–24 characters, no duplicates (mirrors src/lib/places/saves.ts).
create or replace function public.normalize_save_details()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  t text;
  clean text[] := '{}';
begin
  foreach t in array coalesce(new.tags, '{}') loop
    t := lower(btrim(t));
    if char_length(t) between 1 and 24 and not (t = any(clean)) then
      clean := clean || t;
    end if;
  end loop;
  new.tags := clean;
  new.note := nullif(btrim(new.note), '');
  new.recommended_by := nullif(btrim(new.recommended_by), '');
  new.source_url := nullif(btrim(new.source_url), '');
  if tg_op = 'UPDATE' then
    -- Clients (a user JWT) cannot move a save; trusted maintenance without one may (as in 0030).
    if auth.uid() is not null and (new.user_id, new.place_id, new.created_at) is distinct from (old.user_id, old.place_id, old.created_at) then
      raise exception 'A save''s owner, place and date are fixed' using errcode = '42501';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;

create trigger saved_places_normalize_details
  before insert or update on public.saved_places
  for each row execute function public.normalize_save_details();

create policy "users update own saves" on public.saved_places for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke update on public.saved_places from anon, authenticated;
grant update (note, tags, source_url, recommended_by, status) on public.saved_places to authenticated;

create index saved_places_user_status_idx on public.saved_places (user_id, status);
