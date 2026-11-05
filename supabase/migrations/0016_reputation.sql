-- ============================================================================
-- FindMaxxing — contributor reputation and two more visibility tiers.
--
-- Reputation is computed in SQL from signals that are hard to fake alone:
--   + 2 per save others gave to your places
--   + 2 per rating others gave to your places
--   + 1 per person (other than you) who joined one of your events
--   + 3 per place still published two weeks after you added it
--   − 10 per place or event of yours that moderators removed
--   + 1 per report you filed that moderators acted on (reviewed),
--   − 1 per report you filed that they dismissed
-- times min(1, account age / 30 days). A moderator reset counts only signals
-- after the reset. The score is never shown; people see a level:
--   new          score under 10, or account under 7 days old
--   contributor  score 10 or more
--   trusted      score 40 or more, account 30+ days old, local status not revoked
--
-- The level is cached (reputation_cache, profiles.reputation_level,
-- places.creator_reputation) and refreshed hourly by cron and immediately for
-- the people a moderator reset, so row policies read one stored value instead
-- of recomputing it for every row.
--
-- New place visibility tiers, on top of public / locals / private:
--   trusted    locals of the city whose level is "trusted"
--   followers  people the creator follows back (mutual follows)
-- Events keep inheriting their place's visibility through can_view_place.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Cache and resets
-- ----------------------------------------------------------------------------
create table public.reputation_cache (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  score        numeric(10, 2) not null,
  level        text not null check (level in ('new', 'contributor', 'trusted')),
  computed_at  timestamptz not null default now()
);
alter table public.reputation_cache enable row level security;
-- The raw score is for admins only; everyone else sees the level on profiles.
create policy "admins read reputation scores" on public.reputation_cache for select using (public.is_admin());
revoke insert, update, delete on public.reputation_cache from anon, authenticated;

create table public.reputation_resets (
  user_id   uuid primary key references public.profiles (id) on delete cascade,
  reset_at  timestamptz not null default now(),
  reset_by  uuid references public.profiles (id) on delete set null
);
alter table public.reputation_resets enable row level security;
create policy "moderators read resets" on public.reputation_resets for select using (public.is_moderator());
revoke insert, update, delete on public.reputation_resets from anon, authenticated;

-- Public, read-only levels (profiles grant update on specific columns only).
alter table public.profiles add column reputation_level text not null default 'new'
  check (reputation_level in ('new', 'contributor', 'trusted'));
-- 0 new, 1 contributor, 2 trusted: one ranking input for discovery.
alter table public.places add column creator_reputation smallint not null default 0 check (creator_reputation between 0 and 2);

-- Clients cannot set creator_reputation on insert either.
create or replace function public.reset_place_aggregates()
returns trigger
language plpgsql
as $$
begin
  new.save_count := 0;
  new.rating_avg := 0;
  new.rating_count := 0;
  new.creator_reputation := coalesce(
    (select case reputation_level when 'trusted' then 2 when 'contributor' then 1 else 0 end
       from public.profiles where id = new.creator_id), 0);
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- Computing it
-- ----------------------------------------------------------------------------
create or replace function public.compute_reputation(p_user uuid)
returns table (score numeric, level text)
language sql
stable
security definer
set search_path = public
as $$
  with since as (
    select coalesce((select reset_at from public.reputation_resets where user_id = p_user), '-infinity'::timestamptz) as t
  ),
  me as (
    select p.created_at,
           extract(epoch from (now() - p.created_at)) / 86400.0 as age_days,
           exists (select 1 from public.local_revocations lr where lr.user_id = p_user) as revoked
    from public.profiles p where p.id = p_user
  ),
  raw as (
    select
        2 * (select count(*) from public.saved_places s join public.places pl on pl.id = s.place_id, since
             where pl.creator_id = p_user and s.user_id <> p_user and s.created_at >= since.t)
      + 2 * (select count(*) from public.place_ratings r join public.places pl on pl.id = r.place_id, since
             where pl.creator_id = p_user and r.user_id <> p_user and r.created_at >= since.t)
      + 1 * (select count(*) from public.event_attendees a join public.events e on e.id = a.event_id, since
             where e.creator_id = p_user and a.user_id <> p_user and e.status <> 'removed' and a.created_at >= since.t)
      + 3 * (select count(*) from public.places pl, since
             where pl.creator_id = p_user and pl.status = 'published' and pl.created_at <= now() - interval '14 days' and pl.created_at >= since.t)
      - 10 * (select count(*) from public.places pl, since where pl.creator_id = p_user and pl.status = 'removed' and pl.updated_at >= since.t)
      - 10 * (select count(*) from public.events e, since where e.creator_id = p_user and e.status = 'removed' and e.updated_at >= since.t)
      + 1 * (select count(*) from public.reports rp, since where rp.reporter_id = p_user and rp.status = 'reviewed' and coalesce(rp.resolved_at, rp.created_at) >= since.t)
      - 1 * (select count(*) from public.reports rp, since where rp.reporter_id = p_user and rp.status = 'dismissed' and coalesce(rp.resolved_at, rp.created_at) >= since.t)
      as points
  ),
  scored as (
    select round((raw.points * least(1.0, greatest(me.age_days, 0) / 30.0))::numeric, 2) as score, me.age_days, me.revoked
    from raw, me
  )
  select s.score,
         case
           when s.score >= 40 and s.age_days >= 30 and not s.revoked then 'trusted'
           when s.score >= 10 and s.age_days >= 7 then 'contributor'
           else 'new'
         end
  from scored s;
$$;
revoke all on function public.compute_reputation(uuid) from public, anon, authenticated;

create or replace function public.refresh_reputation(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select * into r from public.compute_reputation(p_user);
  if not found then return; end if;
  insert into public.reputation_cache (user_id, score, level, computed_at)
  values (p_user, r.score, r.level, now())
  on conflict (user_id) do update set score = excluded.score, level = excluded.level, computed_at = excluded.computed_at;
  update public.profiles set reputation_level = r.level where id = p_user and reputation_level is distinct from r.level;
  update public.places
     set creator_reputation = case r.level when 'trusted' then 2 when 'contributor' then 1 else 0 end
   where creator_id = p_user
     and creator_reputation is distinct from case r.level when 'trusted' then 2 when 'contributor' then 1 else 0 end;
end $$;
revoke all on function public.refresh_reputation(uuid) from public, anon, authenticated;

-- Hourly cron (service role): every profile. Returns how many were refreshed.
create or replace function public.refresh_all_reputation()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
  u uuid;
begin
  for u in select id from public.profiles loop
    perform public.refresh_reputation(u);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.refresh_all_reputation() from public, anon, authenticated;
grant execute on function public.refresh_all_reputation() to service_role;

-- A moderator wipes someone's reputation back to zero (signals before now stop
-- counting), with a reason and an audit row, and the level updates at once.
alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in ('dismiss', 'review', 'remove', 'restore', 'revoke_local', 'restore_local', 'reset_reputation'));

create or replace function public.reset_reputation(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before text;
begin
  if not public.is_moderator() then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'moderation:reason_required' using errcode = 'P0001'; end if;
  if char_length(v_reason) > 500 then raise exception 'moderation:reason_too_long' using errcode = 'P0001'; end if;
  select reputation_level into v_before from public.profiles where id = p_user;
  if not found then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;
  insert into public.reputation_resets (user_id, reset_at, reset_by) values (p_user, now(), auth.uid())
  on conflict (user_id) do update set reset_at = excluded.reset_at, reset_by = excluded.reset_by;
  perform public.refresh_reputation(p_user);
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, reason, status_before, status_after)
  values (auth.uid(), 'reset_reputation', 'profile', p_user, v_reason, v_before,
          (select reputation_level from public.profiles where id = p_user));
end $$;
revoke all on function public.reset_reputation(uuid, text) from public, anon, authenticated;
grant execute on function public.reset_reputation(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The two new tiers
-- ----------------------------------------------------------------------------
create or replace function public.is_trusted_local(target_city text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_local(target_city)
     and exists (select 1 from public.profiles p where p.id = auth.uid() and p.reputation_level = 'trusted');
$$;

-- The viewer follows the creator and the creator follows the viewer back.
create or replace function public.is_mutual_follow(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.following_id = target_user)
     and exists (select 1 from public.follows f where f.follower_id = target_user and f.following_id = auth.uid());
$$;
revoke all on function public.is_trusted_local(text) from public;
revoke all on function public.is_mutual_follow(uuid) from public;
grant execute on function public.is_trusted_local(text) to anon, authenticated;
grant execute on function public.is_mutual_follow(uuid) to anon, authenticated;

alter table public.places drop constraint places_visibility_check;
alter table public.places add constraint places_visibility_check
  check (visibility in ('public', 'locals', 'trusted', 'followers', 'private'));

-- One rule, written three times (the places policy, can_view_place for child
-- tables, and the text-search helper); tests hold all three to the same answer.
drop policy if exists "visible places" on public.places;
create policy "visible places" on public.places for select
  using (
    (creator_id = auth.uid() and status <> 'removed')
    or (
      status = 'published'
      and (
        visibility = 'public'
        or (visibility = 'locals' and public.is_local(city))
        or (visibility = 'trusted' and public.is_trusted_local(city))
        or (visibility = 'followers' and public.is_mutual_follow(creator_id))
      )
    )
  );

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
        (p.creator_id = auth.uid() and p.status <> 'removed')
        or (
          p.status = 'published'
          and (
            p.visibility = 'public'
            or (p.visibility = 'locals' and public.is_local(p.city))
            or (p.visibility = 'trusted' and public.is_trusted_local(p.city))
            or (p.visibility = 'followers' and public.is_mutual_follow(p.creator_id))
          )
        )
      )
  );
$$;

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
     or (
       p.status = 'published'
       and (
         p.visibility = 'public'
         or (p.visibility = 'locals' and public.is_local(p.city))
         or (p.visibility = 'trusted' and public.is_trusted_local(p.city))
         or (p.visibility = 'followers' and public.is_mutual_follow(p.creator_id))
       )
     );
$$;

-- Owners may choose any tier (but never a moderation status).
drop policy if exists "users update own places" on public.places;
create policy "users update own places" on public.places for update
  using (creator_id = auth.uid() and status in ('published', 'hidden'))
  with check (
    creator_id = auth.uid()
    and status in ('published', 'hidden')
    and visibility in ('public', 'locals', 'trusted', 'followers', 'private')
  );

drop policy if exists "users create places" on public.places;
create policy "users create places" on public.places for insert
  with check (
    creator_id = auth.uid()
    and status = 'published'
    and visibility in ('public', 'locals', 'trusted', 'followers')
  );

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
  if p_visibility not in ('public', 'locals', 'trusted', 'followers') then
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

-- Ranking: reputation breaks ties after ratings and saves, never alone.
drop index if exists public.places_discover_notable_idx;
create index places_discover_notable_idx
  on public.places (rating_count desc, save_count desc, creator_reputation desc, id) where status = 'published';

-- A reputation refresh is not a content edit: keep updated_at for real edits.
create or replace function public.set_place_updated_at()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - array['save_count', 'rating_avg', 'rating_count', 'creator_reputation', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['save_count', 'rating_avg', 'rating_count', 'creator_reputation', 'updated_at']) then
    new.updated_at = now();
  end if;
  return new;
end $$;
