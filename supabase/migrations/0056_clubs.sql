-- Roadmap R3: lightweight clubs (spec in docs/features/R3.md). A named group around one or more
-- recurring series: members, hosts (derived from the attached series' hosts), a shared page.
-- Joining never RSVPs: nothing here writes event_attendees or event_participants.
-- Members-only privacy: member names are visible to members and club hosts; others see the count.

create table if not exists public.clubs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (char_length(name) between 3 and 80),
  description text not null default '' check (char_length(description) <= 600),
  status      text not null default 'active' check (status in ('active', 'removed'))
);
create table if not exists public.club_series (
  club_id   uuid not null references public.clubs (id) on delete cascade,
  series_id uuid not null references public.event_series (id) on delete cascade,
  primary key (club_id, series_id)
);
create table if not exists public.club_members (
  club_id   uuid not null references public.clubs (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (club_id, user_id)
);
create index if not exists club_members_user_idx on public.club_members (user_id);
create index if not exists club_series_series_idx on public.club_series (series_id);

-- A club host: its owner, or a host of any attached series.
create or replace function public.is_club_host(p_club uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null and (
    exists (select 1 from public.clubs c where c.id = p_club and c.owner_id = p_user)
    or exists (select 1 from public.club_series cs join public.event_series_hosts h on h.series_id = cs.series_id
               where cs.club_id = p_club and h.user_id = p_user))
$$;
revoke all on function public.is_club_host(uuid, uuid) from public, anon, authenticated;

-- Caller-bound helpers the RLS policies use (they run as the caller).
create or replace function public.can_view_club(p_club uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.clubs c where c.id = p_club and (c.status = 'active' or c.owner_id = auth.uid()))
$$;
create or replace function public.viewer_sees_club_members(p_club uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and public.can_view_club(p_club) and (
    exists (select 1 from public.club_members m where m.club_id = p_club and m.user_id = auth.uid())
    or public.is_club_host(p_club, auth.uid()))
$$;
revoke all on function public.can_view_club(uuid) from public;
revoke all on function public.viewer_sees_club_members(uuid) from public;
grant execute on function public.can_view_club(uuid) to anon, authenticated, service_role;
grant execute on function public.viewer_sees_club_members(uuid) to anon, authenticated, service_role;

alter table public.clubs enable row level security;
alter table public.club_series enable row level security;
alter table public.club_members enable row level security;
drop policy if exists "visible clubs" on public.clubs;
create policy "visible clubs" on public.clubs for select using (public.can_view_club(id));
drop policy if exists "visible club series" on public.club_series;
create policy "visible club series" on public.club_series for select using (public.can_view_club(club_id));
drop policy if exists "members see members" on public.club_members;
create policy "members see members" on public.club_members for select
  using (user_id = auth.uid() or public.viewer_sees_club_members(club_id));
revoke insert, update, delete, truncate on public.clubs, public.club_series, public.club_members from anon, authenticated;

-- The member count, for everyone who can see the club (never names).
create or replace function public.club_member_count(p_club uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.can_view_club(p_club) then (select count(*)::integer from public.club_members where club_id = p_club) end
$$;
revoke all on function public.club_member_count(uuid) from public;
grant execute on function public.club_member_count(uuid) to anon, authenticated, service_role;

create or replace function public.create_club(p_name text, p_description text, p_series uuid[])
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
  v_id uuid;
  v_s uuid;
begin
  if coalesce(cardinality(p_series), 0) = 0 then raise exception 'A club gathers at least one series' using errcode = 'P0001'; end if;
  foreach v_s in array p_series loop
    if not public.is_series_host(v_s, v_uid) then raise exception 'You can only add series you host' using errcode = '42501'; end if;
  end loop;
  perform public.check_rate_limit('events');
  insert into public.clubs (owner_id, name, description) values (v_uid, btrim(p_name), coalesce(btrim(p_description), '')) returning id into v_id;
  insert into public.club_series (club_id, series_id) select v_id, s from unnest(p_series) s on conflict do nothing;
  insert into public.club_members (club_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;

create or replace function public.set_club_series(p_club uuid, p_series uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if not exists (select 1 from public.clubs where id = p_club and owner_id = v_uid and status = 'active') then
    raise exception 'Only the club owner changes its series' using errcode = '42501';
  end if;
  if p_on then
    if not public.is_series_host(p_series, v_uid) then raise exception 'You can only add series you host' using errcode = '42501'; end if;
    insert into public.club_series (club_id, series_id) values (p_club, p_series) on conflict do nothing;
  else
    if (select count(*) from public.club_series where club_id = p_club) <= 1 then raise exception 'A club gathers at least one series' using errcode = 'P0001'; end if;
    delete from public.club_series where club_id = p_club and series_id = p_series;
  end if;
end $$;

-- Join or leave. Never RSVPs.
create or replace function public.join_club(p_club uuid, p_on boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if not exists (select 1 from public.clubs where id = p_club and status = 'active') then raise exception 'Club not found' using errcode = 'P0002'; end if;
  if p_on then
    insert into public.club_members (club_id, user_id) values (p_club, v_uid) on conflict do nothing;
  else
    if exists (select 1 from public.clubs where id = p_club and owner_id = v_uid) then raise exception 'The owner cannot leave their club' using errcode = 'P0001'; end if;
    delete from public.club_members where club_id = p_club and user_id = v_uid;
  end if;
  return p_on;
end $$;

create or replace function public.remove_club_member(p_club uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_active_caller();
begin
  if not exists (select 1 from public.clubs where id = p_club and owner_id = v_uid) then raise exception 'Only the club owner removes members' using errcode = '42501'; end if;
  if p_user = v_uid then raise exception 'The owner cannot remove themselves' using errcode = 'P0001'; end if;
  delete from public.club_members where club_id = p_club and user_id = p_user;
end $$;

create or replace function public.moderate_club(p_club uuid, p_remove boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_moderator() then raise exception 'Moderators only' using errcode = '42501'; end if;
  update public.clubs set status = case when p_remove then 'removed' else 'active' end where id = p_club;
end $$;

revoke all on function public.create_club(text, text, uuid[]) from public, anon;
revoke all on function public.set_club_series(uuid, uuid, boolean) from public, anon;
revoke all on function public.join_club(uuid, boolean) from public, anon;
revoke all on function public.remove_club_member(uuid, uuid) from public, anon;
revoke all on function public.moderate_club(uuid, boolean) from public, anon;
grant execute on function public.create_club(text, text, uuid[]) to authenticated;
grant execute on function public.set_club_series(uuid, uuid, boolean) to authenticated;
grant execute on function public.join_club(uuid, boolean) to authenticated;
grant execute on function public.remove_club_member(uuid, uuid) to authenticated;
grant execute on function public.moderate_club(uuid, boolean) to authenticated;
