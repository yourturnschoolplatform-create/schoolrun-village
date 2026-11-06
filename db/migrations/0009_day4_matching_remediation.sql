-- Day 4 matching command remediation: IDs-only view event and private block writes.
begin;

create or replace function public.record_first_match_viewed()
returns void language plpgsql security definer set search_path=public as $$
declare school uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  select school_id into school from public.school_memberships where user_id=auth.uid() and status='verified' and public.is_member(school_id) order by created_at limit 1;
  if school is not null and not exists(select 1 from public.analytics_events where actor_id=auth.uid() and event_name='first_match_viewed') then
    insert into public.analytics_events(actor_id,school_id,event_name) values(auth.uid(),school,'first_match_viewed');
  end if;
end;
$$;

create or replace function public.block_match_user(p_blocked uuid)
returns void language plpgsql security definer set search_path=public as $$
declare school uuid;
begin
  if auth.uid() is null or p_blocked is null or p_blocked=auth.uid() then raise exception 'invalid match block' using errcode='22023'; end if;
  select school_id into school from public.school_memberships where user_id=auth.uid() and status='verified' and public.is_member(school_id) order by created_at limit 1;
  if school is null or not exists(select 1 from public.school_memberships membership where membership.school_id=school and membership.user_id=p_blocked and membership.status='verified') then raise exception 'match block is unavailable' using errcode='42501'; end if;
  insert into public.match_blocks(school_id,blocker_id,blocked_id) values(school,auth.uid(),p_blocked) on conflict do nothing;
  insert into public.audit_logs(actor_id,school_id,action,entity_type,payload) values(auth.uid(),school,'match.blocked','match_block',jsonb_build_object('outcome','blocked'));
end;
$$;

revoke all on function public.record_first_match_viewed(),public.block_match_user(uuid) from public;
grant execute on function public.record_first_match_viewed(),public.block_match_user(uuid) to authenticated;
commit;
