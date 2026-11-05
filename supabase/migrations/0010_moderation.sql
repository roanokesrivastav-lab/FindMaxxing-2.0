-- ============================================================================
-- FindMaxxing — moderation, and a firmer "local" tier.
--
--   * moderators: a role nobody can grant themselves. Rows are written only
--     through SQL or the service role; is_moderator() reads them.
--   * reports get an accountable resolution path: a moderator-only queue, one
--     RPC that resolves every open report on a target in one transaction, and
--     an append-only moderation_actions audit trail.
--   * removed content disappears for everyone, its owner included. The owner
--     sees a "removed by moderators" notice with the reason instead.
--   * the locals-only tier stops trusting a home city typed a minute ago: new
--     accounts wait 7 days, home city changes are limited to one per 30 days,
--     and moderators can revoke local status.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Moderators
-- ----------------------------------------------------------------------------
create table public.moderators (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  -- Null when granted from SQL rather than by another account.
  granted_by  uuid references public.profiles (id) on delete set null
);

alter table public.moderators enable row level security;

-- Definer rights: callers cannot read the moderators table under their own
-- RLS, and policies on other tables call this.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and exists (select 1 from public.moderators m where m.user_id = auth.uid());
$$;

revoke all on function public.is_moderator() from public, anon, authenticated;
grant execute on function public.is_moderator() to anon, authenticated;

create policy "moderators see the moderator list" on public.moderators for select
  using (user_id = auth.uid() or public.is_moderator());

-- No client writes at all: granting the role is SQL or service-role work.
revoke insert, update, delete on public.moderators from anon, authenticated;

-- ----------------------------------------------------------------------------
-- The local tier
--
-- Profiles keep table-level update for their owner, but only on the columns a
-- user may edit. Before this, an owner could rewrite created_at and look like
-- an old account.
-- ----------------------------------------------------------------------------
alter table public.profiles add column home_city_changed_at timestamptz;

revoke update on public.profiles from anon, authenticated;
grant update (username, display_name, avatar_url, bio, home_city) on public.profiles to authenticated;

-- Home city may change once per 30 days. Case and spacing fixes are free, and
-- so is setting it for the first time. Signed-in callers only: seeds, the
-- service role and SQL maintenance (no auth.uid()) are not limited.
create or replace function public.guard_profile_trust_columns()
returns trigger
language plpgsql
as $$
declare
  next_allowed timestamptz;
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.home_city_changed_at := case when new.home_city is null then null else now() end;
    return new;
  end if;
  new.created_at := old.created_at;
  if lower(btrim(coalesce(new.home_city, ''))) is distinct from lower(btrim(coalesce(old.home_city, ''))) then
    next_allowed := old.home_city_changed_at + interval '30 days';
    if old.home_city is not null and next_allowed > now() then
      raise exception 'home_city_cooldown:%', to_char(next_allowed at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        using errcode = 'P0001';
    end if;
    new.home_city_changed_at := now();
  else
    new.home_city_changed_at := old.home_city_changed_at;
  end if;
  return new;
end $$;

create trigger profiles_guard_trust_columns
  before insert or update on public.profiles
  for each row execute function public.guard_profile_trust_columns();

create table public.local_revocations (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  revoked_by  uuid references public.profiles (id) on delete set null,
  reason      text not null check (char_length(reason) between 1 and 500),
  revoked_at  timestamptz not null default now()
);

alter table public.local_revocations enable row level security;
create policy "users see their own revocation, moderators see all" on public.local_revocations for select
  using (user_id = auth.uid() or public.is_moderator());
revoke insert, update, delete on public.local_revocations from anon, authenticated;

-- A viewer is a local of a city when all of these hold:
--   * their account is at least 7 days old,
--   * a moderator has not revoked their local status,
--   * their home city matches, or they have contributed a published place there.
-- Still definer rights for the reason given in 0003: it runs inside the places
-- policy and must not recurse into it.
create or replace function public.is_local(target_city text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    target_city is not null
    and auth.uid() is not null
    and exists (
      select 1 from public.profiles me
      where me.id = auth.uid()
        and me.created_at <= now() - interval '7 days'
    )
    and not exists (select 1 from public.local_revocations lr where lr.user_id = auth.uid())
    and (
      exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.home_city is not null
          and lower(btrim(p.home_city)) = lower(btrim(target_city))
      )
      or exists (
        select 1
        from public.places pl
        where pl.creator_id = auth.uid()
          and pl.status = 'published'
          and lower(btrim(pl.city)) = lower(btrim(target_city))
      )
    );
$$;

-- 0004 revoked this from PUBLIC, but Supabase also grants new functions to anon
-- directly; say it explicitly.
revoke all on function public.is_local(text) from public, anon;
grant execute on function public.is_local(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Removed content is gone for everyone, its owner included
-- ----------------------------------------------------------------------------
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
          )
        )
      )
  );
$$;

create or replace function public.can_view_event(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        (e.creator_id = auth.uid() and e.status <> 'removed')
        or (
          e.status = 'published'
          and (e.place_id is null or public.can_view_place(e.place_id))
        )
        or (
          e.status = 'cancelled'
          and exists (
            select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = auth.uid()
          )
        )
      )
  );
$$;

-- Owners can no longer edit or republish what moderators removed (or anything
-- pending review). Their WITH CHECK already refused setting those statuses;
-- USING now refuses leaving them.
drop policy if exists "users update own places" on public.places;
create policy "users update own places" on public.places for update
  using (creator_id = auth.uid() and status in ('published', 'hidden'))
  with check (
    creator_id = auth.uid()
    and status in ('published', 'hidden')
    and visibility in ('public', 'locals', 'private')
  );

-- Same rule inside the definer-rights edit function, which bypasses RLS.
create or replace function public.update_place_with_tags(
  p_id uuid, p_name text, p_description text, p_local_tip text,
  p_category_slug text, p_lat double precision, p_lng double precision,
  p_address text, p_neighborhood text, p_city text, p_tags text[]
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  updated_id uuid;
begin
  update public.places set
    name = p_name, description = p_description, local_tip = p_local_tip,
    category_slug = p_category_slug, lat = p_lat, lng = p_lng,
    address = p_address, neighborhood = p_neighborhood, city = p_city
  where id = p_id and creator_id = auth.uid() and status in ('published', 'hidden')
  returning id into updated_id;
  if updated_id is null then raise exception 'You do not own this place' using errcode = '42501'; end if;

  delete from public.place_tags where place_id = p_id;
  insert into public.place_tags (place_id, interest_slug)
    select p_id, slug from unnest(coalesce(p_tags, '{}'::text[])) slug;
  return updated_id;
end $$;

-- The owner trigger from 0004, with one way through: moderate_target() sets a
-- transaction-local flag before changing a status, and the flag only counts
-- for a moderator.
create or replace function public.guard_owner_event_change()
returns trigger language plpgsql as $$
begin
  if current_setting('findmaxxing.moderation', true) = 'on' and public.is_moderator() then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if old.status <> 'published' or coalesce(old.ends_at, old.starts_at) <= now() then
      raise exception 'Only future published events can be edited or cancelled' using errcode = 'P0001';
    end if;
    if new.status not in ('published', 'cancelled') then
      raise exception 'Invalid event status' using errcode = 'P0001';
    end if;
    if new.status = 'published' and coalesce(new.ends_at, new.starts_at) <= now() then
      raise exception 'Events must remain in the future when edited' using errcode = 'P0001';
    end if;
    if new.status = 'published' and new.capacity is not null and
       new.capacity < (select count(*) from public.event_attendees where event_id = old.id) then
      raise exception 'Capacity cannot be below the existing attendee count' using errcode = 'P0001';
    end if;
    if new.status = 'cancelled' and (
      new.title, new.description, new.place_id, new.location_name, new.address,
      new.lat, new.lng, new.starts_at, new.ends_at, new.creator_id,
      new.category_slug, new.capacity
    ) is distinct from (
      old.title, old.description, old.place_id, old.location_name, old.address,
      old.lat, old.lng, old.starts_at, old.ends_at, old.creator_id,
      old.category_slug, old.capacity
    ) then
      raise exception 'Cancelling an event cannot also change its details' using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    if auth.uid() is not null and old.creator_id is distinct from auth.uid() then
      raise exception 'You do not own this event' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.event_attendees
      where event_id = old.id and user_id is distinct from old.creator_id
    ) then
      raise exception 'Events with other attendees must be cancelled instead' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- ----------------------------------------------------------------------------
-- Reports: resolution and moderator access
-- ----------------------------------------------------------------------------
alter table public.reports add column resolved_at timestamptz;

create index reports_open_queue_idx on public.reports (target_type, target_id, created_at) where status = 'open';

-- Moderators read the base table, reporter identity included. Nobody updates
-- or deletes reports directly; moderate_target() is the only way to resolve.
create policy "moderators read reports" on public.reports for select
  using (public.is_moderator());
revoke update, delete on public.reports from anon, authenticated;

-- The reporter's own view gains the resolution time. Who resolved it is not
-- in the view and never will be.
create or replace view public.reports_i_filed as
  select r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at, r.resolved_at
  from public.reports r
  where r.reporter_id = auth.uid();

-- ----------------------------------------------------------------------------
-- Audit trail
-- ----------------------------------------------------------------------------
create table public.moderation_actions (
  id                uuid primary key default gen_random_uuid(),
  moderator_id      uuid references public.profiles (id) on delete set null,
  action            text not null
                    check (action in ('dismiss', 'review', 'remove', 'restore', 'revoke_local', 'restore_local')),
  target_type       text not null check (target_type in ('place', 'event', 'profile')),
  target_id         uuid not null,
  reason            text check (reason is null or char_length(reason) <= 500),
  status_before     text,
  status_after      text,
  resolved_reports  integer not null default 0 check (resolved_reports >= 0),
  created_at        timestamptz not null default now()
);

create index moderation_actions_target_idx
  on public.moderation_actions (target_type, target_id, created_at desc, id desc);

alter table public.moderation_actions enable row level security;
create policy "moderators read moderation history" on public.moderation_actions for select
  using (public.is_moderator());

revoke insert, update, delete on public.moderation_actions from anon, authenticated;

-- Grants alone would leave the table owner (and so every definer function)
-- able to rewrite history. Only the service role may; the one other change
-- allowed is the foreign key clearing moderator_id when that account is deleted.
create or replace function public.moderation_actions_append_only()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.moderator_id is null
     and (to_jsonb(new) - 'moderator_id') = (to_jsonb(old) - 'moderator_id') then
    return new;
  end if;
  raise exception 'Moderation history is append-only' using errcode = '42501';
end $$;

create trigger moderation_actions_append_only
  before update or delete on public.moderation_actions
  for each row execute function public.moderation_actions_append_only();

-- ----------------------------------------------------------------------------
-- Moderator operations
--
-- Definer rights: they change rows the moderator does not own and write the
-- audit table, which no client may insert into. Each checks is_moderator()
-- first.
-- ----------------------------------------------------------------------------

-- Resolves a target: every open report on it moves together, the content's
-- status changes if the action calls for it, and one audit row records it.
--   dismiss — reports dismissed, content untouched
--   review  — reports reviewed, content untouched
--   remove  — content removed (reason required), reports reviewed
--   restore — removed content published again, any open reports dismissed
create or replace function public.moderate_target(
  p_target_type text, p_target_id uuid, p_action text, p_reason text default null
) returns table (status_after text, resolved_reports integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_before text;
  v_after text;
  v_report_status text;
  v_resolved integer;
begin
  if not public.is_moderator() then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  if p_target_type not in ('place', 'event', 'profile') then
    raise exception 'moderation:invalid_target' using errcode = 'P0001';
  end if;
  if p_action not in ('dismiss', 'review', 'remove', 'restore') then
    raise exception 'moderation:invalid_action' using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'moderation:reason_too_long' using errcode = 'P0001';
  end if;

  -- Two moderators acting on one target take turns.
  perform pg_advisory_xact_lock(hashtextextended('moderation:' || p_target_type || ':' || p_target_id::text, 0));

  if p_target_type = 'place' then
    select p.status into v_before from public.places p where p.id = p_target_id for update;
  elsif p_target_type = 'event' then
    select e.status into v_before from public.events e where e.id = p_target_id for update;
  else
    perform 1 from public.profiles pr where pr.id = p_target_id;
  end if;
  if not found then
    raise exception 'moderation:not_found' using errcode = 'P0002';
  end if;

  v_after := v_before;
  if p_action = 'remove' then
    if p_target_type = 'profile' then
      raise exception 'moderation:cannot_remove_profile' using errcode = 'P0001';
    end if;
    if v_before = 'removed' then
      raise exception 'moderation:already_removed' using errcode = 'P0001';
    end if;
    if v_reason is null then
      raise exception 'moderation:reason_required' using errcode = 'P0001';
    end if;
    v_after := 'removed';
    v_report_status := 'reviewed';
  elsif p_action = 'restore' then
    if v_before is distinct from 'removed' then
      raise exception 'moderation:not_removed' using errcode = 'P0001';
    end if;
    v_after := 'published';
    v_report_status := 'dismissed';
  elsif p_action = 'dismiss' then
    v_report_status := 'dismissed';
  else
    v_report_status := 'reviewed';
  end if;

  update public.reports r
     set status = v_report_status, resolved_at = now()
   where r.target_type = p_target_type and r.target_id = p_target_id and r.status = 'open';
  get diagnostics v_resolved = row_count;

  if p_action in ('dismiss', 'review') and v_resolved = 0 then
    raise exception 'moderation:nothing_open' using errcode = 'P0001';
  end if;

  if v_after is distinct from v_before then
    perform set_config('findmaxxing.moderation', 'on', true);
    if p_target_type = 'place' then
      update public.places set status = v_after where id = p_target_id;
    else
      update public.events set status = v_after where id = p_target_id;
    end if;
    perform set_config('findmaxxing.moderation', 'off', true);
  end if;

  insert into public.moderation_actions
    (moderator_id, action, target_type, target_id, reason, status_before, status_after, resolved_reports)
  values
    (auth.uid(), p_action, p_target_type, p_target_id, v_reason, v_before, v_after, v_resolved);

  return query select v_after, v_resolved;
end $$;

-- Revokes (or restores) a user's local status, with an audit row. A reason
-- is required either way, so the history explains itself.
create or replace function public.set_local_status(p_user_id uuid, p_revoked boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_was_revoked boolean;
begin
  if not public.is_moderator() then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'moderation:reason_required' using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'moderation:reason_too_long' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moderation:profile:' || p_user_id::text, 0));
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'moderation:not_found' using errcode = 'P0002';
  end if;
  v_was_revoked := exists (select 1 from public.local_revocations where user_id = p_user_id);
  if v_was_revoked = p_revoked then
    raise exception 'moderation:no_change' using errcode = 'P0001';
  end if;
  if p_revoked then
    insert into public.local_revocations (user_id, revoked_by, reason) values (p_user_id, auth.uid(), v_reason);
  else
    delete from public.local_revocations where user_id = p_user_id;
  end if;
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, reason, status_before, status_after)
  values (
    auth.uid(),
    case when p_revoked then 'revoke_local' else 'restore_local' end,
    'profile', p_user_id, v_reason,
    case when v_was_revoked then 'revoked' else 'eligible' end,
    case when p_revoked then 'revoked' else 'eligible' end
  );
end $$;

-- The queue: open reports grouped by target, oldest first, in keyset pages of
-- (first_reported_at, target_id). Target ids are UUIDs, unique across the
-- three target tables, so that order is total. The label comes from the
-- target itself, whoever may otherwise see it. Empty for non-moderators.
create or replace function public.moderation_queue(
  p_after_first timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 31
) returns table (
  target_type text,
  target_id uuid,
  report_count integer,
  first_reported_at timestamptz,
  last_reported_at timestamptz,
  reasons text[],
  target_label text,
  target_status text
)
language sql
stable
security definer
set search_path = public
as $$
  with grouped as (
    select r.target_type, r.target_id,
           count(*)::integer as report_count,
           min(r.created_at) as first_reported_at,
           max(r.created_at) as last_reported_at,
           array_agg(distinct r.reason order by r.reason) as reasons
    from public.reports r
    where r.status = 'open'
    group by r.target_type, r.target_id
  )
  select g.target_type, g.target_id, g.report_count, g.first_reported_at, g.last_reported_at, g.reasons,
         case g.target_type
           when 'place' then (select p.name from public.places p where p.id = g.target_id)
           when 'event' then (select e.title from public.events e where e.id = g.target_id)
           else (select pr.display_name from public.profiles pr where pr.id = g.target_id)
         end,
         case g.target_type
           when 'place' then (select p.status from public.places p where p.id = g.target_id)
           when 'event' then (select e.status from public.events e where e.id = g.target_id)
           else (select case when exists (select 1 from public.local_revocations lr where lr.user_id = g.target_id) then 'revoked' else 'active' end)
         end
  from grouped g
  where public.is_moderator()
    and (p_after_first is null or (g.first_reported_at, g.target_id) > (p_after_first, p_after_id))
  order by g.first_reported_at, g.target_id
  limit least(greatest(coalesce(p_limit, 31), 1), 101);
$$;

-- What a moderator reviews: the target as it is now, whoever may otherwise
-- see it. Null for non-moderators and for targets that no longer exist.
create or replace function public.moderation_target(p_target_type text, p_target_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.is_moderator() then null
    when p_target_type = 'place' then (
      select jsonb_build_object(
        'label', p.name, 'status', p.status, 'visibility', p.visibility, 'city', p.city,
        'neighborhood', p.neighborhood, 'body', p.description, 'extra', p.local_tip,
        'ownerId', p.creator_id, 'ownerUsername', o.username, 'createdAt', p.created_at)
      from public.places p left join public.profiles o on o.id = p.creator_id
      where p.id = p_target_id)
    when p_target_type = 'event' then (
      select jsonb_build_object(
        'label', e.title, 'status', e.status, 'visibility', null, 'city', null,
        'neighborhood', null, 'body', e.description, 'extra', e.location_name,
        'ownerId', e.creator_id, 'ownerUsername', o.username, 'createdAt', e.created_at)
      from public.events e left join public.profiles o on o.id = e.creator_id
      where e.id = p_target_id)
    when p_target_type = 'profile' then (
      select jsonb_build_object(
        'label', pr.display_name, 'status',
        case when exists (select 1 from public.local_revocations lr where lr.user_id = pr.id) then 'revoked' else 'active' end,
        'visibility', null, 'city', pr.home_city, 'neighborhood', null, 'body', pr.bio, 'extra', null,
        'ownerId', pr.id, 'ownerUsername', pr.username, 'createdAt', pr.created_at)
      from public.profiles pr where pr.id = p_target_id)
    else null
  end;
$$;

-- The caller's own places and events that moderators removed, with the reason
-- from the latest removal. Definer rights: the owner can no longer read those
-- rows (can_view_place) or the audit table.
create or replace function public.my_removed_content()
returns table (target_type text, target_id uuid, label text, reason text, removed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select 'place'::text as target_type, p.id as target_id, p.name as label
    from public.places p where p.creator_id = auth.uid() and p.status = 'removed'
    union all
    select 'event', e.id, e.title
    from public.events e where e.creator_id = auth.uid() and e.status = 'removed'
  )
  select m.target_type, m.target_id, m.label, a.reason, a.created_at
  from mine m
  left join lateral (
    select ma.reason, ma.created_at
    from public.moderation_actions ma
    where ma.target_type = m.target_type and ma.target_id = m.target_id and ma.action = 'remove'
    order by ma.created_at desc, ma.id desc
    limit 1
  ) a on true
  order by a.created_at desc nulls last, m.target_id;
$$;

revoke all on function public.moderate_target(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_local_status(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.moderation_queue(timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.moderation_target(text, uuid) from public, anon, authenticated;
revoke all on function public.my_removed_content() from public, anon, authenticated;
grant execute on function public.moderate_target(text, uuid, text, text) to authenticated;
grant execute on function public.set_local_status(uuid, boolean, text) to authenticated;
grant execute on function public.moderation_queue(timestamptz, uuid, integer) to authenticated;
grant execute on function public.moderation_target(text, uuid) to authenticated;
grant execute on function public.my_removed_content() to authenticated;
