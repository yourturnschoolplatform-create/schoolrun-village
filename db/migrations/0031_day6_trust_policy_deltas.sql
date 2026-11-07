-- Task 6.2: policy-driven trust deltas from completed trips, schedule/swap
-- cancellations, and eligible urgent cover on accept. Idempotent once-per-fact.
-- Late notice, no-show, false-report and safety-hold workflows remain Task 6.3.
begin;
set local search_path = pg_catalog;

create function public.trust_published_policy(p_school_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select definition
  from public.trust_policy_versions
  where is_published and (school_id = p_school_id or school_id is null)
  order by case when school_id = p_school_id then 0 else 1 end, version desc
  limit 1;
$$;
revoke all on function public.trust_published_policy(uuid) from public, anon, authenticated;

create function public.trust_policy_delta(p_school_id uuid, p_reason_code text)
returns smallint
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  policy jsonb;
  raw text;
  delta integer;
begin
  if p_reason_code is null then
    raise exception 'trust reason code required' using errcode = '22023';
  end if;
  policy := public.trust_published_policy(p_school_id);
  if policy is null then
    raise exception 'published trust policy required' using errcode = 'P0002';
  end if;
  raw := policy -> 'changes' ->> p_reason_code;
  if raw is null or raw !~ '^-?[0-9]+$' then
    raise exception 'trust policy change is missing' using errcode = '22023';
  end if;
  delta := raw::integer;
  if delta = 0 or delta < -100 or delta > 100 then
    raise exception 'trust policy change is invalid' using errcode = '22023';
  end if;
  return delta::smallint;
end;
$$;
revoke all on function public.trust_policy_delta(uuid, text) from public, anon, authenticated;

-- Hours from event time until the instance pickup instant in the school timezone.
create function public.trust_hours_until_instance(
  p_school_id uuid,
  p_service_date date,
  p_window_start time,
  p_at timestamptz
) returns numeric
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select extract(epoch from (
    pg_catalog.timezone(school.timezone, p_service_date + p_window_start) - p_at
  )) / 3600.0
  from public.schools school
  where school.id = p_school_id;
$$;
revoke all on function public.trust_hours_until_instance(uuid, date, time, timestamptz)
  from public, anon, authenticated;

create function public.trust_cancel_reason_for_hours(p_hours numeric)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_hours is null then null
    when p_hours < 2 then 'cancel_under_2h'
    when p_hours < 24 then 'cancel_under_24h'
    else null
  end;
$$;
revoke all on function public.trust_cancel_reason_for_hours(numeric)
  from public, anon, authenticated;

create function public.post_trust_completed_trip()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.completed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.completed_at is not null then
    return new;
  end if;
  perform public.apply_trust_score_delta(
    new.helper_id,
    new.school_id,
    public.trust_policy_delta(new.school_id, 'completed_trip'),
    'completed_trip',
    'swap_leg',
    new.id
  );
  return new;
end;
$$;
revoke all on function public.post_trust_completed_trip() from public, anon, authenticated;

-- Runs after ledger posting so a failed trust write rolls back the completion.
create trigger swap_leg_completed_to_trust
  after insert or update on public.swap_legs
  for each row execute function public.post_trust_completed_trip();
alter table public.swap_legs enable always trigger swap_leg_completed_to_trust;

create function public.post_trust_schedule_cancellation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  instance public.availability_instances%rowtype;
  hours_left numeric;
  reason text;
begin
  select source.* into instance
  from public.availability_instances source
  where source.id = new.instance_id;
  if instance.id is null then
    return new;
  end if;
  hours_left := public.trust_hours_until_instance(
    new.school_id, instance.service_date, instance.window_start, new.cancelled_at
  );
  reason := public.trust_cancel_reason_for_hours(hours_left);
  if reason is null then
    return new;
  end if;
  perform public.apply_trust_score_delta(
    new.owner_id,
    new.school_id,
    public.trust_policy_delta(new.school_id, reason),
    reason,
    'schedule_cancellation_event',
    new.id
  );
  return new;
end;
$$;
revoke all on function public.post_trust_schedule_cancellation() from public, anon, authenticated;

create trigger schedule_cancellation_to_trust
  after insert on public.schedule_cancellation_events
  for each row execute function public.post_trust_schedule_cancellation();
alter table public.schedule_cancellation_events
  enable always trigger schedule_cancellation_to_trust;

create function public.post_trust_swap_cancellation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  actor_user uuid;
  hours_left numeric;
  reason text;
begin
  select membership.user_id into actor_user
  from public.school_memberships membership
  where membership.id = new.actor_membership;
  if actor_user is null then
    return new;
  end if;
  select min(public.trust_hours_until_instance(
    new.school_id, leg.service_date, helper.window_start, new.created_at
  )) into hours_left
  from public.swap_legs leg
  join public.availability_instances helper on helper.id = leg.helper_instance_id
  where leg.swap_id = new.swap_id
    and leg.completed_at is null;
  reason := public.trust_cancel_reason_for_hours(hours_left);
  if reason is null then
    return new;
  end if;
  perform public.apply_trust_score_delta(
    actor_user,
    new.school_id,
    public.trust_policy_delta(new.school_id, reason),
    reason,
    'swap_cancellation_event',
    new.id
  );
  return new;
end;
$$;
revoke all on function public.post_trust_swap_cancellation() from public, anon, authenticated;

create trigger swap_cancellation_to_trust
  after insert on public.swap_cancellation_events
  for each row execute function public.post_trust_swap_cancellation();
alter table public.swap_cancellation_events
  enable always trigger swap_cancellation_to_trust;

create function public.post_trust_urgent_cover_for_swap(p_swap_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  swap public.swap_proposals%rowtype;
  policy jsonb;
  within_hours numeric;
  weekly_limit integer;
  same_household_allowed boolean;
  leg record;
  hours_left numeric;
  covers_this_week integer;
begin
  select source.* into swap from public.swap_proposals source where source.id = p_swap_id;
  if swap.id is null or swap.status <> 'accepted' or swap.accepted_at is null then
    return;
  end if;
  policy := public.trust_published_policy(swap.school_id);
  if policy is null then
    return;
  end if;
  within_hours := coalesce((policy -> 'urgent_cover' ->> 'posted_within_hours')::numeric, 4);
  weekly_limit := coalesce((policy -> 'urgent_cover' ->> 'weekly_limit')::integer, 2);
  same_household_allowed := coalesce((policy -> 'urgent_cover' ->> 'same_household_allowed')::boolean, false);

  for leg in
    select
      trip.id as leg_id,
      trip.helper_id,
      trip.requester_id,
      trip.school_id,
      trip.service_date,
      need.window_start
    from public.swap_legs trip
    join public.availability_instances need on need.id = trip.requester_instance_id
    where trip.swap_id = swap.id
  loop
    if not same_household_allowed
      and public.is_same_household(leg.helper_id, leg.requester_id) then
      continue;
    end if;
    hours_left := public.trust_hours_until_instance(
      leg.school_id, leg.service_date, leg.window_start, swap.accepted_at
    );
    if hours_left is null or hours_left < 0 or hours_left > within_hours then
      continue;
    end if;
    select count(*)::integer into covers_this_week
    from public.trust_score_events event
    where event.subject_user_id = leg.helper_id
      and event.reason_code = 'urgent_cover'
      and event.created_at >= swap.accepted_at - interval '7 days';
    if covers_this_week >= weekly_limit then
      continue;
    end if;
    perform public.apply_trust_score_delta(
      leg.helper_id,
      leg.school_id,
      public.trust_policy_delta(leg.school_id, 'urgent_cover'),
      'urgent_cover',
      'swap_leg',
      leg.leg_id
    );
  end loop;
end;
$$;
revoke all on function public.post_trust_urgent_cover_for_swap(uuid)
  from public, anon, authenticated;

create or replace function public.transition_swap_proposal(p_swap uuid, p_action text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  swap public.swap_proposals%rowtype;
  next_status text;
  leg record;
begin
  if auth.uid() is null or p_action not in ('accept', 'decline', 'withdraw') then
    raise exception 'invalid swap action' using errcode = '22023';
  end if;
  select source.* into swap from public.swap_proposals source where source.id = p_swap for update;
  if swap.id is null or not public.is_member(swap.school_id) then
    raise exception 'swap is unavailable' using errcode = '42501';
  end if;
  if swap.status = 'proposed' and swap.expires_at <= pg_catalog.now() then
    update public.swap_proposals as proposal
    set status = 'expired', updated_at = pg_catalog.now()
    where proposal.id = swap.id;
    return 'expired';
  end if;
  if p_action = 'accept' and swap.recipient_id = auth.uid() and swap.status = 'proposed' then
    for leg in
      select
        trip.*,
        helper.status as helper_status,
        requester.status as requester_status,
        helper.service_date as helper_date,
        requester.service_date as requester_date
      from public.swap_legs trip
      join public.availability_instances helper on helper.id = trip.helper_instance_id
      join public.availability_instances requester on requester.id = trip.requester_instance_id
      where trip.swap_id = swap.id
      for update of trip
    loop
      if leg.helper_status <> 'open' or leg.requester_status <> 'open'
        or leg.helper_date < public.school_local_today(swap.school_id)
        or leg.requester_date < public.school_local_today(swap.school_id) then
        raise exception 'swap leg is unavailable' using errcode = '42501';
      end if;
    end loop;
    if exists (
      select 1 from public.match_blocks block
      where block.school_id = swap.school_id
        and (
          (block.blocker_id = swap.proposer_id and block.blocked_id = swap.recipient_id)
          or (block.blocker_id = swap.recipient_id and block.blocked_id = swap.proposer_id)
        )
    ) then
      raise exception 'swap is blocked' using errcode = '42501';
    end if;
    next_status := 'accepted';
  elsif p_action = 'decline' and swap.recipient_id = auth.uid() and swap.status = 'proposed' then
    next_status := 'declined';
  elsif p_action = 'withdraw' and swap.proposer_id = auth.uid() and swap.status = 'proposed' then
    next_status := 'withdrawn';
  else
    raise exception 'swap transition is unavailable' using errcode = '42501';
  end if;
  update public.swap_proposals as proposal
  set
    status = next_status,
    accepted_at = case when next_status = 'accepted' then pg_catalog.now() else null end,
    updated_at = pg_catalog.now()
  where proposal.id = swap.id;
  if next_status = 'accepted'
    and not exists (
      select 1 from public.analytics_events event
      where event.actor_id = auth.uid() and event.event_name = 'first_swap_accepted'
    ) then
    insert into public.analytics_events (actor_id, school_id, event_name)
    values (auth.uid(), swap.school_id, 'first_swap_accepted');
  end if;
  if next_status = 'accepted' then
    perform public.post_trust_urgent_cover_for_swap(swap.id);
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), swap.school_id, 'swap.' || next_status, 'swap_proposal', swap.id,
    pg_catalog.jsonb_build_object('outcome', next_status)
  );
  return next_status;
end;
$$;
revoke all on function public.transition_swap_proposal(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_swap_proposal(uuid, text) to authenticated;

commit;
