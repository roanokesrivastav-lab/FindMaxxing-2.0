-- ============================================================================
-- FindMaxxing — the admin dashboard's database side.
--
--   * Admins rank above moderators: is_moderator() is true for them too.
--   * Suspension: a suspended account cannot write anything. A trigger on every
--     user-writable table refuses writes from it (and the upload policy too),
--     whatever path they come in by. Its existing content stays up (decision
--     in the README): suspension stops new activity; removing content is the
--     moderators' per-item job.
--   * Admin writes (suspend, unsuspend, grant/revoke moderator, taxonomy edits)
--     go through definer-rights RPCs that check is_admin() and record every
--     change in moderation_actions, the same append-only audit trail.
--   * Read helpers for the dashboard, all keyset-paged and admin-only.
--   * Categories and interests gain a `retired` flag and become editable here.
-- ============================================================================

create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and (exists (select 1 from public.moderators m where m.user_id = auth.uid())
          or exists (select 1 from public.admins a where a.user_id = auth.uid()));
$$;

-- ----------------------------------------------------------------------------
-- Audit trail: taxonomy entries have text slugs, not uuids
-- ----------------------------------------------------------------------------
alter table public.moderation_actions alter column target_id drop not null;
alter table public.moderation_actions add column target_key text check (target_key is null or char_length(target_key) <= 80);
alter table public.moderation_actions drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in ('place', 'event', 'profile', 'category', 'interest'));
alter table public.moderation_actions add constraint moderation_actions_target_present
  check (target_id is not null or target_key is not null);
alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in ('dismiss', 'review', 'remove', 'restore', 'revoke_local', 'restore_local', 'reset_reputation',
                    'suspend', 'unsuspend', 'grant_moderator', 'revoke_moderator', 'taxonomy_upsert', 'taxonomy_retire', 'taxonomy_restore'));
create index moderation_actions_key_idx on public.moderation_actions (target_type, target_key, created_at desc, id desc) where target_key is not null;

-- ----------------------------------------------------------------------------
-- Suspension
-- ----------------------------------------------------------------------------
create table public.suspensions (
  user_id       uuid primary key references public.profiles (id) on delete cascade,
  reason        text not null check (char_length(reason) between 1 and 500),
  suspended_by  uuid references public.profiles (id) on delete set null,
  suspended_at  timestamptz not null default now()
);
alter table public.suspensions enable row level security;
create policy "users see their own suspension, admins see all" on public.suspensions for select
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.suspensions from anon, authenticated;

create or replace function public.is_suspended(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.suspensions s where s.user_id = p_user);
$$;
revoke all on function public.is_suspended(uuid) from public, anon, authenticated;
grant execute on function public.is_suspended(uuid) to authenticated;

-- Refuses any write by a suspended signed-in user. Sessions without a user
-- (seeds, the service role, cascades from account deletion) pass.
create or replace function public.block_suspended_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and exists (select 1 from public.suspensions where user_id = auth.uid()) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['places', 'place_tags', 'place_photos', 'place_ratings', 'saved_places', 'saved_lists',
                           'saved_list_items', 'events', 'event_tags', 'event_attendees', 'follows', 'reports',
                           'profiles', 'profile_interests']
  loop
    execute format(
      'create trigger %I before insert or update or delete on public.%I for each row execute function public.block_suspended_writes()',
      t || '_block_suspended', t);
  end loop;
end $$;

-- Uploads too.
create or replace function public.count_upload(p_bucket text, p_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if public.is_suspended(auth.uid()) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;
  if p_bucket = 'avatars' then
    perform public.check_rate_limit('avatars');
  elsif p_bucket = 'place-photos' and p_name !~ '\.(sm|md)\.[a-z]+$' then
    perform public.check_rate_limit('photos');
  end if;
  return true;
end $$;

-- ----------------------------------------------------------------------------
-- Admin operations (definer rights; each checks is_admin() and audits)
-- ----------------------------------------------------------------------------
create or replace function public.admin_audit(p_action text, p_type text, p_id uuid, p_key text, p_reason text, p_before text, p_after text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, target_key, reason, status_before, status_after)
  values (auth.uid(), p_action, p_type, p_id, p_key, p_reason, p_before, p_after);
$$;
revoke all on function public.admin_audit(text, text, uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.admin_require(p_reason text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  if v is null then raise exception 'moderation:reason_required' using errcode = 'P0001'; end if;
  if char_length(v) > 500 then raise exception 'moderation:reason_too_long' using errcode = 'P0001'; end if;
  return v;
end $$;
revoke all on function public.admin_require(text) from public, anon, authenticated;

create or replace function public.admin_set_suspended(p_user uuid, p_suspended boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.admin_require(p_reason);
  v_was boolean;
begin
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;
  if p_user = auth.uid() then raise exception 'admin:self' using errcode = 'P0001'; end if;
  v_was := exists (select 1 from public.suspensions where user_id = p_user);
  if v_was = p_suspended then raise exception 'moderation:no_change' using errcode = 'P0001'; end if;
  if p_suspended then
    insert into public.suspensions (user_id, reason, suspended_by) values (p_user, v_reason, auth.uid());
  else
    delete from public.suspensions where user_id = p_user;
  end if;
  perform public.admin_audit(case when p_suspended then 'suspend' else 'unsuspend' end, 'profile', p_user, null, v_reason,
    case when v_was then 'suspended' else 'active' end, case when p_suspended then 'suspended' else 'active' end);
end $$;

create or replace function public.admin_set_moderator(p_user uuid, p_moderator boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.admin_require(p_reason);
  v_was boolean;
begin
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;
  v_was := exists (select 1 from public.moderators where user_id = p_user);
  if v_was = p_moderator then raise exception 'moderation:no_change' using errcode = 'P0001'; end if;
  if p_moderator then
    insert into public.moderators (user_id, granted_by) values (p_user, auth.uid());
  else
    delete from public.moderators where user_id = p_user;
  end if;
  perform public.admin_audit(case when p_moderator then 'grant_moderator' else 'revoke_moderator' end, 'profile', p_user, null, v_reason,
    case when v_was then 'moderator' else 'member' end, case when p_moderator then 'moderator' else 'member' end);
end $$;

-- ----------------------------------------------------------------------------
-- Taxonomy
-- ----------------------------------------------------------------------------
alter table public.categories add column retired boolean not null default false;
alter table public.interests add column retired boolean not null default false;

-- Adds or edits a category or interest. Slugs are permanent once created
-- (places and profiles reference them); retiring hides one from new choices.
create or replace function public.admin_upsert_taxonomy(
  p_kind text, p_slug text, p_label text, p_emoji text, p_sort_order integer,
  p_color text default null, p_scope text default null, p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.admin_require(p_reason);
  v_before text;
begin
  if p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_slug) > 40 then raise exception 'admin:bad_slug' using errcode = 'P0001'; end if;
  if char_length(btrim(coalesce(p_label, ''))) not between 1 and 40 or char_length(btrim(coalesce(p_emoji, ''))) not between 1 and 8 then
    raise exception 'admin:bad_label' using errcode = 'P0001';
  end if;
  if p_kind = 'category' then
    if p_color !~ '^#[0-9a-fA-F]{6}$' or p_scope not in ('place', 'event', 'both') then raise exception 'admin:bad_label' using errcode = 'P0001'; end if;
    select label into v_before from public.categories where slug = p_slug;
    insert into public.categories (slug, label, emoji, color, scope, sort_order)
    values (p_slug, btrim(p_label), btrim(p_emoji), lower(p_color), p_scope, coalesce(p_sort_order, 0))
    on conflict (slug) do update set label = excluded.label, emoji = excluded.emoji, color = excluded.color, scope = excluded.scope, sort_order = excluded.sort_order;
  elsif p_kind = 'interest' then
    select label into v_before from public.interests where slug = p_slug;
    insert into public.interests (slug, label, emoji, sort_order)
    values (p_slug, btrim(p_label), btrim(p_emoji), coalesce(p_sort_order, 0))
    on conflict (slug) do update set label = excluded.label, emoji = excluded.emoji, sort_order = excluded.sort_order;
  else
    raise exception 'moderation:invalid_target' using errcode = 'P0001';
  end if;
  perform public.admin_audit('taxonomy_upsert', p_kind, null, p_slug, v_reason, v_before, btrim(p_label));
end $$;

create or replace function public.admin_set_taxonomy_retired(p_kind text, p_slug text, p_retired boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := public.admin_require(p_reason);
  v_was boolean;
begin
  if p_kind = 'category' then
    select retired into v_was from public.categories where slug = p_slug;
    if not found then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;
    update public.categories set retired = p_retired where slug = p_slug;
  elsif p_kind = 'interest' then
    select retired into v_was from public.interests where slug = p_slug;
    if not found then raise exception 'moderation:not_found' using errcode = 'P0002'; end if;
    update public.interests set retired = p_retired where slug = p_slug;
  else
    raise exception 'moderation:invalid_target' using errcode = 'P0001';
  end if;
  if v_was = p_retired then raise exception 'moderation:no_change' using errcode = 'P0001'; end if;
  perform public.admin_audit(case when p_retired then 'taxonomy_retire' else 'taxonomy_restore' end, p_kind, null, p_slug, v_reason,
    case when v_was then 'retired' else 'active' end, case when p_retired then 'retired' else 'active' end);
end $$;

-- ----------------------------------------------------------------------------
-- Dashboard reads (admins only; empty for anyone else). Keyset paged.
-- ----------------------------------------------------------------------------

-- People, newest first, optionally matching a username / display name / email-free text.
create or replace function public.admin_users(
  p_query text default null, p_after_created timestamptz default null, p_after_id uuid default null, p_limit integer default 31
) returns table (
  id uuid, username text, display_name text, home_city text, created_at timestamptz,
  reputation_level text, is_moderator boolean, is_admin boolean, suspended boolean,
  places integer, events integer, reports_against integer
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.home_city, p.created_at, p.reputation_level,
         exists (select 1 from public.moderators m where m.user_id = p.id),
         exists (select 1 from public.admins a where a.user_id = p.id),
         exists (select 1 from public.suspensions s where s.user_id = p.id),
         (select count(*)::integer from public.places pl where pl.creator_id = p.id),
         (select count(*)::integer from public.events e where e.creator_id = p.id),
         (select count(*)::integer from public.reports r where (r.target_type = 'profile' and r.target_id = p.id)
            or (r.target_type = 'place' and r.target_id in (select pl.id from public.places pl where pl.creator_id = p.id)))
  from public.profiles p
  where public.is_admin()
    and (public.discover_like_pattern(p_query) is null
         or p.username ilike public.discover_like_pattern(p_query)
         or p.display_name ilike public.discover_like_pattern(p_query))
    and (p_after_created is null or (p.created_at, p.id) < (p_after_created, p_after_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 31), 1), 101);
$$;

-- Places and events of any status, newest first, filterable.
create or replace function public.admin_content(
  p_kind text default 'place', p_status text default null, p_query text default null, p_creator uuid default null,
  p_after_created timestamptz default null, p_after_id uuid default null, p_limit integer default 31
) returns table (
  kind text, id uuid, label text, status text, visibility text, city text,
  creator_id uuid, creator_username text, created_at timestamptz, open_reports integer, actions integer
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select 'place'::text, pl.id, pl.name, pl.status, pl.visibility, pl.city, pl.creator_id, pr.username, pl.created_at,
           (select count(*)::integer from public.reports r where r.target_type = 'place' and r.target_id = pl.id and r.status = 'open'),
           (select count(*)::integer from public.moderation_actions ma where ma.target_type = 'place' and ma.target_id = pl.id)
    from public.places pl left join public.profiles pr on pr.id = pl.creator_id
    where p_kind = 'place'
      and (p_status is null or pl.status = p_status)
      and (p_creator is null or pl.creator_id = p_creator)
      and (public.discover_like_pattern(p_query) is null or pl.name ilike public.discover_like_pattern(p_query))
    union all
    select 'event'::text, e.id, e.title, e.status, null, null, e.creator_id, pr.username, e.created_at,
           (select count(*)::integer from public.reports r where r.target_type = 'event' and r.target_id = e.id and r.status = 'open'),
           (select count(*)::integer from public.moderation_actions ma where ma.target_type = 'event' and ma.target_id = e.id)
    from public.events e left join public.profiles pr on pr.id = e.creator_id
    where p_kind = 'event'
      and (p_status is null or e.status = p_status)
      and (p_creator is null or e.creator_id = p_creator)
      and (public.discover_like_pattern(p_query) is null or e.title ilike public.discover_like_pattern(p_query))
  ) c (kind, id, label, status, visibility, city, creator_id, creator_username, created_at, open_reports, actions)
  where public.is_admin()
    and (p_after_created is null or (c.created_at, c.id) < (p_after_created, p_after_id))
  order by c.created_at desc, c.id desc
  limit least(greatest(coalesce(p_limit, 31), 1), 101);
$$;

-- Everyone at their limit in the current window, per action: the visible
-- trace of rate-limit hits (a refused write rolls back, so the counter stops at
-- the limit).
create or replace function public.admin_rate_limit_hits()
returns table (action text, users_at_limit integer, max_count integer, window_seconds integer)
language sql
stable
security definer
set search_path = public
as $$
  select r.action,
         (select count(*)::integer from public.rate_limit_counters c
           where c.action = r.action and c.count >= r.max_count
             and c.window_start = to_timestamp(floor(extract(epoch from now()) / r.window_seconds) * r.window_seconds)),
         r.max_count, r.window_seconds
  from public.rate_limit_rules r
  where public.is_admin()
  order by r.action;
$$;

-- The audit trail for one target (uuid or taxonomy slug), newest first, paged.
create or replace function public.admin_history(
  p_target_type text, p_target_id uuid default null, p_target_key text default null,
  p_after_created timestamptz default null, p_after_id uuid default null, p_limit integer default 51
) returns table (id uuid, action text, reason text, status_before text, status_after text, created_at timestamptz, moderator_username text)
language sql
stable
security definer
set search_path = public
as $$
  select ma.id, ma.action, ma.reason, ma.status_before, ma.status_after, ma.created_at, pr.username
  from public.moderation_actions ma left join public.profiles pr on pr.id = ma.moderator_id
  where public.is_admin()
    and ma.target_type = p_target_type
    and (p_target_id is null or ma.target_id = p_target_id)
    and (p_target_key is null or ma.target_key = p_target_key)
    and (p_after_created is null or (ma.created_at, ma.id) < (p_after_created, p_after_id))
  order by ma.created_at desc, ma.id desc
  limit least(greatest(coalesce(p_limit, 51), 1), 201);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'admin_set_suspended(uuid, boolean, text)', 'admin_set_moderator(uuid, boolean, text)',
    'admin_upsert_taxonomy(text, text, text, text, integer, text, text, text)', 'admin_set_taxonomy_retired(text, text, boolean, text)',
    'admin_users(text, timestamptz, uuid, integer)', 'admin_content(text, text, text, uuid, timestamptz, uuid, integer)',
    'admin_rate_limit_hits()', 'admin_history(text, uuid, text, timestamptz, uuid, integer)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
