-- ============================================================================
-- FindMaxxing — comparison scores in per-category taste
-- (docs/recommendations-plan-claude.md, stage 1b feeding 1a).
--
-- A star rating used to weigh stars - 3 (5 +2 ... 1 -2) in user_taste. It now
-- weighs the place's Bradley-Terry strength from fit_user_category_strengths(),
-- which starts at stars - 3 and moves with the person's head-to-head answers
-- (0037). With no answers the strength is exactly stars - 3, so nothing changes
-- for anyone who has not compared places.
--
-- fit_user_category_scores() becomes the same strengths through a logistic
-- 0-10 curve. The demo twins are fitStrengths() in src/lib/ranking/bradleyTerry.ts
-- and demoTaste() in src/lib/data/demo/recommend.ts.
-- ============================================================================

create or replace function public.fit_user_category_strengths(p_category text)
returns table (place_id uuid, strength double precision)
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
    strength := theta[i];
    return next;
  end loop;
end;
$$;


revoke all on function public.fit_user_category_strengths(text) from public, anon;
grant execute on function public.fit_user_category_strengths(text) to authenticated;


create or replace function public.fit_user_category_scores(p_category text)
returns table (place_id uuid, score double precision)
language sql
stable
security invoker
set search_path = public
as $$
  select f.place_id, 10 / (1 + exp(-f.strength)) from public.fit_user_category_strengths(p_category) f
$$;

create or replace view public.user_taste with (security_invoker = true) as
with me as (select auth.uid() as id),
strengths as (
  select f.place_id, f.strength
  from (
    select distinct p.category_slug
    from public.place_ratings r join public.places p on p.id = r.place_id, me
    where r.user_id = me.id
  ) cats
  cross join lateral public.fit_user_category_strengths(cats.category_slug) f
),
acts as (
  select 'place'::text as item_type, s.place_id as item_id, p.category_slug, 1.0::float8 as weight, s.created_at as at
  from public.saved_places s join public.places p on p.id = s.place_id, me
  where s.user_id = me.id
  union all
  select 'place', r.place_id, p.category_slug,
         st.strength, r.updated_at
  from public.place_ratings r join public.places p on p.id = r.place_id join strengths st on st.place_id = r.place_id, me
  where r.user_id = me.id
  union all
  select 'event', a.event_id, e.category_slug, 1.0, a.created_at
  from public.event_attendees a join public.events e on e.id = a.event_id, me
  where a.user_id = me.id and e.creator_id is distinct from me.id
  union all
  select h.item_type, h.item_id, coalesce(p.category_slug, e.category_slug), -2.0, h.created_at
  from public.user_interactions h
  left join public.places p on h.item_type = 'place' and p.id = h.item_id
  left join public.events e on h.item_type = 'event' and e.id = h.item_id, me
  where h.user_id = me.id and h.action = 'hide' and (p.id is not null or e.id is not null)
  union all
  select i.item_type, i.item_id, min(coalesce(p.category_slug, e.category_slug)), -0.1, max(i.created_at)
  from public.user_interactions i
  left join public.places p on i.item_type = 'place' and p.id = i.item_id
  left join public.events e on i.item_type = 'event' and e.id = i.item_id, me
  where i.user_id = me.id and i.action = 'impression' and (p.id is not null or e.id is not null)
    and not exists (
      select 1 from public.user_interactions o
      where o.user_id = me.id and o.item_type = i.item_type and o.item_id = i.item_id
        and o.action in ('view', 'save', 'rate', 'join', 'hide'))
    and not exists (select 1 from public.saved_places s where s.user_id = me.id and i.item_type = 'place' and s.place_id = i.item_id)
    and not exists (select 1 from public.place_ratings r where r.user_id = me.id and i.item_type = 'place' and r.place_id = i.item_id)
    and not exists (select 1 from public.event_attendees a where a.user_id = me.id and i.item_type = 'event' and a.event_id = i.item_id)
  group by i.item_type, i.item_id
  having count(*) >= 3
),
tagged as (
  select a.category_slug, t.interest_slug,
         a.weight * exp(-floor(extract(epoch from (now() - a.at)) / 86400.0) / 90.0) as w
  from acts a
  join (
    select 'place'::text as item_type, place_id as item_id, interest_slug from public.place_tags
    union all
    select 'event', event_id, interest_slug from public.event_tags
  ) t on t.item_type = a.item_type and t.item_id = a.item_id
),
prior as (select pi.interest_slug from public.profile_interests pi, me where pi.profile_id = me.id),
own_categories as (
  select category_slug from acts where weight <> 0 group by category_slug having count(*) >= 3
),
scoped as (
  select null::text as category_slug, interest_slug, w from tagged
  union all
  select null, interest_slug, 1.0 from prior
  union all
  select t.category_slug, t.interest_slug, t.w from tagged t join own_categories c on c.category_slug = t.category_slug
  union all
  select c.category_slug, p.interest_slug, 1.0 from own_categories c cross join prior p
)
select category_slug, interest_slug, sum(w) as weight
from scoped
group by category_slug, interest_slug;

