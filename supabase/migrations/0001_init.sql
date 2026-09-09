-- ============================================================================
-- FindMaxxing — initial schema
--
-- Runs on Supabase (Postgres 15+). Relies on:
--   * auth.users / auth.uid()      (Supabase Auth)
--   * storage.buckets / objects    (Supabase Storage)
--   * pgcrypto / gen_random_uuid() (enabled by default on Supabase)
--
-- Design notes
--   * Every table has RLS enabled. Anonymous users can read public content;
--     only owners can write their own rows. Aggregates (rating_avg, etc.)
--     are maintained by SECURITY DEFINER triggers, never by clients.
--   * `visibility` and `status` exist so trust tiers / moderation can be
--     layered on later without a migration. The MVP only uses public+published.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Vocabulary
-- ----------------------------------------------------------------------------
create table public.categories (
  slug        text primary key,
  label       text not null,
  emoji       text not null,
  color       text not null,
  scope       text not null check (scope in ('place', 'event', 'both')),
  sort_order  int  not null default 0
);

create table public.interests (
  slug        text primary key,
  label       text not null,
  emoji       text not null,
  sort_order  int  not null default 0
);

-- ----------------------------------------------------------------------------
-- Profiles
-- ----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text not null unique
                check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name  text not null check (char_length(display_name) between 1 and 50),
  avatar_url    text,
  bio           text check (bio is null or char_length(bio) <= 240),
  home_city     text check (home_city is null or char_length(home_city) <= 80),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.profile_interests (
  profile_id     uuid not null references public.profiles (id) on delete cascade,
  interest_slug  text not null references public.interests (slug) on delete cascade,
  primary key (profile_id, interest_slug)
);

-- ----------------------------------------------------------------------------
-- Places
-- ----------------------------------------------------------------------------
create table public.places (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 2 and 80),
  description    text not null check (char_length(description) between 10 and 1000),
  local_tip      text check (local_tip is null or char_length(local_tip) <= 280),
  category_slug  text not null references public.categories (slug),
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  address        text check (address is null or char_length(address) <= 160),
  neighborhood   text check (neighborhood is null or char_length(neighborhood) <= 80),
  city           text not null check (char_length(city) between 2 and 80),
  creator_id     uuid references public.profiles (id) on delete set null,
  rating_avg     numeric(3, 2) not null default 0 check (rating_avg between 0 and 5),
  rating_count   int not null default 0 check (rating_count >= 0),
  status         text not null default 'published'
                 check (status in ('published', 'pending', 'hidden', 'removed')),
  visibility     text not null default 'public'
                 check (visibility in ('public', 'locals', 'private')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index places_lat_lng_idx      on public.places (lat, lng);
create index places_category_idx     on public.places (category_slug);
create index places_creator_idx      on public.places (creator_id);
create index places_visible_idx      on public.places (status, visibility, created_at desc);

create table public.place_tags (
  place_id       uuid not null references public.places (id) on delete cascade,
  interest_slug  text not null references public.interests (slug) on delete cascade,
  primary key (place_id, interest_slug)
);
create index place_tags_interest_idx on public.place_tags (interest_slug);

create table public.place_photos (
  id           uuid primary key default gen_random_uuid(),
  place_id     uuid not null references public.places (id) on delete cascade,
  url          text not null check (char_length(url) <= 2048),
  uploader_id  uuid references public.profiles (id) on delete set null,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index place_photos_place_idx on public.place_photos (place_id, sort_order);

create table public.place_ratings (
  id          uuid primary key default gen_random_uuid(),
  place_id    uuid not null references public.places (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  score       smallint not null check (score between 1 and 5),
  note        text check (note is null or char_length(note) <= 280),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (place_id, user_id)
);
create index place_ratings_user_idx on public.place_ratings (user_id);

create table public.saved_places (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  place_id    uuid not null references public.places (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, place_id)
);
create index saved_places_place_idx on public.saved_places (place_id);

-- ----------------------------------------------------------------------------
-- Events
-- ----------------------------------------------------------------------------
create table public.events (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (char_length(title) between 3 and 90),
  description    text not null check (char_length(description) between 10 and 1200),
  place_id       uuid references public.places (id) on delete set null,
  location_name  text not null check (char_length(location_name) between 2 and 120),
  address        text check (address is null or char_length(address) <= 160),
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  starts_at      timestamptz not null,
  ends_at        timestamptz check (ends_at is null or ends_at > starts_at),
  creator_id     uuid references public.profiles (id) on delete set null,
  category_slug  text not null references public.categories (slug),
  capacity       int check (capacity is null or capacity between 2 and 5000),
  status         text not null default 'published'
                 check (status in ('published', 'cancelled', 'hidden', 'removed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index events_starts_idx    on public.events (status, starts_at);
create index events_place_idx     on public.events (place_id);
create index events_creator_idx   on public.events (creator_id);
create index events_category_idx  on public.events (category_slug);
create index events_lat_lng_idx   on public.events (lat, lng);

create table public.event_tags (
  event_id       uuid not null references public.events (id) on delete cascade,
  interest_slug  text not null references public.interests (slug) on delete cascade,
  primary key (event_id, interest_slug)
);

create table public.event_attendees (
  event_id    uuid not null references public.events (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index event_attendees_user_idx on public.event_attendees (user_id);

-- ----------------------------------------------------------------------------
-- Social + moderation
-- ----------------------------------------------------------------------------
create table public.follows (
  follower_id   uuid not null references public.profiles (id) on delete cascade,
  following_id  uuid not null references public.profiles (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index follows_following_idx on public.follows (following_id);

create table public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references public.profiles (id) on delete cascade,
  target_type  text not null check (target_type in ('place', 'event', 'profile')),
  target_id    uuid not null,
  reason       text not null
               check (reason in ('inaccurate', 'closed', 'inappropriate', 'spam', 'duplicate', 'other')),
  details      text check (details is null or char_length(details) <= 500),
  status       text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at   timestamptz not null default now()
);
create index reports_target_idx on public.reports (target_type, target_id);
-- One open report per reporter per target.
create unique index reports_open_unique_idx
  on public.reports (reporter_id, target_type, target_id) where status = 'open';

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_updated_at      before update on public.profiles      for each row execute function public.set_updated_at();
create trigger places_updated_at        before update on public.places        for each row execute function public.set_updated_at();
create trigger place_ratings_updated_at before update on public.place_ratings for each row execute function public.set_updated_at();
create trigger events_updated_at        before update on public.events        for each row execute function public.set_updated_at();

-- Create a profile row for every new auth user, using sign-up metadata.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base_username text;
  candidate     text;
  n             int := 0;
begin
  base_username := lower(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', ''), '[^a-z0-9_]', '', 'gi'));
  if char_length(base_username) < 3 then
    base_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  base_username := substr(base_username, 1, 24);
  candidate := base_username;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := substr(base_username, 1, 24 - char_length(n::text)) || n::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), candidate)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep places.rating_avg / rating_count in sync with place_ratings.
create or replace function public.refresh_place_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.place_id, old.place_id);
begin
  update public.places p
     set rating_avg   = coalesce((select round(avg(score)::numeric, 2) from public.place_ratings r where r.place_id = target), 0),
         rating_count = (select count(*) from public.place_ratings r where r.place_id = target)
   where p.id = target;
  return null;
end $$;

create trigger place_ratings_refresh
  after insert or update or delete on public.place_ratings
  for each row execute function public.refresh_place_rating();

-- Enforce join rules at the database: event must be open, upcoming, and not full.
create or replace function public.check_event_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  current_count int;
begin
  select * into ev from public.events where id = new.event_id for update;
  if not found or ev.status <> 'published' then
    raise exception 'Event is not open for joining' using errcode = 'P0001';
  end if;
  if coalesce(ev.ends_at, ev.starts_at) < now() then
    raise exception 'This event has already ended' using errcode = 'P0001';
  end if;
  if ev.capacity is not null then
    select count(*) into current_count from public.event_attendees where event_id = new.event_id;
    if current_count >= ev.capacity then
      raise exception 'This event is full' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create trigger event_attendees_check_join
  before insert on public.event_attendees
  for each row execute function public.check_event_join();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.categories        enable row level security;
alter table public.interests         enable row level security;
alter table public.profiles          enable row level security;
alter table public.profile_interests enable row level security;
alter table public.places            enable row level security;
alter table public.place_tags        enable row level security;
alter table public.place_photos      enable row level security;
alter table public.place_ratings     enable row level security;
alter table public.saved_places      enable row level security;
alter table public.events            enable row level security;
alter table public.event_tags        enable row level security;
alter table public.event_attendees   enable row level security;
alter table public.follows           enable row level security;
alter table public.reports           enable row level security;

-- Vocabulary: read-only for everyone (writes require service role).
create policy "categories are public" on public.categories for select using (true);
create policy "interests are public"  on public.interests  for select using (true);

-- Profiles: public read, self write.
create policy "profiles are public"      on public.profiles for select using (true);
create policy "users insert own profile" on public.profiles for insert with check (id = auth.uid());
create policy "users update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy "profile interests are public" on public.profile_interests for select using (true);
create policy "users manage own interests"   on public.profile_interests for insert with check (profile_id = auth.uid());
create policy "users remove own interests"   on public.profile_interests for delete using (profile_id = auth.uid());

-- Places: anyone sees public+published; creators see their own regardless.
create policy "visible places" on public.places for select
  using ((status = 'published' and visibility = 'public') or creator_id = auth.uid());
create policy "users create places" on public.places for insert
  with check (creator_id = auth.uid() and status = 'published' and visibility = 'public');
create policy "users update own places" on public.places for update
  using (creator_id = auth.uid()) with check (creator_id = auth.uid());
create policy "users delete own places" on public.places for delete
  using (creator_id = auth.uid());

-- Clients may never touch aggregates, ownership or moderation columns directly.
revoke update on public.places from authenticated;
grant  update (name, description, local_tip, category_slug, lat, lng, address, neighborhood, city)
  on public.places to authenticated;

create policy "place tags are public" on public.place_tags for select using (true);
create policy "owners add place tags" on public.place_tags for insert
  with check (exists (select 1 from public.places p where p.id = place_id and p.creator_id = auth.uid()));
create policy "owners remove place tags" on public.place_tags for delete
  using (exists (select 1 from public.places p where p.id = place_id and p.creator_id = auth.uid()));

create policy "place photos are public" on public.place_photos for select using (true);
create policy "owners add place photos" on public.place_photos for insert
  with check (uploader_id = auth.uid()
              and exists (select 1 from public.places p where p.id = place_id and p.creator_id = auth.uid()));
create policy "uploaders remove own photos" on public.place_photos for delete
  using (uploader_id = auth.uid());

create policy "ratings are public"     on public.place_ratings for select using (true);
create policy "users rate as self"     on public.place_ratings for insert with check (user_id = auth.uid());
create policy "users update own rating" on public.place_ratings for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users delete own rating" on public.place_ratings for delete using (user_id = auth.uid());

create policy "users see own saves"   on public.saved_places for select using (user_id = auth.uid());
create policy "users save as self"    on public.saved_places for insert with check (user_id = auth.uid());
create policy "users unsave own"      on public.saved_places for delete using (user_id = auth.uid());

-- Events
create policy "visible events" on public.events for select
  using (status = 'published' or creator_id = auth.uid());
create policy "users create events" on public.events for insert
  with check (creator_id = auth.uid() and status = 'published');
create policy "users update own events" on public.events for update
  using (creator_id = auth.uid())
  with check (creator_id = auth.uid() and status in ('published', 'cancelled'));
create policy "users delete own events" on public.events for delete
  using (creator_id = auth.uid());

revoke update on public.events from authenticated;
grant  update (title, description, place_id, location_name, address, lat, lng, starts_at, ends_at, category_slug, capacity, status)
  on public.events to authenticated;

create policy "event tags are public" on public.event_tags for select using (true);
create policy "owners add event tags" on public.event_tags for insert
  with check (exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()));
create policy "owners remove event tags" on public.event_tags for delete
  using (exists (select 1 from public.events e where e.id = event_id and e.creator_id = auth.uid()));

create policy "attendees are public"  on public.event_attendees for select using (true);
create policy "users join as self"    on public.event_attendees for insert with check (user_id = auth.uid());
create policy "users leave as self"   on public.event_attendees for delete using (user_id = auth.uid());

-- Social
create policy "follows are public"    on public.follows for select using (true);
create policy "users follow as self"  on public.follows for insert with check (follower_id = auth.uid());
create policy "users unfollow as self" on public.follows for delete using (follower_id = auth.uid());

-- Reports: write-only for users; moderators read via service role.
create policy "users file reports"    on public.reports for insert with check (reporter_id = auth.uid());
create policy "users see own reports" on public.reports for select using (reporter_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Storage buckets (public read; owners write within their own folder)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('place-photos', 'place-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('avatars',      'avatars',      true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "public read images" on storage.objects for select
  using (bucket_id in ('place-photos', 'avatars'));
create policy "users upload to own folder" on storage.objects for insert
  with check (bucket_id in ('place-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete own uploads" on storage.objects for delete
  using (bucket_id in ('place-photos', 'avatars') and (storage.foldername(name))[1] = auth.uid()::text);
