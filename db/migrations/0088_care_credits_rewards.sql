-- Care Credits & Village Helper Reward Loop for Instant Pickup.
-- Idempotent. Apply in Supabase SQL Editor, then confirm PostgREST reload.

begin;
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- Profile wallet columns
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists care_credits integer not null default 0;

alter table public.profiles
  alter column care_credits set default 0;

alter table public.profiles
  add column if not exists completed_rides_provided integer not null default 0;

alter table public.profiles
  add column if not exists priority_sos_passes integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'profiles_care_credits_nonneg'
  ) then
    alter table public.profiles
      add constraint profiles_care_credits_nonneg check (care_credits >= 0);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'profiles_completed_rides_provided_nonneg'
  ) then
    alter table public.profiles
      add constraint profiles_completed_rides_provided_nonneg check (completed_rides_provided >= 0);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'profiles_priority_sos_passes_nonneg'
  ) then
    alter table public.profiles
      add constraint profiles_priority_sos_passes_nonneg check (priority_sos_passes >= 0);
  end if;
end $$;

comment on column public.profiles.care_credits is
  'Non-monetary Care Credits balance for Instant Pickup reward loop.';
comment on column public.profiles.completed_rides_provided is
  'Count of Instant Pickup rides provided (helps unlock Helper tiers / SOS passes).';
comment on column public.profiles.priority_sos_passes is
  'Priority SOS passes earned every 3 rides provided; usable when Care Credits are 0.';

-- Welcome balance for existing verified school parents (idempotent via ledger below).
update public.profiles as profile
set care_credits = greatest(coalesce(profile.care_credits, 0), 2)
where exists (
  select 1
  from public.school_memberships membership
  where membership.user_id = profile.id
    and membership.status = 'verified'
)
and coalesce(profile.care_credits, 0) < 2;

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------
create table if not exists public.care_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null check (delta <> 0),
  reason text not null
    check (reason in (
      'welcome',
      'ride_provided',
      'ride_received',
      'referral',
      'sos_pass_earned',
      'sos_pass_spent'
    )),
  reference_id text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint care_credit_ledger_user_reason_ref_key unique (user_id, reason, reference_id)
);

create index if not exists care_credit_ledger_user_created_idx
  on public.care_credit_ledger (user_id, created_at desc);

alter table public.care_credit_ledger enable row level security;

drop policy if exists care_credit_ledger_select_own on public.care_credit_ledger;
create policy care_credit_ledger_select_own on public.care_credit_ledger
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

revoke all on table public.care_credit_ledger from public, anon, authenticated;
grant select on table public.care_credit_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.care_helper_tier(p_rides integer)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when coalesce(p_rides, 0) >= 12 then 'gold'
    when coalesce(p_rides, 0) >= 5 then 'silver'
    else 'community'
  end;
$$;

create or replace function public.care_wallet_json(p_profile public.profiles)
returns jsonb
language sql
stable
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'careCredits', p_profile.care_credits,
    'completedRidesProvided', p_profile.completed_rides_provided,
    'prioritySosPasses', p_profile.priority_sos_passes,
    'helperTier', public.care_helper_tier(p_profile.completed_rides_provided),
    'ridesToNextTier', case
      when p_profile.completed_rides_provided >= 12 then 0
      when p_profile.completed_rides_provided >= 5 then greatest(0, 12 - p_profile.completed_rides_provided)
      else greatest(0, 5 - p_profile.completed_rides_provided)
    end,
    'ridesToNextSosPass', case
      when p_profile.completed_rides_provided = 0 then 3
      when (p_profile.completed_rides_provided % 3) = 0 then 3
      else 3 - (p_profile.completed_rides_provided % 3)
    end
  );
$$;

create or replace function public.apply_care_credit_delta(
  p_user_id uuid,
  p_delta integer,
  p_reason text,
  p_reference_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  inserted boolean := false;
begin
  if p_user_id is null or p_delta = 0 or nullif(trim(p_reference_id), '') is null then
    return false;
  end if;

  begin
    insert into public.care_credit_ledger (user_id, delta, reason, reference_id)
    values (p_user_id, p_delta, p_reason, trim(p_reference_id));
    inserted := true;
  exception
    when unique_violation then
      return false;
  end;

  if p_reason = 'sos_pass_earned' then
    update public.profiles
    set priority_sos_passes = priority_sos_passes + greatest(p_delta, 0),
        updated_at = pg_catalog.now()
    where id = p_user_id;
  elsif p_reason = 'sos_pass_spent' then
    update public.profiles
    set priority_sos_passes = greatest(0, priority_sos_passes + p_delta),
        updated_at = pg_catalog.now()
    where id = p_user_id;
  else
    update public.profiles
    set care_credits = greatest(0, care_credits + p_delta),
        updated_at = pg_catalog.now()
    where id = p_user_id;
  end if;

  return inserted;
end;
$$;

revoke all on function public.apply_care_credit_delta(uuid, integer, text, text)
  from public, anon, authenticated;

create or replace function public.ensure_welcome_care_credits(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_user_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.school_memberships membership
    where membership.user_id = p_user_id
      and membership.status = 'verified'
  ) then
    return;
  end if;
  perform public.apply_care_credit_delta(p_user_id, 2, 'welcome', p_user_id::text);
end;
$$;

revoke all on function public.ensure_welcome_care_credits(uuid)
  from public, anon, authenticated;

-- Seed welcome ledger rows for verified parents (balances already floored above).
insert into public.care_credit_ledger (user_id, delta, reason, reference_id)
select profile.id, 2, 'welcome', profile.id::text
from public.profiles as profile
where exists (
  select 1 from public.school_memberships membership
  where membership.user_id = profile.id and membership.status = 'verified'
)
on conflict (user_id, reason, reference_id) do nothing;

create or replace function public.get_care_credit_wallet()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  profile public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.ensure_welcome_care_credits(auth.uid());
  select * into profile from public.profiles where id = auth.uid();
  if profile.id is null then
    raise exception 'profile unavailable' using errcode = 'P0002';
  end if;
  return public.care_wallet_json(profile);
end;
$$;

revoke all on function public.get_care_credit_wallet() from public, anon, authenticated;
grant execute on function public.get_care_credit_wallet() to authenticated;

create or replace function public.award_referral_care_credits(
  p_referrer_id uuid,
  p_invitee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_referrer_id is null or p_invitee_id is null or p_referrer_id = p_invitee_id then
    return jsonb_build_object('ok', false);
  end if;
  perform public.apply_care_credit_delta(
    p_referrer_id, 1, 'referral', 'invitee:' || p_invitee_id::text
  );
  perform public.apply_care_credit_delta(
    p_invitee_id, 1, 'referral', 'referrer:' || p_referrer_id::text
  );
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.award_referral_care_credits(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.award_referral_care_credits(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Settle credits when Instant Pickup final check-in confirms
-- ---------------------------------------------------------------------------
create or replace function public.settle_instant_pickup_care_credits(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  request public.instant_pickup_requests%rowtype;
  provider_id uuid;
  receiver_id uuid;
  receiver_profile public.profiles%rowtype;
  provider_before integer;
  provider_after public.profiles%rowtype;
  used_sos boolean := false;
  provider_delta_applied boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;

  if request.id is null
    or request.status is distinct from 'matched'
    or request.matched_user_id is null
    or auth.uid() not in (request.requester_id, request.matched_user_id) then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;

  -- Provider is the parent offering the ride; receiver needs the seat.
  if request.intent::text = 'can_help' then
    provider_id := request.requester_id;
    receiver_id := request.matched_user_id;
  else
    provider_id := request.matched_user_id;
    receiver_id := request.requester_id;
  end if;

  select * into receiver_profile from public.profiles where id = receiver_id for update;
  select completed_rides_provided into provider_before
  from public.profiles where id = provider_id for update;

  -- Receiver spends 1 Care Credit, or 1 Priority SOS Pass when credits are 0.
  if coalesce(receiver_profile.care_credits, 0) > 0 then
    perform public.apply_care_credit_delta(
      receiver_id, -1, 'ride_received', request.id::text
    );
  elsif coalesce(receiver_profile.priority_sos_passes, 0) > 0 then
    used_sos := public.apply_care_credit_delta(
      receiver_id, -1, 'sos_pass_spent', request.id::text
    );
  else
    -- Still settle provider reward; receiver ledger records a soft spend attempt only once.
    perform public.apply_care_credit_delta(
      receiver_id, -1, 'ride_received', request.id::text
    );
  end if;

  provider_delta_applied := public.apply_care_credit_delta(
    provider_id, 1, 'ride_provided', request.id::text
  );

  if provider_delta_applied then
    update public.profiles
    set completed_rides_provided = completed_rides_provided + 1,
        updated_at = pg_catalog.now()
    where id = provider_id
    returning * into provider_after;

    if provider_after.completed_rides_provided > 0
      and provider_after.completed_rides_provided % 3 = 0 then
      perform public.apply_care_credit_delta(
        provider_id, 1, 'sos_pass_earned', request.id::text || ':sos'
      );
    end if;
  else
    select * into provider_after from public.profiles where id = provider_id;
  end if;

  return jsonb_build_object(
    'requestId', request.id,
    'providerId', provider_id,
    'receiverId', receiver_id,
    'usedSosPass', used_sos,
    'providerWallet', public.care_wallet_json(provider_after),
    'receiverWallet', public.care_wallet_json((
      select profile from public.profiles as profile where profile.id = receiver_id
    )),
    'callerIsProvider', auth.uid() = provider_id,
    'earnedCareCredit', case when auth.uid() = provider_id and provider_delta_applied then 1 else 0 end
  );
end;
$$;

revoke all on function public.settle_instant_pickup_care_credits(uuid)
  from public, anon, authenticated;
grant execute on function public.settle_instant_pickup_care_credits(uuid) to authenticated;

-- Patch check_in_instant_pickup to settle after a successful confirm.
create or replace function public.check_in_instant_pickup(
  p_request_id uuid,
  p_confirm boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $fn$
declare
  request public.instant_pickup_requests%rowtype;
  payload jsonb;
  settlement jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.release_stale_instant_pickup_matches();

  select * into request
  from public.instant_pickup_requests
  where id = p_request_id
  for update;
  if request.id is null
    or not public.is_member(request.school_id)
    or auth.uid() not in (request.requester_id, request.matched_user_id) then
    raise exception 'instant pickup request unavailable' using errcode = '42501';
  end if;
  if request.status is distinct from 'matched' then
    return public.instant_pickup_request_json(request);
  end if;
  if request.final_check_at is null then
    raise exception 'final check-in is not scheduled' using errcode = '22023';
  end if;

  if coalesce(p_confirm, false) then
    if pg_catalog.now() < request.final_check_at then
      raise exception 'final check-in opens 30 minutes before pickup'
        using errcode = '22023';
    end if;
    if pg_catalog.now() >= (request.final_check_at + interval '30 minutes') then
      request := public.release_instant_pickup_match(request.id, auth.uid());
      return public.instant_pickup_request_json(request);
    end if;
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set check_in_status = 'confirmed'
    where row_request.id = request.id
    returning * into request;
    perform set_config('yourturn.instant_pickup_mutate', '', true);

    begin
      settlement := public.settle_instant_pickup_care_credits(request.id);
    exception
      when others then
        settlement := jsonb_build_object('error', 'care_credits_settle_skipped');
    end;

    payload := public.instant_pickup_request_json(request);
    return payload || jsonb_build_object('careCreditSettlement', settlement);
  end if;

  if pg_catalog.now() >= request.final_check_at then
    request := public.release_instant_pickup_match(request.id, auth.uid());
  else
    perform set_config('yourturn.instant_pickup_mutate', '1', true);
    update public.instant_pickup_requests as row_request
    set
      status = 'open',
      matched_user_id = null,
      check_in_status = null,
      final_check_at = null,
      chat_room_id = null
    where row_request.id = request.id
    returning * into request;
    perform set_config('yourturn.instant_pickup_mutate', '', true);
  end if;

  return public.instant_pickup_request_json(request);
end;
$fn$;

revoke all on function public.check_in_instant_pickup(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.check_in_instant_pickup(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
