-- Server-owned insertion metadata must not be supplied through PostgREST.
-- auth.uid() remains set inside definer RPCs; trusted maintenance without a
-- user JWT can still import historical data and resolve reports.
create or replace function public.guard_user_insert_metadata()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if auth.uid() is not null then
    new.created_at := clock_timestamp();
    if tg_table_name = 'reports' then
      new.status := 'open';
      new.resolved_at := null;
    end if;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['places','events','place_ratings','saved_places','event_attendees','reports','messages'] loop
    execute format('create trigger %I before insert on public.%I for each row execute function public.guard_user_insert_metadata()',
      t || '_a_insert_metadata', t);
  end loop;
end $$;

-- Preserve upsert compatibility: SDKs include identity columns even when they
-- are unchanged. Reject moving a rating rather than removing those grants.
create or replace function public.guard_rating_identity()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if (new.id,new.place_id,new.user_id,new.created_at) is distinct from
     (old.id,old.place_id,old.user_id,old.created_at) then
    raise exception 'Rating identity and creation time are immutable' using errcode='42501';
  end if;
  return new;
end $$;
create trigger place_ratings_guard_identity before update on public.place_ratings
  for each row execute function public.guard_rating_identity();

-- Catch existing aggregates that may have drifted before identity became fixed.
update public.places p set
  rating_avg=coalesce((select round(avg(score)::numeric,2) from public.place_ratings r where r.place_id=p.id),0),
  rating_count=(select count(*) from public.place_ratings r where r.place_id=p.id);

-- A second, physical-object cap bounds variant upload/delete cycles too.
insert into public.rate_limit_rules(action,max_count,window_seconds,label)
  values('photo_objects',180,3600,'photo objects');
create or replace function public.count_upload(p_bucket text, p_name text)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text,0));
  if public.account_is_closing(auth.uid()) then raise exception 'account_deletion_in_progress' using errcode='P0001'; end if;
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode='P0001'; end if;
  if p_bucket='avatars' then
    perform public.check_rate_limit('avatars');
  elsif p_bucket='place-photos' then
    perform public.check_rate_limit('photo_objects');
    -- Only the pipeline's two WebP variants with an existing, caller-owned
    -- main object qualify. Arbitrary suffixes and orphan variants count fully.
    if not (p_name ~ '\.(sm|md)\.webp$'
      and starts_with(p_name,auth.uid()::text || '/')
      and exists (select 1 from storage.objects o where o.bucket_id='place-photos'
        and o.name=regexp_replace(p_name,'\.(sm|md)\.webp$','.webp'))) then
      perform public.check_rate_limit('photos');
    end if;
  end if;
  return true;
end $$;

-- The trip endpoint calls this RPC before spending on an external AI request.
create or replace function public.consume_trip_plan()
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account_close:' || auth.uid()::text,0));
  if public.is_suspended(auth.uid()) then raise exception 'account_suspended' using errcode='P0001'; end if;
  if public.account_is_closing(auth.uid()) then raise exception 'account_deletion_in_progress' using errcode='P0001'; end if;
  perform public.check_rate_limit(case when public.is_plus(auth.uid()) then 'trip_plans_plus' else 'trip_plans' end);
end $$;
