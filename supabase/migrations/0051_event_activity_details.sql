-- Roadmap 4.2: structured activity details per kind, and a time zone on every event (4.0 spec §4, §16:
-- "events.time_zone added and backfilled (needed by everything after)").
-- Shapes match packages/shared/src/events.ts activityDetailsSchema. The creator writes both through
-- column grants; RLS and guard_owner_event_change() still decide who may update and when.

create or replace function public.valid_activity_details(p jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 1000
    and (p->>'kind') in ('run', 'volleyball', 'basketball', 'pickleball', 'walk')
    and not exists (
      select 1 from jsonb_object_keys(p) k
      where k <> 'kind' and k <> all (
        case p->>'kind'
          when 'run' then array['distance', 'unit', 'paceFrom', 'paceTo', 'regroup', 'noDrop', 'noDropNote']
          when 'pickleball' then array['level', 'play', 'paddlesAvailable']
          when 'walk' then array['note']
          else array['format', 'playerLimit', 'beginnersWelcome']
        end
      )
    )
    and (not p ? 'distance' or (jsonb_typeof(p->'distance') = 'number' and (p->>'distance')::numeric between 0.5 and 100))
    and (not p ? 'unit' or (p->>'unit') in ('km', 'mi'))
    and (not p ? 'paceFrom' or (p->>'paceFrom') ~ '^\d{1,2}:[0-5]\d$')
    and (not p ? 'paceTo' or (p->>'paceTo') ~ '^\d{1,2}:[0-5]\d$')
    and (not p ? 'regroup' or (jsonb_typeof(p->'regroup') = 'string' and char_length(p->>'regroup') <= 120))
    and (not p ? 'noDrop' or jsonb_typeof(p->'noDrop') = 'boolean')
    and (not p ? 'noDropNote' or (jsonb_typeof(p->'noDropNote') = 'string' and char_length(p->>'noDropNote') <= 160))
    and (not p ? 'format' or (jsonb_typeof(p->'format') = 'string' and char_length(p->>'format') <= 40))
    and (not p ? 'playerLimit' or (jsonb_typeof(p->'playerLimit') = 'number' and (p->>'playerLimit')::numeric between 2 and 200 and (p->>'playerLimit')::numeric = trunc((p->>'playerLimit')::numeric)))
    and (not p ? 'beginnersWelcome' or jsonb_typeof(p->'beginnersWelcome') = 'boolean')
    -- Skill is a plain description from a fixed list, never a number.
    and (not p ? 'level' or (p->>'level') in ('new', 'casual', 'regular', 'competitive'))
    and (not p ? 'play' or (p->>'play') in ('singles', 'doubles', 'either'))
    and (not p ? 'paddlesAvailable' or jsonb_typeof(p->'paddlesAvailable') = 'boolean')
    and (not p ? 'note' or (jsonb_typeof(p->'note') = 'string' and char_length(p->>'note') <= 160))
  )
$$;

alter table public.events add column if not exists activity_details jsonb;
alter table public.events drop constraint if exists events_activity_details_valid;
alter table public.events add constraint events_activity_details_valid check (public.valid_activity_details(activity_details));

-- Every event gets a zone. Existing rows take today's app-wide default (DEFAULT_TIME_ZONE).
alter table public.events add column if not exists time_zone text not null default 'America/New_York'
  check (char_length(time_zone) <= 64);

-- A real IANA zone, checked the way notification_settings checks its zone (at time zone must not raise).
create or replace function public.check_event_time_zone()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform now() at time zone new.time_zone;
  return new;
exception when others then
  raise exception 'Unknown time zone' using errcode = '22023';
end $$;

drop trigger if exists check_event_time_zone on public.events;
create trigger check_event_time_zone before insert or update of time_zone on public.events
  for each row execute function public.check_event_time_zone();

grant update (activity_details, time_zone) on public.events to authenticated;
