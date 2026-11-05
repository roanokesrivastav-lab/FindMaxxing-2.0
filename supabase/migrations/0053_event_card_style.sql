-- Roadmap 4.8: the host-toggled Party poster card (4.0 spec §5 "card_style"). Off by default: every
-- event keeps the Readiness row unless its creator turns the poster on. Written by the creator through a
-- column grant; RLS "users update own events" and guard_owner_event_change() decide who and when.
alter table public.events add column if not exists card_style text not null default 'readiness';
alter table public.events drop constraint if exists events_card_style_valid;
alter table public.events add constraint events_card_style_valid check (card_style in ('readiness', 'party_poster'));
grant update (card_style) on public.events to authenticated;
