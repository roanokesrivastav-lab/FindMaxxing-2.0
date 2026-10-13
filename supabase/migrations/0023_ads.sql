-- ============================================================================
-- FindMaxxing — local, clearly labeled sponsored cards.
--
--   * Who: local businesses and organizers promoting their own public place
--     or upcoming event. Nothing else can be advertised.
--   * Where (pending owner confirmation): at most one sponsored card per list
--     per search (after the 4th place, after the 2nd event), always labeled.
--     The card is served separately from the organic results, which this
--     migration does not touch: ranking, ratings and visibility are unchanged.
--   * No tracking: targeting is contextual only (map area, category, dates);
--     impressions are counted per campaign, day and slot, never per person;
--     no clicks are recorded. Plus subscribers are never served ads.
--   * Budgets buy impressions at a fixed CPM ($5 per 1,000), paced by a daily
--     cap so a campaign lasts its whole run.
--   * Review: every campaign waits for an admin, who approves or rejects it
--     (audited); the advertiser then pays through Stripe (Session 17).
-- ============================================================================

create table public.ad_campaigns (
  id               uuid primary key default gen_random_uuid(),
  advertiser_id    uuid not null references public.profiles (id) on delete cascade,
  kind             text not null check (kind in ('place', 'event')),
  place_id         uuid references public.places (id) on delete cascade,
  event_id         uuid references public.events (id) on delete cascade,
  headline         text not null check (char_length(btrim(headline)) between 3 and 60),
  body             text check (body is null or char_length(body) <= 140),
  -- Contextual targeting: an area (all four or none) and/or a category.
  north            double precision check (north between -90 and 90),
  south            double precision check (south between -90 and 90),
  east             double precision check (east between -180 and 180),
  west             double precision check (west between -180 and 180),
  category_slug    text references public.categories (slug),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  budget_cents     integer not null check (budget_cents between 2000 and 100000),
  status           text not null default 'pending_review'
                   check (status in ('pending_review', 'rejected', 'awaiting_payment', 'active', 'paused', 'ended')),
  review_note      text check (review_note is null or char_length(review_note) <= 500),
  reviewed_by      uuid references public.profiles (id) on delete set null,
  reviewed_at      timestamptz,
  checkout_session_id text unique,
  paid_cents       integer,
  created_at       timestamptz not null default now(),
  check ((kind = 'place') = (place_id is not null) and (kind = 'event') = (event_id is not null)),
  check ((north is null) = (south is null) and (south is null) = (east is null) and (east is null) = (west is null)),
  check (north is null or north > south),
  check (ends_at > starts_at and ends_at <= starts_at + interval '60 days')
);
create index ad_campaigns_active_idx on public.ad_campaigns (kind, status) where status = 'active';
create index ad_campaigns_advertiser_idx on public.ad_campaigns (advertiser_id, created_at desc);

-- Impressions, aggregated: no user, no session, no IP.
create table public.ad_impressions (
  campaign_id  uuid not null references public.ad_campaigns (id) on delete cascade,
  day          date not null,
  slot         text not null check (slot in ('places', 'events')),
  impressions  integer not null default 0 check (impressions >= 0),
  primary key (campaign_id, day, slot)
);

alter table public.ad_campaigns enable row level security;
alter table public.ad_impressions enable row level security;
create policy "advertisers and admins read campaigns" on public.ad_campaigns for select using (advertiser_id = auth.uid() or public.is_admin());
create policy "advertisers and admins read delivery" on public.ad_impressions for select using (
  public.is_admin() or exists (select 1 from public.ad_campaigns c where c.id = campaign_id and c.advertiser_id = auth.uid()));
revoke insert, update, delete on public.ad_campaigns, public.ad_impressions from anon, authenticated;

alter table public.moderation_actions drop constraint moderation_actions_action_check;
alter table public.moderation_actions add constraint moderation_actions_action_check
  check (action in ('dismiss', 'review', 'remove', 'restore', 'revoke_local', 'restore_local', 'reset_reputation',
                    'suspend', 'unsuspend', 'grant_moderator', 'revoke_moderator', 'taxonomy_upsert', 'taxonomy_retire', 'taxonomy_restore',
                    'approve_ad', 'reject_ad'));
alter table public.moderation_actions drop constraint moderation_actions_target_type_check;
alter table public.moderation_actions add constraint moderation_actions_target_type_check
  check (target_type in ('place', 'event', 'profile', 'message', 'category', 'interest', 'campaign'));

insert into public.rate_limit_rules (action, max_count, window_seconds, label) values ('ad_campaigns', 10, 86400, 'ad campaigns');

-- $5 per 1,000 impressions: a budget buys budget_cents * 2 impressions.
create or replace function public.ad_impression_budget(p_budget_cents integer)
returns integer language sql immutable as $$ select p_budget_cents * 2 $$;

-- What can be advertised: your own public place, or your own upcoming published
-- event that is not tied to a non-public place.
create or replace function public.ad_target_ok(p_kind text, p_place uuid, p_event uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'place' then exists (select 1 from public.places p where p.id = p_place and p.creator_id = p_owner
                               and p.status = 'published' and p.visibility = 'public')
    else exists (select 1 from public.events e left join public.places p on p.id = e.place_id
                 where e.id = p_event and e.creator_id = p_owner and e.status = 'published'
                   and coalesce(e.ends_at, e.starts_at) > now()
                   and (e.place_id is null or (p.status = 'published' and p.visibility = 'public')))
  end;
$$;
revoke all on function public.ad_target_ok(text, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.create_ad_campaign(
  p_kind text, p_target uuid, p_headline text, p_body text, p_category text,
  p_north double precision, p_south double precision, p_east double precision, p_west double precision,
  p_starts_at timestamptz, p_ends_at timestamptz, p_budget_cents integer
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode = 'P0001'; end if;
  if p_kind not in ('place', 'event') or not public.ad_target_ok(p_kind, case when p_kind = 'place' then p_target end, case when p_kind = 'event' then p_target end, auth.uid()) then
    raise exception 'ads:bad_target' using errcode = 'P0001';
  end if;
  if p_ends_at <= greatest(p_starts_at, now()) then raise exception 'ads:bad_dates' using errcode = 'P0001'; end if;
  perform public.check_rate_limit('ad_campaigns');
  insert into public.ad_campaigns (advertiser_id, kind, place_id, event_id, headline, body, category_slug, north, south, east, west, starts_at, ends_at, budget_cents)
  values (auth.uid(), p_kind, case when p_kind = 'place' then p_target end, case when p_kind = 'event' then p_target end,
          btrim(p_headline), nullif(btrim(coalesce(p_body, '')), ''), p_category, p_north, p_south, p_east, p_west, p_starts_at, p_ends_at, p_budget_cents)
  returning id into cid;
  return cid;
end $$;
revoke all on function public.create_ad_campaign(text, uuid, text, text, text, double precision, double precision, double precision, double precision, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.create_ad_campaign(text, uuid, text, text, text, double precision, double precision, double precision, double precision, timestamptz, timestamptz, integer) to authenticated;

-- Admins approve (it then waits for payment) or reject, with the reason kept in the audit log.
create or replace function public.review_ad_campaign(p_campaign uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.ad_campaigns%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  select * into c from public.ad_campaigns where id = p_campaign for update;
  if not found then raise exception 'ads:not_found' using errcode = 'P0002'; end if;
  if c.status <> 'pending_review' then raise exception 'ads:not_pending' using errcode = 'P0001'; end if;
  if not p_approve and v_note is null then raise exception 'moderation:reason_required' using errcode = 'P0001'; end if;
  update public.ad_campaigns set status = case when p_approve then 'awaiting_payment' else 'rejected' end,
    review_note = v_note, reviewed_by = auth.uid(), reviewed_at = now() where id = p_campaign;
  insert into public.moderation_actions (moderator_id, action, target_type, target_id, reason, status_before, status_after)
  values (auth.uid(), case when p_approve then 'approve_ad' else 'reject_ad' end, 'campaign', p_campaign, v_note,
          'pending_review', case when p_approve then 'awaiting_payment' else 'rejected' end);
end $$;
revoke all on function public.review_ad_campaign(uuid, boolean, text) from public, anon;
grant execute on function public.review_ad_campaign(uuid, boolean, text) to authenticated;

-- Advertisers pause and resume their running campaigns.
create or replace function public.set_ad_campaign_paused(p_campaign uuid, p_paused boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ad_campaigns set status = case when p_paused then 'paused' else 'active' end
  where id = p_campaign and advertiser_id = auth.uid() and status = case when p_paused then 'active' else 'paused' end;
  if not found then raise exception 'ads:not_found' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.set_ad_campaign_paused(uuid, boolean) from public, anon;
grant execute on function public.set_ad_campaign_paused(uuid, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- Service role: payment and serving
-- ----------------------------------------------------------------------------
create or replace function public.attach_ad_checkout(p_campaign uuid, p_session text)
returns void language sql security definer set search_path = public as $$
  update public.ad_campaigns set checkout_session_id = p_session where id = p_campaign and status = 'awaiting_payment';
$$;

-- Payment received for the whole budget: the campaign runs. Idempotent.
create or replace function public.activate_ad_campaign(p_session text, p_amount integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  c public.ad_campaigns%rowtype;
begin
  select * into c from public.ad_campaigns where checkout_session_id = p_session for update;
  if not found then return 'unknown'; end if;
  if c.status <> 'awaiting_payment' then return 'duplicate'; end if;
  if p_amount is distinct from c.budget_cents then return 'mismatch'; end if;
  update public.ad_campaigns set status = 'active', paid_cents = p_amount where id = c.id;
  return 'active';
end $$;

-- Picks at most one card for a slot and counts the impression. Eligible: an
-- active campaign of the slot's kind, inside its dates, whose target is still
-- public, matching the context (its area overlaps the map, its category is
-- the one searched, when either is set), with budget left and under today's
-- pacing cap. The least-delivered today goes first (ties by id): no
-- randomness, no person. Called by the server only, never for Plus members.
create or replace function public.serve_ad(
  p_slot text, p_north double precision, p_south double precision, p_east double precision, p_west double precision,
  p_category text, p_now timestamptz default now()
) returns table (campaign_id uuid, kind text, target_id uuid, headline text, body text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_kind text := case p_slot when 'places' then 'place' when 'events' then 'event' end;
  v_day date := (p_now at time zone 'UTC')::date;
  c record;
begin
  if v_kind is null then return; end if;
  for c in
    select q.* from (
      select x.*,
        coalesce((select sum(i.impressions) from public.ad_impressions i where i.campaign_id = x.id), 0) as delivered,
        coalesce((select sum(i.impressions) from public.ad_impressions i where i.campaign_id = x.id and i.day = v_day), 0) as today,
        ceil(public.ad_impression_budget(x.budget_cents)::numeric / greatest(ceil(extract(epoch from (x.ends_at - x.starts_at)) / 86400), 1)) as daily_cap
      from public.ad_campaigns x
      where x.kind = v_kind and x.status = 'active' and x.starts_at <= p_now and x.ends_at > p_now
        and public.ad_target_ok(x.kind, x.place_id, x.event_id, x.advertiser_id)
        and (x.category_slug is null or p_category is null or x.category_slug = p_category)
        and (x.north is null or p_north is null or (x.south < p_north and x.north > p_south and x.west < p_east and x.east > p_west))
    ) q
    order by q.today, q.id
  loop
    if c.delivered >= public.ad_impression_budget(c.budget_cents) or c.today >= c.daily_cap then continue; end if;
    perform pg_advisory_xact_lock(hashtextextended('ad:' || c.id::text, 0));
    insert into public.ad_impressions (campaign_id, day, slot, impressions) values (c.id, v_day, p_slot, 1)
    on conflict (campaign_id, day, slot) do update set impressions = ad_impressions.impressions + 1;
    if c.delivered + 1 >= public.ad_impression_budget(c.budget_cents) then
      update public.ad_campaigns set status = 'ended' where id = c.id;
    end if;
    return query select c.id, c.kind, coalesce(c.place_id, c.event_id), c.headline, c.body;
    return;
  end loop;
end $$;

-- Campaigns past their end date stop (the payments cron runs this).
create or replace function public.end_finished_ad_campaigns(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  update public.ad_campaigns set status = 'ended' where status in ('active', 'paused') and ends_at <= p_now;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare
  f text;
begin
  foreach f in array array['attach_ad_checkout(uuid, text)', 'activate_ad_campaign(text, integer)',
    'serve_ad(text, double precision, double precision, double precision, double precision, text, timestamptz)',
    'end_finished_ad_campaigns(timestamptz)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

create trigger ad_campaigns_block_suspended before insert or update or delete on public.ad_campaigns for each row execute function public.block_suspended_writes();
