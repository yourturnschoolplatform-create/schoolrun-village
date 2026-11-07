-- Task 10.2: system event → owner notifications for handover, swaps, and trust.
-- Uses public.enqueue_user_notification (0049). Phone-free copy only.
-- No amount, price, currency, payment, phone, photo, nickname or live location.
-- search_path is pg_catalog only (no public in path).
begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Extend notification kinds for operational event fan-out
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (kind in (
    'handover_reminder',
    'handover_update',
    'handover_completed',
    'contact_consent_revoked',
    'listing_enquiry',
    'listing_status',
    'community_moderation',
    'swap_accepted',
    'swap_proposed',
    'swap_declined',
    'swap_withdrawn',
    'safety_hold',
    'trust_update',
    'system'
  ));

create or replace function public.enqueue_user_notification(
  p_user_id uuid,
  p_school_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  created public.notifications%rowtype;
begin
  if p_user_id is null or p_school_id is null then
    raise exception 'notification recipient and school are required' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in (
    'handover_reminder', 'handover_update', 'handover_completed', 'contact_consent_revoked',
    'listing_enquiry', 'listing_status', 'community_moderation', 'swap_accepted',
    'swap_proposed', 'swap_declined', 'swap_withdrawn', 'safety_hold', 'trust_update', 'system'
  ) then
    raise exception 'notification kind is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles profile where profile.id = p_user_id
  ) then
    raise exception 'notification recipient unavailable' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.schools school where school.id = p_school_id
  ) then
    raise exception 'notification school unavailable' using errcode = 'P0002';
  end if;
  if not public.community_text_is_allowed(p_title)
    or not public.community_text_is_allowed(p_body) then
    raise exception 'notification text must not include phones, emails, photos or child full names'
      using errcode = '22023';
  end if;
  if not public.notification_metadata_is_safe(coalesce(p_metadata, '{}'::jsonb)) then
    raise exception 'notification metadata is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('yourturn.notification_enqueue', '1', true);
  insert into public.notifications (
    user_id, school_id, kind, title, body, metadata
  ) values (
    p_user_id, p_school_id, p_kind, trim(p_title), trim(p_body),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into created;
  perform pg_catalog.set_config('yourturn.notification_enqueue', '0', true);

  return public.notification_json(created);
end;
$$;
revoke all on function public.enqueue_user_notification(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;

-- Idempotent fan-out used by triggers and system RPCs.
create function public.notify_user_event_once(
  p_user_id uuid,
  p_school_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_entity_type text,
  p_entity_id uuid,
  p_reason_code text,
  p_outcome text default null,
  p_source text default 'system_event'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  meta jsonb;
begin
  if p_user_id is null or p_school_id is null or p_entity_id is null
    or p_entity_type is null or p_reason_code is null then
    return;
  end if;
  if exists (
    select 1
    from public.notifications n
    where n.user_id = p_user_id
      and n.kind = p_kind
      and n.metadata->>'entity_id' = p_entity_id::text
      and n.metadata->>'reason_code' = p_reason_code
  ) then
    return;
  end if;

  meta := pg_catalog.jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_id', p_entity_id::text,
    'reason_code', p_reason_code,
    'source', coalesce(p_source, 'system_event')
  );
  if p_outcome is not null then
    meta := meta || pg_catalog.jsonb_build_object('outcome', p_outcome);
  end if;

  perform public.enqueue_user_notification(
    p_user_id, p_school_id, p_kind, p_title, p_body, meta
  );
end;
$$;
revoke all on function public.notify_user_event_once(
  uuid, uuid, text, text, text, text, uuid, text, text, text
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Handover: partner notice on each confirmation + both on leg completion
-- ---------------------------------------------------------------------------
create function public.notify_handover_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  leg public.swap_legs%rowtype;
  partner_id uuid;
  title text;
  body text;
  reason text;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select source.* into leg from public.swap_legs source where source.id = new.swap_leg_id;
  if leg.id is null then
    return new;
  end if;

  if new.confirmation_kind = 'pickup_done' then
    partner_id := leg.requester_id;
    title := 'Pickup confirmed';
    body := 'The other parent confirmed pickup for your accepted trip.';
    reason := 'pickup_done';
  elsif new.confirmation_kind = 'child_arrived' then
    partner_id := leg.helper_id;
    title := 'Arrival confirmed';
    body := 'The other parent confirmed arrival for your accepted trip.';
    reason := 'child_arrived';
  else
    return new;
  end if;

  perform public.notify_user_event_once(
    partner_id, leg.school_id, 'handover_update',
    title, body, 'swap_leg', leg.id, reason, 'notified', 'handover'
  );
  return new;
end;
$$;
revoke all on function public.notify_handover_confirmation()
  from public, anon, authenticated;

create trigger swap_leg_confirmation_notify
  after insert on public.swap_leg_confirmations
  for each row execute function public.notify_handover_confirmation();
alter table public.swap_leg_confirmations
  enable always trigger swap_leg_confirmation_notify;

-- Fires when completed_at transitions null → set (both confirmations done).
create function public.notify_handover_completion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.completed_at is null or old.completed_at is not null then
    return new;
  end if;

  perform public.notify_user_event_once(
    new.requester_id, new.school_id, 'handover_completed',
    'Handover completed',
    'Both handover steps are done for this trip.',
    'swap_leg', new.id, 'leg_completed', 'completed', 'handover'
  );
  perform public.notify_user_event_once(
    new.helper_id, new.school_id, 'handover_completed',
    'Handover completed',
    'Both handover steps are done for this trip.',
    'swap_leg', new.id, 'leg_completed', 'completed', 'handover'
  );
  return new;
end;
$$;
revoke all on function public.notify_handover_completion()
  from public, anon, authenticated;

create trigger swap_leg_completed_notify
  after update of completed_at on public.swap_legs
  for each row execute function public.notify_handover_completion();
alter table public.swap_legs
  enable always trigger swap_leg_completed_notify;

-- ---------------------------------------------------------------------------
-- 2. Swap propose / accept / decline / withdraw
-- ---------------------------------------------------------------------------
create or replace function public.propose_reciprocal_swap(
  p_viewer_need uuid, p_candidate_help uuid, p_candidate_need uuid, p_viewer_help uuid,
  p_allow_different_date boolean default false
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  a_need public.availability_instances%rowtype;
  b_help public.availability_instances%rowtype;
  b_need public.availability_instances%rowtype;
  a_help public.availability_instances%rowtype;
  cfg public.school_configs%rowtype;
  swap_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_viewer_need::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_candidate_help::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_candidate_need::text));
  perform pg_catalog.pg_advisory_xact_lock(hashtext(p_viewer_help::text));
  select source.* into a_need from public.availability_instances source where source.id = p_viewer_need for update;
  select source.* into b_help from public.availability_instances source where source.id = p_candidate_help for update;
  select source.* into b_need from public.availability_instances source where source.id = p_candidate_need for update;
  select source.* into a_help from public.availability_instances source where source.id = p_viewer_help for update;
  if a_need.id is null or b_help.id is null or b_need.id is null or a_help.id is null
    or a_need.owner_id <> auth.uid() or a_help.owner_id <> auth.uid()
    or a_need.school_id <> b_help.school_id or a_need.school_id <> b_need.school_id
    or a_need.school_id <> a_help.school_id
    or a_need.intent <> 'need_help' or b_help.intent <> 'can_help'
    or b_need.intent <> 'need_help' or a_help.intent <> 'can_help'
    or a_need.status <> 'open' or b_help.status <> 'open'
    or b_need.status <> 'open' or a_help.status <> 'open'
    or b_help.owner_id <> b_need.owner_id or b_help.owner_id = auth.uid()
    or not public.is_member(a_need.school_id)
    or public.user_has_active_safety_hold(auth.uid(), a_need.school_id)
    or public.user_has_active_safety_hold(b_help.owner_id, a_need.school_id)
    or not exists (
      select 1 from public.school_memberships membership
      where membership.school_id = a_need.school_id
        and membership.user_id = b_help.owner_id and membership.status = 'verified'
    )
    or a_need.service_date < public.school_local_today(a_need.school_id)
    or b_help.service_date < public.school_local_today(a_need.school_id)
    or b_need.service_date < public.school_local_today(a_need.school_id)
    or a_help.service_date < public.school_local_today(a_need.school_id)
    or public.is_same_household(auth.uid(), b_help.owner_id) then
    raise exception 'reciprocal candidate is unavailable' using errcode = '42501';
  end if;
  select source.* into cfg from public.school_configs source where source.school_id = a_need.school_id;
  if a_need.direction <> b_help.direction or b_need.direction <> a_help.direction
    or a_need.service_date <> b_help.service_date or b_need.service_date <> a_help.service_date
    or abs(extract(epoch from (a_need.window_start - b_help.window_start))) > cfg.matching_window_minutes * 60
    or abs(extract(epoch from (b_need.window_start - a_help.window_start))) > cfg.matching_window_minutes * 60
    or (cfg.strict_reciprocity_default and not p_allow_different_date
      and b_need.service_date <> a_need.service_date)
    or (p_allow_different_date and (
      not cfg.allow_different_date_reciprocity
      or abs(b_need.service_date - a_need.service_date) > cfg.reciprocal_window_days
    ))
    or exists (
      select 1 from public.match_blocks block
      where block.school_id = a_need.school_id
        and ((block.blocker_id = auth.uid() and block.blocked_id = b_help.owner_id)
          or (block.blocker_id = b_help.owner_id and block.blocked_id = auth.uid()))
    )
    or exists (
      select 1 from public.swap_legs trip
      join public.swap_proposals proposal on proposal.id = trip.swap_id
      where proposal.status in ('proposed', 'accepted')
        and (trip.requester_instance_id in (a_need.id, b_need.id)
          or trip.helper_instance_id in (a_help.id, b_help.id))
    ) then
    raise exception 'reciprocal candidate is unavailable' using errcode = '42501';
  end if;
  insert into public.swap_proposals
    (school_id, proposer_id, recipient_id, status, proposed_at, expires_at)
  values (
    a_need.school_id, auth.uid(), b_help.owner_id, 'proposed', pg_catalog.now(),
    pg_catalog.now() + interval '48 hours'
  )
  returning id into swap_id;
  insert into public.swap_legs
    (swap_id, school_id, helper_instance_id, requester_instance_id, helper_id, requester_id, service_date)
  values
    (swap_id, a_need.school_id, b_help.id, a_need.id, b_help.owner_id, auth.uid(), a_need.service_date),
    (swap_id, a_need.school_id, a_help.id, b_need.id, auth.uid(), b_help.owner_id, b_need.service_date);
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), a_need.school_id, 'swap.proposed', 'swap_proposal', swap_id,
    pg_catalog.jsonb_build_object('outcome', 'proposed')
  );
  perform public.notify_user_event_once(
    b_help.owner_id, a_need.school_id, 'swap_proposed',
    'New swap proposal',
    'Another parent sent you a reciprocal swap proposal.',
    'swap_proposal', swap_id, 'swap_proposed', 'proposed', 'swap'
  );
  return swap_id;
end;
$$;
revoke all on function public.propose_reciprocal_swap(uuid, uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.propose_reciprocal_swap(uuid, uuid, uuid, uuid, boolean)
  to authenticated;

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
  notify_user uuid;
  notify_kind text;
  notify_title text;
  notify_body text;
  notify_reason text;
begin
  if auth.uid() is null or p_action not in ('accept', 'decline', 'withdraw') then
    raise exception 'invalid swap action' using errcode = '22023';
  end if;
  select source.* into swap from public.swap_proposals source where source.id = p_swap for update;
  if swap.id is null or not public.is_member(swap.school_id) then
    raise exception 'swap is unavailable' using errcode = '42501';
  end if;
  if public.user_has_active_safety_hold(auth.uid(), swap.school_id)
    or public.user_has_active_safety_hold(swap.proposer_id, swap.school_id)
    or public.user_has_active_safety_hold(swap.recipient_id, swap.school_id) then
    raise exception 'safety hold disables swaps' using errcode = '42501';
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

  if next_status = 'accepted' then
    notify_user := swap.proposer_id;
    notify_kind := 'swap_accepted';
    notify_title := 'Swap accepted';
    notify_body := 'Your swap proposal was accepted.';
    notify_reason := 'swap_accepted';
  elsif next_status = 'declined' then
    notify_user := swap.proposer_id;
    notify_kind := 'swap_declined';
    notify_title := 'Swap declined';
    notify_body := 'Your swap proposal was declined.';
    notify_reason := 'swap_declined';
  else
    notify_user := swap.recipient_id;
    notify_kind := 'swap_withdrawn';
    notify_title := 'Swap withdrawn';
    notify_body := 'A swap proposal sent to you was withdrawn.';
    notify_reason := 'swap_withdrawn';
  end if;
  perform public.notify_user_event_once(
    notify_user, swap.school_id, notify_kind, notify_title, notify_body,
    'swap_proposal', swap.id, notify_reason, next_status, 'swap'
  );

  return next_status;
end;
$$;
revoke all on function public.transition_swap_proposal(uuid, text)
  from public, anon, authenticated;
grant execute on function public.transition_swap_proposal(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trust: safety hold place/resolve + score delta (no numeric scores in copy)
-- ---------------------------------------------------------------------------
create or replace function public.place_safety_hold(p_subject_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  school uuid;
  hold_id uuid;
  event_time timestamptz := pg_catalog.now();
begin
  if auth.uid() is null or p_subject_user_id is null or p_subject_user_id = auth.uid() then
    raise exception 'safety hold unavailable' using errcode = '22023';
  end if;
  select membership.school_id into school
  from public.school_memberships membership
  where membership.user_id = p_subject_user_id
    and membership.status = 'verified'
    and (public.is_moderator(membership.school_id) or public.is_admin())
  order by membership.created_at, membership.id
  limit 1;
  if school is null then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = school
      and membership.user_id = p_subject_user_id
      and membership.status = 'verified'
  ) then
    raise exception 'verified subject membership required' using errcode = '42501';
  end if;
  insert into public.trust_safety_holds (
    school_id, subject_user_id, placed_by, status, reason_code, placed_at, review_due_at
  ) values (
    school, p_subject_user_id, auth.uid(), 'active', 'safety_hold',
    event_time, event_time + interval '24 hours'
  )
  returning id into hold_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), school, 'trust.safety_hold_placed', 'trust_safety_hold', hold_id,
    pg_catalog.jsonb_build_object('outcome', 'active', 'reason_code', 'safety_hold')
  );
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), school, 'trust.safety_hold_admin_alert', 'trust_safety_hold', hold_id,
    pg_catalog.jsonb_build_object('outcome', 'alerted', 'source', 'moderator')
  );
  perform public.notify_user_event_once(
    p_subject_user_id, school, 'safety_hold',
    'Safety hold placed',
    'A safety hold was placed on your account at this school. Matching is paused.',
    'trust_safety_hold', hold_id, 'safety_hold_placed', 'active', 'trust'
  );
  return hold_id;
end;
$$;
revoke all on function public.place_safety_hold(uuid) from public, anon, authenticated;
grant execute on function public.place_safety_hold(uuid) to authenticated;

create or replace function public.resolve_safety_hold(p_hold_id uuid, p_outcome text)
returns text
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  hold public.trust_safety_holds%rowtype;
  event_time timestamptz := pg_catalog.now();
  next_status text;
begin
  if auth.uid() is null or p_outcome not in ('lift', 'uphold') then
    raise exception 'invalid safety hold resolution' using errcode = '22023';
  end if;
  select source.* into hold from public.trust_safety_holds source
  where source.id = p_hold_id for update;
  if hold.id is null
    or not (public.is_moderator(hold.school_id) or public.is_admin()) then
    raise exception 'school moderator or admin role required' using errcode = '42501';
  end if;
  if hold.status <> 'active' then
    raise exception 'safety hold already resolved' using errcode = '22023';
  end if;
  next_status := case when p_outcome = 'lift' then 'lifted' else 'upheld' end;
  update public.trust_safety_holds as target
  set status = next_status, resolved_at = event_time, resolved_by = auth.uid()
  where target.id = hold.id;
  if next_status = 'upheld' then
    perform public.apply_trust_score_delta(
      hold.subject_user_id, hold.school_id,
      public.trust_policy_delta(hold.school_id, 'reviewed_safety_violation'),
      'reviewed_safety_violation', 'trust_safety_hold', hold.id
    );
  end if;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), hold.school_id, 'trust.safety_hold_resolved', 'trust_safety_hold', hold.id,
    pg_catalog.jsonb_build_object(
      'previous_status', 'active', 'next_status', next_status, 'outcome', p_outcome
    )
  );
  perform public.notify_user_event_once(
    hold.subject_user_id, hold.school_id, 'safety_hold',
    'Safety hold resolved',
    'A safety hold on your account was resolved.',
    'trust_safety_hold', hold.id, 'safety_hold_resolved', next_status, 'trust'
  );
  return next_status;
end;
$$;
revoke all on function public.resolve_safety_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_safety_hold(uuid, text) to authenticated;

create or replace function public.apply_trust_score_delta(
  p_subject_user_id uuid,
  p_school_id uuid,
  p_delta smallint,
  p_reason_code text,
  p_source_entity_type text,
  p_source_entity_id uuid
) returns smallint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  current_score smallint;
  next_score smallint;
  policy_version integer;
  raw_score integer;
begin
  if p_subject_user_id is null or p_school_id is null or p_delta is null or p_delta = 0 then
    raise exception 'trust score delta is invalid' using errcode = '22023';
  end if;
  if p_reason_code is null or p_source_entity_type is null or p_source_entity_id is null then
    raise exception 'trust score delta is invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.school_id = p_school_id
      and membership.user_id = p_subject_user_id
      and membership.status = 'verified'
  ) then
    raise exception 'verified school membership required for trust scoring' using errcode = '42501';
  end if;
  select version into policy_version
  from public.trust_policy_versions
  where is_published and (school_id = p_school_id or school_id is null)
  order by case when school_id = p_school_id then 0 else 1 end, version desc
  limit 1;

  select profile.trust_score into current_score
  from public.profiles profile
  where profile.id = p_subject_user_id
  for update;
  if current_score is null then
    raise exception 'profile required for trust scoring' using errcode = 'P0002';
  end if;
  raw_score := current_score::integer + p_delta::integer;
  next_score := case
    when raw_score > 150 then 150::smallint
    when raw_score < -100 then (-100)::smallint
    else raw_score::smallint
  end;

  insert into public.trust_score_events (
    school_id, subject_user_id, delta, score_after, reason_code,
    source_entity_type, source_entity_id, policy_version
  ) values (
    p_school_id, p_subject_user_id, p_delta, next_score, p_reason_code,
    p_source_entity_type, p_source_entity_id, policy_version
  )
  on conflict (source_entity_type, source_entity_id, reason_code) do nothing;
  if not found then
    select profile.trust_score into next_score
    from public.profiles profile
    where profile.id = p_subject_user_id;
    return next_score;
  end if;

  update public.profiles as profile
  set trust_score = next_score, updated_at = pg_catalog.now()
  where profile.id = p_subject_user_id;
  insert into public.audit_logs (actor_id, school_id, action, entity_type, entity_id, payload)
  values (
    auth.uid(), p_school_id, 'trust.score_adjusted', 'profile', p_subject_user_id,
    pg_catalog.jsonb_build_object(
      'reason_code', p_reason_code,
      'outcome', 'score_adjusted',
      'source', p_source_entity_type
    )
  );
  perform public.notify_user_event_once(
    p_subject_user_id, p_school_id, 'trust_update',
    'Trust record updated',
    'Your school trust record was updated.',
    p_source_entity_type, p_source_entity_id, p_reason_code, 'score_adjusted', 'trust'
  );
  return next_score;
end;
$$;
revoke all on function public.apply_trust_score_delta(uuid, uuid, smallint, text, text, uuid)
  from public, anon, authenticated;

commit;
