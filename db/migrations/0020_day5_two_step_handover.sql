-- Task 5.3. Confirmations and reminder records only; delivery is Day 8.
begin;
set local search_path = pg_catalog;

alter table public.swap_legs add column expected_arrival_at timestamptz;
update public.swap_legs leg set expected_arrival_at=pg_catalog.timezone(school.timezone,
  instance.service_date + instance.window_end)
from public.availability_instances instance,public.schools school
where instance.id=leg.requester_instance_id and school.id=leg.school_id;

create table public.swap_leg_confirmations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  swap_leg_id uuid not null,
  member uuid not null,
  confirmation_kind text not null check (confirmation_kind in ('pickup_done','child_arrived')),
  confirmed_at timestamptz not null,
  unique (swap_leg_id,confirmation_kind),
  foreign key (swap_leg_id,school_id) references public.swap_legs(id,school_id),
  foreign key (member,school_id) references public.school_memberships(id,school_id)
);
create table public.swap_leg_reminders (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  swap_leg_id uuid not null,
  recipient_membership uuid not null,
  missing_confirmation text not null check (missing_confirmation in ('pickup_done','child_arrived')),
  expected_arrival_at timestamptz not null,
  due_at timestamptz not null,
  created_at timestamptz not null,
  unique (swap_leg_id,missing_confirmation),
  foreign key (swap_leg_id,school_id) references public.swap_legs(id,school_id),
  foreign key (recipient_membership,school_id) references public.school_memberships(id,school_id),
  check (due_at=expected_arrival_at + interval '30 minutes'),
  check (created_at>=due_at)
);
comment on table public.swap_leg_reminders is
  'Immutable due records only. Day 8 delivery must recheck accepted/incomplete state.';
comment on column public.swap_legs.expected_arrival_at is
  'Default: end of recipient requested window in school timezone; frozen once handover starts.';

create function public.guard_handover_history()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  membership public.school_memberships%rowtype;
  existing_kind text;
  number_confirmed integer;
begin
  if tg_table_name='swap_legs' then
    if tg_op='INSERT' then
      if new.expected_arrival_at is null then
        select pg_catalog.timezone(s.timezone,i.service_date+i.window_end)
          into new.expected_arrival_at
        from public.availability_instances i join public.schools s on s.id=new.school_id
        where i.id=new.requester_instance_id;
      end if;
    elsif (new.id,new.school_id,new.swap_id,new.helper_id,new.requester_id,
        new.helper_instance_id,new.requester_instance_id,new.service_date,new.expected_arrival_at)
      is distinct from
       (old.id,old.school_id,old.swap_id,old.helper_id,old.requester_id,
        old.helper_instance_id,old.requester_instance_id,old.service_date,old.expected_arrival_at)
      and (old.completed_at is not null or exists (
        select 1 from public.swap_leg_confirmations c where c.swap_leg_id=old.id
      )) then
      raise exception 'handover source identity and expected arrival are immutable' using errcode='55000';
    end if;
    return new;
  end if;
  if tg_op<>'INSERT' then
    raise exception 'handover history is immutable' using errcode='55000';
  end if;
  select * into leg from public.swap_legs where id=new.swap_leg_id;
  select * into proposal from public.swap_proposals where id=leg.swap_id;
  if leg.id is null or proposal.status is distinct from 'accepted'
    or leg.school_id is distinct from new.school_id
    or proposal.school_id is distinct from leg.school_id then
    raise exception 'accepted same-school handover required' using errcode='23514';
  end if;
  if tg_table_name='swap_leg_confirmations' then
    select * into membership from public.school_memberships where id=new.member;
    if membership.school_id is distinct from leg.school_id
      or membership.user_id is distinct from (case when new.confirmation_kind='pickup_done'
        then leg.helper_id else leg.requester_id end)
      or new.confirmed_at<proposal.accepted_at
      or new.confirmed_at>pg_catalog.clock_timestamp() then
      raise exception 'confirmation must match its source role and server time' using errcode='23514';
    end if;
  else
    select pg_catalog.count(*)::integer,pg_catalog.min(c.confirmation_kind)
      into number_confirmed,existing_kind from public.swap_leg_confirmations c
      where c.swap_leg_id=leg.id;
    select * into membership from public.school_memberships where id=new.recipient_membership;
    if number_confirmed<>1 or leg.completed_at is not null
      or new.missing_confirmation is distinct from (case when existing_kind='pickup_done'
        then 'child_arrived' else 'pickup_done' end)
      or membership.school_id is distinct from leg.school_id
      or membership.user_id is distinct from (case when existing_kind='pickup_done'
        then leg.requester_id else leg.helper_id end)
      or new.expected_arrival_at is distinct from leg.expected_arrival_at
      or new.due_at is distinct from leg.expected_arrival_at + interval '30 minutes'
      or new.due_at>pg_catalog.clock_timestamp() or new.created_at>pg_catalog.clock_timestamp()
    then raise exception 'only an overdue missing second confirmation can be reminded' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_handover_history() from public,anon,authenticated;
create trigger swap_leg_handover_source_guard before insert or update on public.swap_legs
  for each row execute function public.guard_handover_history();
create trigger handover_confirmation_guard before insert or update or delete on public.swap_leg_confirmations
  for each row execute function public.guard_handover_history();
create trigger handover_confirmation_truncate_guard before truncate on public.swap_leg_confirmations
  for each statement execute function public.guard_handover_history();
create trigger handover_reminder_guard before insert or update or delete on public.swap_leg_reminders
  for each row execute function public.guard_handover_history();
create trigger handover_reminder_truncate_guard before truncate on public.swap_leg_reminders
  for each statement execute function public.guard_handover_history();
alter table public.swap_legs enable always trigger swap_leg_handover_source_guard;
alter table public.swap_leg_confirmations enable always trigger handover_confirmation_guard;
alter table public.swap_leg_confirmations enable always trigger handover_confirmation_truncate_guard;
alter table public.swap_leg_reminders enable always trigger handover_reminder_guard;
alter table public.swap_leg_reminders enable always trigger handover_reminder_truncate_guard;

alter table public.swap_leg_confirmations enable row level security;
alter table public.swap_leg_reminders enable row level security;
revoke all on table public.swap_leg_confirmations,public.swap_leg_reminders from public,anon,authenticated;
grant select on table public.swap_leg_confirmations,public.swap_leg_reminders to authenticated;
create policy handover_confirmations_participant on public.swap_leg_confirmations
for select to authenticated using (
  public.is_member(school_id) and exists (
    select 1 from public.swap_legs l join public.profiles p on p.id=auth.uid()
    where l.id=swap_leg_confirmations.swap_leg_id and l.school_id=swap_leg_confirmations.school_id
      and auth.uid() in (l.helper_id,l.requester_id) and not p.admin_suspended
  )
);
create policy handover_reminders_participant on public.swap_leg_reminders
for select to authenticated using (
  public.is_member(school_id) and exists (
    select 1 from public.swap_legs l join public.profiles p on p.id=auth.uid()
    where l.id=swap_leg_reminders.swap_leg_id and l.school_id=swap_leg_reminders.school_id
      and auth.uid() in (l.helper_id,l.requester_id) and not p.admin_suspended
  )
);

-- Private operation: callers must already be scoped by the participant wrapper
-- or the service-only sweep. Proposal-before-leg locks match consent withdrawal.
create function public.maybe_record_handover_reminder(p_leg_id uuid)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare
  leg public.swap_legs%rowtype;
  proposal public.swap_proposals%rowtype;
  proposal_id uuid;
  number_confirmed integer;
  existing_kind text;
  target uuid;
  changed integer;
  event_time timestamptz;
begin
  select swap_id into proposal_id from public.swap_legs where id=p_leg_id;
  select * into proposal from public.swap_proposals where id=proposal_id for update;
  select * into leg from public.swap_legs where id=p_leg_id for update;
  event_time:=pg_catalog.clock_timestamp();
  if leg.id is null or proposal.status is distinct from 'accepted' or leg.completed_at is not null
    or leg.expected_arrival_at is null or event_time<leg.expected_arrival_at+interval '30 minutes'
  then return 0; end if;
  select pg_catalog.count(*)::integer,pg_catalog.min(c.confirmation_kind)
    into number_confirmed,existing_kind from public.swap_leg_confirmations c where c.swap_leg_id=leg.id;
  if number_confirmed<>1 then return 0; end if;
  select m.id into target from public.school_memberships m where m.school_id=leg.school_id
    and m.user_id=case when existing_kind='pickup_done' then leg.requester_id else leg.helper_id end;
  if target is null then return 0; end if;
  insert into public.swap_leg_reminders
    (school_id,swap_leg_id,recipient_membership,missing_confirmation,expected_arrival_at,due_at,created_at)
  values (leg.school_id,leg.id,target,
    case when existing_kind='pickup_done' then 'child_arrived' else 'pickup_done' end,
    leg.expected_arrival_at,leg.expected_arrival_at+interval '30 minutes',event_time)
  on conflict (swap_leg_id,missing_confirmation) do nothing;
  get diagnostics changed=row_count;
  return changed;
end;
$$;
revoke all on function public.maybe_record_handover_reminder(uuid) from public,anon,authenticated;

create function public.refresh_my_handover_reminders()
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare target record; changed integer:=0;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  for target in
    select l.id from public.swap_legs l join public.swap_proposals s on s.id=l.swap_id
    join public.school_memberships m on m.school_id=l.school_id and m.user_id=auth.uid()
    where auth.uid() in (l.helper_id,l.requester_id) and s.status='accepted'
      and l.completed_at is null and l.expected_arrival_at+interval '30 minutes'<=pg_catalog.clock_timestamp()
      and public.is_member(l.school_id) and public.contact_member_is_active(m.id,l.school_id)
    order by s.id,l.id limit 500
  loop changed:=changed+public.maybe_record_handover_reminder(target.id); end loop;
  return changed;
end;
$$;
revoke all on function public.refresh_my_handover_reminders() from public,anon,authenticated;
grant execute on function public.refresh_my_handover_reminders() to authenticated;

create function public.enqueue_due_handover_reminders()
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare target record; changed integer:=0;
begin
  for target in
    select l.id from public.swap_legs l join public.swap_proposals s on s.id=l.swap_id
    where s.status='accepted' and l.completed_at is null
      and l.expected_arrival_at+interval '30 minutes'<=pg_catalog.clock_timestamp()
      and (select pg_catalog.count(*) from public.swap_leg_confirmations c where c.swap_leg_id=l.id)=1
      and not exists (select 1 from public.swap_leg_reminders r where r.swap_leg_id=l.id)
    order by s.id,l.id limit 500
  loop changed:=changed+public.maybe_record_handover_reminder(target.id); end loop;
  return changed;
end;
$$;
revoke all on function public.enqueue_due_handover_reminders() from public,anon,authenticated;
grant execute on function public.enqueue_due_handover_reminders() to service_role;

alter table public.analytics_events drop constraint analytics_events_allowed_name_check;
alter table public.analytics_events add constraint analytics_events_allowed_name_check check (
  event_name in ('signed_up','email_verified','school_joined','approved','child_added',
    'declaration_signed','invite_sent','invite_joined','first_listing_created',
    'first_match_viewed','first_swap_accepted','first_trip_completed')
);
create unique index analytics_first_trip_completed_once on public.analytics_events(actor_id,event_name)
  where event_name='first_trip_completed';

create function public.record_leg_confirmation(p_leg_id uuid,p_kind text)
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
    -- Each actor comes from their own immutable auth.uid()-derived confirmation.
    insert into public.analytics_events (actor_id,school_id,event_name)
      select m.user_id,leg.school_id,'first_trip_completed'
      from public.swap_leg_confirmations c join public.school_memberships m on m.id=c.member
        and m.school_id=leg.school_id where c.swap_leg_id=leg.id
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
create function public.confirm_pickup_done(p_leg_id uuid)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select public.record_leg_confirmation(p_leg_id,'pickup_done');
$$;
revoke all on function public.confirm_pickup_done(uuid) from public,anon,authenticated;
grant execute on function public.confirm_pickup_done(uuid) to authenticated;
create function public.confirm_child_arrived(p_leg_id uuid)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select public.record_leg_confirmation(p_leg_id,'child_arrived');
$$;
revoke all on function public.confirm_child_arrived(uuid) from public,anon,authenticated;
grant execute on function public.confirm_child_arrived(uuid) to authenticated;

-- Lock-wait-safe completion validation. The identity checks and immutable
-- ledger logic from 0018 are unchanged; actual server clock replaces statement
-- start as the upper bound for freshly confirmed timestamps.
create or replace function public.record_completed_swap_leg()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  proposal public.swap_proposals%rowtype;
  debtor uuid;
  provider uuid;
begin
  if tg_op='UPDATE' and old.completed_at is not null then
    if (new.id,new.school_id,new.swap_id,new.helper_id,new.requester_id,
        new.helper_instance_id,new.requester_instance_id,new.service_date,new.completed_at)
      is distinct from
       (old.id,old.school_id,old.swap_id,old.helper_id,old.requester_id,
        old.helper_instance_id,old.requester_instance_id,old.service_date,old.completed_at)
    then raise exception 'completed trip identity and completion are immutable' using errcode='55000'; end if;
    return new;
  end if;
  if new.completed_at is null then return new; end if;
  select * into proposal from public.swap_proposals where id=new.swap_id;
  if proposal.id is null or proposal.status<>'accepted' or proposal.school_id<>new.school_id
    or not (new.helper_id in (proposal.proposer_id,proposal.recipient_id)
      and new.requester_id in (proposal.proposer_id,proposal.recipient_id))
    or new.completed_at<proposal.accepted_at or new.completed_at>pg_catalog.clock_timestamp()
    or not exists (
      select 1 from public.availability_instances h join public.availability_instances r on r.id=new.requester_instance_id
      where h.id=new.helper_instance_id and h.owner_id=new.helper_id and r.owner_id=new.requester_id
        and h.school_id=new.school_id and r.school_id=new.school_id
        and h.intent='can_help' and r.intent='need_help' and h.direction=r.direction
        and h.service_date=new.service_date and r.service_date=new.service_date
    ) then raise exception 'only an accepted same-school trip can complete' using errcode='23514'; end if;
  select id into debtor from public.school_memberships where school_id=new.school_id
    and user_id=new.requester_id and status='verified';
  select id into provider from public.school_memberships where school_id=new.school_id
    and user_id=new.helper_id and status='verified';
  if debtor is null or provider is null or debtor=provider then
    raise exception 'completed trip requires two verified same-school memberships' using errcode='23514'; end if;
  insert into public.swap_ledger_entries
    (school_id,from_membership,to_membership,swap_leg_id,trip_count_delta,created_at,expires_at,reminder_due_at)
  values (new.school_id,debtor,provider,new.id,1,new.completed_at,
    new.completed_at+interval '1344 hours',new.completed_at+interval '1008 hours')
  on conflict (swap_leg_id) do nothing;
  insert into public.audit_logs(actor_id,school_id,action,entity_type,entity_id,payload)
    values (auth.uid(),new.school_id,'ledger.trip_recorded','swap_leg',new.id,'{}'::jsonb);
  return new;
end;
$$;
revoke all on function public.record_completed_swap_leg() from public,anon,authenticated;
commit;
