-- ============================================================================
-- FindMaxxing — head-to-head place comparisons and per-category scores
-- (docs/recommendations-plan-claude.md, stage 1b).
--
-- place_comparisons holds "I preferred A to B" answers between two places the
-- person has already rated in the same category. Owner-only: nobody else can
-- read, and a comparison can only name places the writer rated themselves.
-- A pair is answered once (change your mind by deleting and answering again).
--
-- fit_user_category_scores(category) turns the caller's star ratings and
-- comparisons into a 0-10 score per rated place: Bradley-Terry with a
-- Gaussian prior centred on stars - 3, fitted by 100 synchronous gradient
-- steps of 0.1 (src/lib/ranking/bradleyTerry.ts is the twin). It reads at most
-- the caller's 500 newest comparisons in the category, and only for auth.uid().
-- Nothing consumes it yet; the rating UI waits on the owner's answer to open
-- question 1 in the plan.
-- ============================================================================

create table public.place_comparisons (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  winner_id   uuid not null references public.places (id) on delete cascade,
  loser_id    uuid not null references public.places (id) on delete cascade,
  created_at  timestamptz not null default now(),
  check (winner_id <> loser_id)
);
create unique index place_comparisons_pair_idx
  on public.place_comparisons (user_id, least(winner_id, loser_id), greatest(winner_id, loser_id));
create index place_comparisons_user_time_idx on public.place_comparisons (user_id, created_at);

alter table public.place_comparisons enable row level security;

create policy "own comparisons are readable" on public.place_comparisons for select
  using (user_id = auth.uid());
create policy "own comparisons are deletable" on public.place_comparisons for delete
  using (user_id = auth.uid());
create policy "own comparisons between own ratings in one category" on public.place_comparisons for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.place_ratings rw
      join public.places pw on pw.id = rw.place_id
      join public.place_ratings rl on rl.user_id = rw.user_id
      join public.places pl on pl.id = rl.place_id
      where rw.user_id = auth.uid()
        and rw.place_id = place_comparisons.winner_id
        and rl.place_id = place_comparisons.loser_id
        and pw.category_slug = pl.category_slug
    )
  );

revoke all on public.place_comparisons from public, anon, authenticated;
grant select, delete on public.place_comparisons to authenticated;
grant insert (user_id, winner_id, loser_id) on public.place_comparisons to authenticated;
grant select, insert, delete on public.place_comparisons to service_role;

create or replace function public.fit_user_category_scores(p_category text)
returns table (place_id uuid, score double precision)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  ids uuid[];
  mu double precision[];
  theta double precision[];
  grad double precision[];
  wi integer[] := '{}';
  li integer[] := '{}';
  n integer;
  c record;
  i integer;
  k integer;
  lost double precision;
begin
  select coalesce(array_agg(r.place_id order by r.place_id), '{}'),
         coalesce(array_agg((r.score - 3)::double precision order by r.place_id), '{}')
    into ids, mu
  from public.place_ratings r
  join public.places p on p.id = r.place_id
  where r.user_id = auth.uid() and p.category_slug = p_category;

  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then return; end if;

  for c in
    select * from (
      select cmp.winner_id, cmp.loser_id
      from public.place_comparisons cmp
      where cmp.user_id = auth.uid()
        and cmp.winner_id = any (ids) and cmp.loser_id = any (ids)
      order by cmp.created_at desc, cmp.id desc
      limit 500
    ) newest
    order by newest.winner_id, newest.loser_id
  loop
    wi := wi || array_position(ids, c.winner_id);
    li := li || array_position(ids, c.loser_id);
  end loop;

  theta := mu;
  for k in 1..100 loop
    grad := array_fill(0::double precision, array[n]);
    for i in 1..n loop
      grad[i] := mu[i] - theta[i];
    end loop;
    for i in 1..coalesce(array_length(wi, 1), 0) loop
      lost := 1 / (1 + exp(theta[li[i]] - theta[wi[i]]));
      grad[wi[i]] := grad[wi[i]] + (1 - lost);
      grad[li[i]] := grad[li[i]] - (1 - lost);
    end loop;
    for i in 1..n loop
      theta[i] := theta[i] + 0.1 * grad[i];
    end loop;
  end loop;

  for i in 1..n loop
    place_id := ids[i];
    score := 10 / (1 + exp(-theta[i]));
    return next;
  end loop;
end;
$$;

revoke all on function public.fit_user_category_scores(text) from public, anon;
grant execute on function public.fit_user_category_scores(text) to authenticated;
