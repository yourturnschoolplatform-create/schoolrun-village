-- Task 6.1: append-only trust score events, band projection, peer band-only exposure.
-- Numeric scores stay server-side except the caller's own get_my_trust(). Peers get bands only.
-- Trip/cancellation policy deltas are Task 6.2; this migration supplies the posting engine.
begin;
set local search_path = pg_catalog;

create table public.trust_score_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete restrict,
  subject_user_id uuid not null references public.profiles(id) on delete restrict,
  delta smallint not null check (delta <> 0 and delta between -100 and 100),
  score_after smallint not null check (score_after between -100 and 150),
  reason_code text not null check (
    reason_code in (
      'completed_trip', 'urgent_cover', 'cancel_under_24h', 'cancel_under_2h',
      'late_with_advance_notice', 'late_without_advance_notice',
      'confirmed_no_show', 'confirmed_no_show_with_backup',
      'confirmed_false_report', 'reviewed_safety_violation', 'manual_adjustment'
    )
  ),
  source_entity_type text not null check (char_length(source_entity_type) between 1 and 64),
  source_entity_id uuid not null,
  policy_version integer,
  created_at timestamptz not null default pg_catalog.now(),
  unique (source_entity_type, source_entity_id, reason_code)
);
create index trust_score_events_subject_idx
  on public.trust_score_events (subject_user_id, created_at desc);
create index trust_score_events_school_idx
  on public.trust_score_events (school_id, created_at desc);

comment on table public.trust_score_events is
  'Append-only trust score history. Peers never read this table; scores stay server-side.';
comment on column public.trust_score_events.delta is
  'Integer trip-trust delta only; never a monetary field.';

create function public.guard_trust_score_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'trust score history is append-only' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_trust_score_events() from public, anon, authenticated;
create trigger trust_score_events_guard_rows
  before insert or update or delete on public.trust_score_events
  for each row execute function public.guard_trust_score_events();
create trigger trust_score_events_guard_truncate
  before truncate on public.trust_score_events
  for each statement execute function public.guard_trust_score_events();
alter table public.trust_score_events enable always trigger trust_score_events_guard_rows;
alter table public.trust_score_events enable always trigger trust_score_events_guard_truncate;

alter table public.trust_score_events enable row level security;
create policy trust_score_events_select_own on public.trust_score_events
  for select to authenticated
  using (subject_user_id = auth.uid() or public.is_admin());
revoke all on table public.trust_score_events from public, anon, authenticated;
grant select on table public.trust_score_events to authenticated;

-- Band thresholds match the published policy defaults. admin_suspended forces Suspended.
create or replace function public.trust_band_for_score(score smallint)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when score is null then 'Suspended'
    when score >= 85 then 'Trusted'
    when score >= 60 then 'Standard'
    when score >= 40 then 'Caution'
    when score >= 20 then 'Restricted'
    else 'Suspended'
  end;
$$;
revoke all on function public.trust_band_for_score(smallint) from public, anon, authenticated;

create function public.trust_band_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select case
    when profile.admin_suspended then 'Suspended'
    else public.trust_band_for_score(profile.trust_score)
  end
  from public.profiles profile
  where profile.id = p_user_id;
$$;
revoke all on function public.trust_band_for_user(uuid) from public, anon, authenticated;

-- Internal posting engine for Task 6.1/6.2. Not browser-executable.
create function public.apply_trust_score_delta(
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
  -- least/greatest are not schema-qualifiable; clamp with CASE under pg_catalog path.
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
  return next_score;
end;
$$;
revoke all on function public.apply_trust_score_delta(uuid, uuid, smallint, text, text, uuid)
  from public, anon, authenticated;

create function public.get_my_trust()
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
  select source.* into profile from public.profiles source where source.id = auth.uid();
  if profile.id is null then
    raise exception 'profile required' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'trust_score', profile.trust_score,
    'trust_band', case
      when profile.admin_suspended then 'Suspended'
      else public.trust_band_for_score(profile.trust_score)
    end,
    'admin_suspended', profile.admin_suspended
  );
end;
$$;
revoke all on function public.get_my_trust() from public, anon, authenticated;
grant execute on function public.get_my_trust() to authenticated;

-- Same-school verified peers receive a band only. Score never appears in the payload.
create function public.get_peer_trust_band(p_peer_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  shared_school uuid;
  band text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_peer_user_id is null or p_peer_user_id = auth.uid() then
    raise exception 'peer trust band requires another school member' using errcode = '22023';
  end if;
  select membership.school_id into shared_school
  from public.school_memberships membership
  where membership.user_id = auth.uid()
    and membership.status = 'verified'
    and public.is_member(membership.school_id)
    and exists (
      select 1 from public.school_memberships peer
      where peer.school_id = membership.school_id
        and peer.user_id = p_peer_user_id
        and peer.status = 'verified'
        and public.is_member(peer.school_id)
    )
  order by membership.created_at, membership.id
  limit 1;
  if shared_school is null then
    raise exception 'verified same-school peer required' using errcode = '42501';
  end if;
  band := public.trust_band_for_user(p_peer_user_id);
  if band is null then
    raise exception 'peer profile unavailable' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('trust_band', band);
end;
$$;
revoke all on function public.get_peer_trust_band(uuid) from public, anon, authenticated;
grant execute on function public.get_peer_trust_band(uuid) to authenticated;

commit;
