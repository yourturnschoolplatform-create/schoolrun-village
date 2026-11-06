-- Day 4 swap integrity remediation: revalidate on acceptance and prevent reserved-leg cancellation.
begin;

create or replace function public.prevent_active_swap_leg_cancellation()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status = 'cancelled' and old.status = 'open' and exists (
    select 1 from public.swap_legs l join public.swap_proposals s on s.id=l.swap_id
    where s.status in ('proposed','accepted') and (l.helper_instance_id=old.id or l.requester_instance_id=old.id)
  ) then raise exception 'an active reciprocal swap reserves this instance' using errcode='55000'; end if;
  return new;
end;
$$;
drop trigger if exists availability_instances_active_swap_guard on public.availability_instances;
create trigger availability_instances_active_swap_guard before update of status on public.availability_instances for each row execute function public.prevent_active_swap_leg_cancellation();

create or replace function public.transition_swap_proposal(p_swap uuid, p_action text)
returns text language plpgsql security definer set search_path = public as $$
declare swap public.swap_proposals%rowtype; declare next_status text; declare leg record;
begin
  if auth.uid() is null or p_action not in ('accept','decline','withdraw') then raise exception 'invalid swap action' using errcode='22023'; end if;
  select * into swap from public.swap_proposals where id=p_swap for update;
  if swap.id is null or not public.is_member(swap.school_id) then raise exception 'swap is unavailable' using errcode='42501'; end if;
  if swap.status='proposed' and swap.expires_at <= now() then update public.swap_proposals set status='expired',updated_at=now() where id=swap.id; return 'expired'; end if;
  if p_action='accept' and swap.recipient_id=auth.uid() and swap.status='proposed' then
    for leg in select l.*, h.status as helper_status, r.status as requester_status, h.service_date as helper_date, r.service_date as requester_date from public.swap_legs l join public.availability_instances h on h.id=l.helper_instance_id join public.availability_instances r on r.id=l.requester_instance_id where l.swap_id=swap.id for update loop
      if leg.helper_status <> 'open' or leg.requester_status <> 'open' or leg.helper_date < public.school_local_today(swap.school_id) or leg.requester_date < public.school_local_today(swap.school_id) then raise exception 'swap leg is unavailable' using errcode='42501'; end if;
    end loop;
    if exists(select 1 from public.match_blocks b where b.school_id=swap.school_id and ((b.blocker_id=swap.proposer_id and b.blocked_id=swap.recipient_id) or (b.blocker_id=swap.recipient_id and b.blocked_id=swap.proposer_id))) then raise exception 'swap is blocked' using errcode='42501'; end if;
    next_status:='accepted';
  elsif p_action='decline' and swap.recipient_id=auth.uid() and swap.status='proposed' then next_status:='declined';
  elsif p_action='withdraw' and swap.proposer_id=auth.uid() and swap.status='proposed' then next_status:='withdrawn';
  else raise exception 'swap transition is unavailable' using errcode='42501'; end if;
  update public.swap_proposals set status=next_status,accepted_at=case when next_status='accepted' then now() else null end,updated_at=now() where id=swap.id;
  if next_status='accepted' and not exists(select 1 from public.analytics_events where actor_id=auth.uid() and event_name='first_swap_accepted') then insert into public.analytics_events(actor_id,school_id,event_name) values(auth.uid(),swap.school_id,'first_swap_accepted'); end if;
  insert into public.audit_logs(actor_id,school_id,action,entity_type,entity_id,payload) values(auth.uid(),swap.school_id,'swap.'||next_status,'swap_proposal',swap.id,jsonb_build_object('outcome',next_status));
  return next_status;
end;
$$;

revoke all on function public.prevent_active_swap_leg_cancellation() from public;
revoke all on function public.transition_swap_proposal(uuid,text) from public;
grant execute on function public.transition_swap_proposal(uuid,text) to authenticated;
commit;
