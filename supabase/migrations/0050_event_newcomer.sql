-- Roadmap 4.1: the "Your first time?" block on the event page, from host-entered fields.
-- One nullable jsonb column on events, shape-checked in the database (keys and lengths match
-- packages/shared/src/events.ts eventNewcomerSchema). The creator writes it through a column grant;
-- the existing RLS update policy and guard_owner_event_change() still decide who may update and when
-- (creator only, future published events only).

create or replace function public.valid_event_newcomer(p jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('meetingSpot', 'welcomer', 'bring', 'soloWelcome'))
    and (not p ? 'meetingSpot' or (jsonb_typeof(p->'meetingSpot') = 'string' and char_length(p->>'meetingSpot') <= 140))
    and (not p ? 'welcomer' or (jsonb_typeof(p->'welcomer') = 'string' and char_length(p->>'welcomer') <= 80))
    and (not p ? 'bring' or (jsonb_typeof(p->'bring') = 'string' and char_length(p->>'bring') <= 200))
    and (not p ? 'soloWelcome' or jsonb_typeof(p->'soloWelcome') = 'boolean')
  )
$$;

alter table public.events add column if not exists newcomer jsonb;
alter table public.events drop constraint if exists events_newcomer_valid;
alter table public.events add constraint events_newcomer_valid check (public.valid_event_newcomer(newcomer));

-- Column-level: the creator may set it (RLS "users update own events" + the owner guard apply).
grant update (newcomer) on public.events to authenticated;
