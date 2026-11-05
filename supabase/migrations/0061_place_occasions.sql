-- ============================================================================
-- FindMaxxing — best for / less suited for (roadmap 2.7).
--
-- Contributors add short attributed occasion notes: an occasion from a small
-- list (mirrored in src/lib/places/occasions.ts), whether the place is best for
-- it or less suited, and optional free text. Many opinions coexist, one per
-- author, place, occasion and polarity. Nothing is generated or aggregated: the
-- page shows individual attributed notes.
--
-- Visibility follows the place and the note's status; moderators hide notes, and
-- hidden notes are seen only by their author and moderators.
-- ============================================================================

create table public.place_occasion_notes (
  id          uuid primary key default gen_random_uuid(),
  place_id    uuid not null references public.places (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  polarity    text not null check (polarity in ('best', 'less')),
  occasion    text not null check (occasion in (
                'date', 'big-group', 'conversation', 'solo-work', 'kids', 'quick-bite', 'late-night', 'first-visit')),
  note        text check (note is null or char_length(btrim(note)) between 1 and 140),
  status      text not null default 'published' check (status in ('published', 'hidden', 'removed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index place_occasion_notes_one_each
  on public.place_occasion_notes (place_id, author_id, occasion, polarity);
create index place_occasion_notes_place_idx on public.place_occasion_notes (place_id, status, created_at desc);

alter table public.place_occasion_notes enable row level security;

create policy "visible occasion notes" on public.place_occasion_notes for select
  using (
    public.is_moderator()
    or (public.can_view_place(place_id)
        and (status = 'published' or (auth.uid() is not null and author_id = auth.uid())))
  );
create policy "users add occasion notes to places they can see" on public.place_occasion_notes for insert
  with check (author_id = auth.uid() and status = 'published' and public.can_view_place(place_id));
create policy "authors edit own occasion notes" on public.place_occasion_notes for update
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "moderators change occasion note status" on public.place_occasion_notes for update
  using (public.is_moderator()) with check (public.is_moderator());
create policy "authors delete own occasion notes" on public.place_occasion_notes for delete
  using (author_id = auth.uid());

revoke update on public.place_occasion_notes from anon, authenticated;
grant update (note, status) on public.place_occasion_notes to authenticated;

create or replace function public.guard_place_occasion_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if new.status is distinct from old.status and auth.uid() is not null and not public.is_moderator() then
    raise exception 'Only moderators can change a note''s status' using errcode = '42501';
  end if;
  new.place_id := old.place_id;
  new.author_id := old.author_id;
  new.created_at := old.created_at;
  if new.note is distinct from old.note then new.updated_at := now(); end if;
  return new;
end $$;
revoke all on function public.guard_place_occasion_note() from public, anon, authenticated;

create trigger place_occasion_notes_guard
  before insert or update on public.place_occasion_notes
  for each row execute function public.guard_place_occasion_note();

insert into public.rate_limit_rules (action, max_count, window_seconds, label) values
  ('occasion_notes', 30, 86400, 'occasion notes')
on conflict (action) do nothing;
create trigger place_occasion_notes_rate_limit before insert on public.place_occasion_notes
  for each row execute function public.enforce_rate_limit('occasion_notes');
create trigger place_occasion_notes_block_suspended before insert or update or delete on public.place_occasion_notes
  for each row execute function public.block_suspended_writes();
