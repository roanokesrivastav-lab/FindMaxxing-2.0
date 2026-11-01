-- F4: hosted Supabase explicitly grants EXECUTE to API roles by default.
-- Revoking PUBLIC alone (0004) does not remove those grants. Preserve the
-- intended authenticated callers and service-role access without body changes.
revoke all on function public.create_place_with_details(text,text,text,text,double precision,double precision,text,text,text,text,text[],jsonb) from public, anon, authenticated;
revoke all on function public.update_place_with_tags(uuid,text,text,text,text,double precision,double precision,text,text,text,text[]) from public, anon, authenticated;
revoke all on function public.update_event_with_tags(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,text,int,text[]) from public, anon, authenticated;
grant execute on function public.create_place_with_details(text,text,text,text,double precision,double precision,text,text,text,text,text[],jsonb) to authenticated, service_role;
grant execute on function public.update_place_with_tags(uuid,text,text,text,text,double precision,double precision,text,text,text,text[]) to authenticated, service_role;
grant execute on function public.update_event_with_tags(uuid,text,text,uuid,text,text,double precision,double precision,timestamptz,timestamptz,text,int,text[]) to authenticated, service_role;

-- F11: the public RPC reveals only the caller's own status. Internal callers
-- already pass auth.uid(); service/seed operations with no subject retain the
-- existing unrestricted lookup. Admin user listings use their own admin gate.
create or replace function public.is_suspended(p_user uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case when auth.uid() is not null and auth.uid() <> p_user then false
    else exists (select 1 from public.suspensions s where s.user_id = p_user) end;
$$;
revoke all on function public.is_suspended(uuid) from public, anon, authenticated;
grant execute on function public.is_suspended(uuid) to authenticated, service_role;
