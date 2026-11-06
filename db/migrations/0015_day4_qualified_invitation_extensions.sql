begin;
create or replace function public.create_school_invitation(p_school_id uuid)
returns table (invitation_id uuid, invitation_token text)
language plpgsql security definer set search_path = pg_catalog as $$
declare token text := encode(extensions.gen_random_bytes(24), 'hex'); created_id uuid;
begin
  if auth.uid() is null or not (public.is_moderator(p_school_id) or public.is_admin()) then raise exception 'school moderator or admin role required' using errcode='42501'; end if;
  insert into public.school_invitations (school_id, invited_by, token_hash, expires_at)
  values (p_school_id, auth.uid(), encode(extensions.digest(token,'sha256'),'hex'), now() + interval '14 days') returning id into created_id;
  insert into public.analytics_events(actor_id,school_id,event_name) values(auth.uid(),p_school_id,'invite_sent');
  insert into public.audit_logs(actor_id,school_id,action,entity_type,entity_id,payload) values(auth.uid(),p_school_id,'invitation.sent','school_invitation',created_id,jsonb_build_object('outcome','sent'));
  return query select created_id, token;
end $$;
create or replace function public.create_household_link_invitation()
returns text language plpgsql security definer set search_path = pg_catalog as $$
declare school uuid; token text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  select m.school_id into school from public.school_memberships m where m.user_id=auth.uid() and m.status='verified' and public.is_member(m.school_id) order by m.created_at limit 1;
  if school is null then raise exception 'verified school membership required' using errcode='42501'; end if;
  token := encode(extensions.gen_random_bytes(24),'hex');
  insert into public.household_link_invitations(school_id,invited_by,token_hash,expires_at) values(school,auth.uid(),encode(extensions.digest(token,'sha256'),'hex'),now()+interval '7 days');
  insert into public.audit_logs(actor_id,school_id,action,entity_type,payload) values(auth.uid(),school,'household.invitation_created','household_link_invitation',jsonb_build_object('outcome','sent'));
  return token;
end $$;
commit;
