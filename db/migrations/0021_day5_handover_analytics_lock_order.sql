-- Deterministic actor-key ordering prevents cross-proposal analytics lock cycles.
begin;
create or replace function public.record_leg_confirmation(p_leg_id uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  caller public.school_memberships%rowtype;
  confirmation public.swap_leg_confirmations%rowtype;
  proposal_id uuid;
  number_confirmed integer;
  finish_time timestamptz;
begin
  if auth.uid() is null or p_kind not in ('pickup_done','child_arrived') then
    raise exception 'handover is unavailable' using errcode='42501'; end if;
  select swap_id into proposal_id from public.swap_legs where id=p_leg_id;
  select * into proposal from public.swap_proposals where id=proposal_id for update;
  select * into leg from public.swap_legs where id=p_leg_id for update;
  select * into caller from public.school_memberships m where m.school_id=leg.school_id and m.user_id=auth.uid();
  if leg.id is null or proposal.status is distinct from 'accepted'
    or caller.id is null or proposal.school_id is distinct from leg.school_id
    or auth.uid() is distinct from (case when p_kind='pickup_done' then leg.helper_id else leg.requester_id end)
    or not public.is_member(leg.school_id) or not public.contact_member_is_active(caller.id,leg.school_id)
  then raise exception 'handover is unavailable' using errcode='42501'; end if;
  select * into confirmation from public.swap_leg_confirmations c
    where c.swap_leg_id=leg.id and c.confirmation_kind=p_kind;
  if confirmation.id is null then
    insert into public.swap_leg_confirmations (school_id,swap_leg_id,member,confirmation_kind,confirmed_at)
      values (leg.school_id,leg.id,caller.id,p_kind,pg_catalog.clock_timestamp()) returning * into confirmation;
    insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload)
      values (auth.uid(),leg.school_id,'handover.'||p_kind,'swap_leg',leg.id,'{}'::jsonb);
  end if;
  select pg_catalog.count(*)::integer,pg_catalog.max(c.confirmed_at)
    into number_confirmed,finish_time from public.swap_leg_confirmations c where c.swap_leg_id=leg.id;
  if number_confirmed=2 and leg.completed_at is null then
    update public.swap_legs set completed_at=finish_time where id=leg.id returning * into leg;
    insert into public.analytics_events (actor_id,school_id,event_name)
      select m.user_id,leg.school_id,'first_trip_completed'
      from public.swap_leg_confirmations c join public.school_memberships m on m.id=c.member
        and m.school_id=leg.school_id where c.swap_leg_id=leg.id
      order by m.user_id
      on conflict do nothing;
    insert into public.audit_logs (actor_id,school_id,action,entity_type,entity_id,payload)
      values (auth.uid(),leg.school_id,'handover.leg_completed','swap_leg',leg.id,'{}'::jsonb);
  elsif number_confirmed=1 then
    perform public.maybe_record_handover_reminder(leg.id);
  end if;
  return pg_catalog.jsonb_build_object('legId',leg.id,'confirmationKind',p_kind,
    'confirmedAt',confirmation.confirmed_at,'completedAt',leg.completed_at);
end;
$$;
revoke all on function public.record_leg_confirmation(uuid,text) from public,anon,authenticated;
commit;
