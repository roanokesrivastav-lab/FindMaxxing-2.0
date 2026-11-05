-- ============================================================================
-- FindMaxxing — tip provenance and freshness (roadmap 2.6).
--
-- A place's local tips become their own rows, each with an author, a kind and,
-- for temporary conditions, an expiry. "Still true?" confirmations are a separate
-- append-only table: the tip carries last_confirmed_at / last_confirmed_by, kept by
-- a trigger, never written by clients. An edit is not a confirmation (column grants
-- exclude the confirmation columns, and editing clears nothing and sets nothing).
-- Self-confirmation is refused. Corrections are attributed suggestions; they never
-- change the tip.
--
-- Visibility: a tip follows its place (can_view_place) and its own status. Hidden
-- and removed tips are invisible to everyone but their author and moderators, and
-- so are their confirmations and corrections: the evidence view cannot leak them.
-- Expiry is a display rule ("current" tips), applied by the repositories; an expired
-- tip is still evidence for its author and moderators, never for discovery.
--
-- places.local_tip stays (the place form still edits it). Existing tips are copied
-- once as practical tips by the place's creator, unconfirmed.
-- ============================================================================

create table public.place_tips (
  id                 uuid primary key default gen_random_uuid(),
  place_id           uuid not null references public.places (id) on delete cascade,
  author_id          uuid references public.profiles (id) on delete set null,
  body               text not null check (char_length(btrim(body)) between 1 and 280),
  kind               text not null check (kind in ('story', 'practical', 'temporary')),
  expires_at         timestamptz,
  status             text not null default 'published' check (status in ('published', 'hidden', 'removed')),
  last_confirmed_at  timestamptz,
  last_confirmed_by  uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Temporary conditions need an end; lasting ones must not have one.
  constraint place_tips_expiry check ((kind = 'temporary') = (expires_at is not null))
);
create index place_tips_place_idx on public.place_tips (place_id, status);

create table public.place_tip_confirmations (
  tip_id      uuid not null references public.place_tips (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (tip_id, user_id, created_at)
);
create index place_tip_confirmations_tip_idx on public.place_tip_confirmations (tip_id, created_at desc);

create table public.place_tip_corrections (
  id          uuid primary key default gen_random_uuid(),
  tip_id      uuid not null references public.place_tips (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  body        text not null check (char_length(btrim(body)) between 1 and 280),
  created_at  timestamptz not null default now()
);
create index place_tip_corrections_tip_idx on public.place_tip_corrections (tip_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Backfill: each existing local tip becomes a practical tip by the place's
-- creator, dated when the place was last updated, with no confirmation. Runs
-- before the triggers below, so it keeps those dates and counts against no limit.
-- The seed (scripts/generate-seed-sql.ts) applies the same statement after it
-- inserts places, and the demo store mirrors it (src/lib/data/demo/tips.ts).
-- ----------------------------------------------------------------------------
insert into public.place_tips (place_id, author_id, body, kind, created_at, updated_at)
select p.id, p.creator_id, left(btrim(p.local_tip), 280), 'practical', p.updated_at, p.updated_at
  from public.places p
 where p.local_tip is not null and btrim(p.local_tip) <> '';

-- ----------------------------------------------------------------------------
-- Visibility helper: a tip is visible when its place is, and it is published or
-- the caller is its author or a moderator. Definer rights so the confirmation and
-- correction policies can ask without depending on place_tips RLS.
-- ----------------------------------------------------------------------------
create or replace function public.can_view_place_tip(target_tip uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.place_tips t
     where t.id = target_tip
       and (
         public.is_moderator()
         or (public.can_view_place(t.place_id)
             and (t.status = 'published' or (auth.uid() is not null and t.author_id = auth.uid())))
       )
  );
$$;
revoke all on function public.can_view_place_tip(uuid) from public, anon, authenticated;
grant execute on function public.can_view_place_tip(uuid) to anon, authenticated;

alter table public.place_tips enable row level security;
alter table public.place_tip_confirmations enable row level security;
alter table public.place_tip_corrections enable row level security;

create policy "visible tips" on public.place_tips for select
  using (
    public.is_moderator()
    or (public.can_view_place(place_id)
        and (status = 'published' or (auth.uid() is not null and author_id = auth.uid())))
  );
create policy "users add tips to places they can see" on public.place_tips for insert
  with check (author_id = auth.uid() and status = 'published' and public.can_view_place(place_id)
              and last_confirmed_at is null and last_confirmed_by is null);
create policy "authors edit own tips" on public.place_tips for update
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy "moderators change tip status" on public.place_tips for update
  using (public.is_moderator()) with check (public.is_moderator());
create policy "authors delete own tips" on public.place_tips for delete
  using (author_id = auth.uid());

-- Clients edit only the text, kind and expiry. Status is a moderator column
-- (checked in the trigger below); the confirmation columns belong to the trigger.
revoke update on public.place_tips from anon, authenticated;
grant update (body, kind, expires_at, status) on public.place_tips to authenticated;

create policy "confirmations of visible tips" on public.place_tip_confirmations for select
  using (public.can_view_place_tip(tip_id));
create policy "users confirm as self" on public.place_tip_confirmations for insert
  with check (user_id = auth.uid() and public.can_view_place_tip(tip_id));
-- Append-only: the confirmation history is the evidence.
revoke update, delete on public.place_tip_confirmations from anon, authenticated;

create policy "corrections of visible tips" on public.place_tip_corrections for select
  using (public.can_view_place_tip(tip_id));
create policy "users suggest corrections as self" on public.place_tip_corrections for insert
  with check (author_id = auth.uid() and public.can_view_place_tip(tip_id));
create policy "authors withdraw own corrections" on public.place_tip_corrections for delete
  using (author_id = auth.uid());
revoke update on public.place_tip_corrections from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- Edits: bump updated_at; status changes are for moderators only (an author may not
-- un-hide a moderated tip); confirmation columns never change here.
create or replace function public.guard_place_tip_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null and not public.is_moderator() then
    raise exception 'Only moderators can change a tip''s status' using errcode = '42501';
  end if;
  if current_setting('findmaxxing.tip_confirming', true) is distinct from 'on' then
    new.last_confirmed_at := old.last_confirmed_at;
    new.last_confirmed_by := old.last_confirmed_by;
  end if;
  new.place_id := old.place_id;
  new.author_id := old.author_id;
  new.created_at := old.created_at;
  if new.body is distinct from old.body or new.kind is distinct from old.kind or new.expires_at is distinct from old.expires_at then
    new.updated_at := now();
  end if;
  return new;
end $$;
revoke all on function public.guard_place_tip_update() from public, anon, authenticated;

create trigger place_tips_guard_update
  before update on public.place_tips
  for each row execute function public.guard_place_tip_update();

-- A confirmation by anyone but the author moves the tip's "last confirmed" to it.
create or replace function public.record_place_tip_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tip_author uuid;
begin
  select author_id into tip_author from public.place_tips where id = new.tip_id;
  if tip_author is not null and tip_author = new.user_id then
    raise exception 'You can''t confirm your own tip' using errcode = '42501';
  end if;
  perform set_config('findmaxxing.tip_confirming', 'on', true);
  update public.place_tips
     set last_confirmed_at = new.created_at, last_confirmed_by = new.user_id
   where id = new.tip_id
     and (last_confirmed_at is null or last_confirmed_at <= new.created_at);
  perform set_config('findmaxxing.tip_confirming', 'off', true);
  return new;
end $$;
revoke all on function public.record_place_tip_confirmation() from public, anon, authenticated;

-- Server time only: a client cannot backdate or postdate a confirmation.
create or replace function public.stamp_place_tip_confirmation()
returns trigger
language plpgsql
as $$
begin
  new.created_at := now();
  return new;
end $$;

create trigger place_tip_confirmations_stamp
  before insert on public.place_tip_confirmations
  for each row execute function public.stamp_place_tip_confirmation();
create trigger place_tip_confirmations_record
  after insert on public.place_tip_confirmations
  for each row execute function public.record_place_tip_confirmation();

create or replace function public.stamp_place_tip_insert()
returns trigger
language plpgsql
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;
create trigger place_tips_stamp
  before insert on public.place_tips
  for each row execute function public.stamp_place_tip_insert();

-- Rate limits (mirrored in src/lib/rateLimits.ts).
insert into public.rate_limit_rules (action, max_count, window_seconds, label) values
  ('tips', 20, 86400, 'tips'),
  ('tip_confirmations', 60, 86400, 'tip confirmations')
on conflict (action) do nothing;

create trigger place_tips_rate_limit before insert on public.place_tips
  for each row execute function public.enforce_rate_limit('tips');
create trigger place_tip_corrections_rate_limit before insert on public.place_tip_corrections
  for each row execute function public.enforce_rate_limit('tips');
create trigger place_tip_confirmations_rate_limit before insert on public.place_tip_confirmations
  for each row execute function public.enforce_rate_limit('tip_confirmations');

-- Suspended accounts write nothing (0017).
create trigger place_tips_block_suspended before insert or update or delete on public.place_tips
  for each row execute function public.block_suspended_writes();
create trigger place_tip_confirmations_block_suspended before insert or update or delete on public.place_tip_confirmations
  for each row execute function public.block_suspended_writes();
create trigger place_tip_corrections_block_suspended before insert or update or delete on public.place_tip_corrections
  for each row execute function public.block_suspended_writes();
